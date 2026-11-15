import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { readFile, mkdir, symlink, rm } from 'node:fs/promises';
import { createSession, openSession } from '../../src/session/index.ts';
import { acquireWorkspace, workspaceOwnerFile } from '../../src/app/background/ownership.ts';
import { readOwner, reconcileOwnership } from '../../src/util/ownership.ts';
import { startRun } from '../../src/app/run.ts';
import { defaultConfig } from '../../src/app/config.ts';
import { withTmpDir } from '../helpers/tmp.ts';
import { scripted } from '../helpers/fake-provider.ts';

test('separate session handles append unique entries and active writers block reopening', async () =>
  withTmpDir(async (d) => {
    const first = createSession(d, d),
      second = openSession(d, d, first.id);
    assert.equal(first.append({ type: 'message', message: { role: 'user', content: [] } }), 'e1');
    assert.equal(second.append({ type: 'message', message: { role: 'user', content: [] } }), 'e2');
    const release = first.acquireWriter();
    try {
      assert.equal(first.entries().length, 3);
      assert.throws(() => openSession(d, d, first.id), /ownership/);
      assert.throws(() => second.append({ type: 'trace', name: 'hook', data: {} }), /ownership/);
    } finally {
      release();
    }
    assert.equal(second.append({ type: 'trace', name: 'hook', data: {} }), 'e3');
  }));

test('workspace ownership rejects competing runs and releases after provider errors', async () =>
  withTmpDir(async (d) => {
    const owner = acquireWorkspace(d, d);
    try {
      await assert.rejects(
        startRun({ cwd: d, home: d, config: defaultConfig(), prompt: 'busy', provider: scripted() }),
        /ownership/,
      );
      assert.throws(() => reconcileOwnership(owner.file, owner.owner, true), /still alive/);
    } finally {
      owner.release();
    }
    await assert.rejects(
      startRun({ cwd: d, home: d, config: defaultConfig(), prompt: 'error', provider: scripted() }),
      /no more steps/,
    );
    const result = await startRun({
      cwd: d,
      home: d,
      config: defaultConfig(),
      prompt: 'ok',
      provider: scripted({ text: 'ok' }),
    });
    assert.equal(result.reason, 'done');
  }));

test('workspace ownership treats real paths, directory aliases and Windows casing as the same workspace', async () =>
  withTmpDir(async (d) => {
    const workspace = join(d, 'Workspace'),
      alias = join(d, 'alias'),
      home = join(d, 'home');
    await mkdir(workspace);
    await symlink(workspace, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const owner = acquireWorkspace(home, workspace);
    try {
      assert.throws(() => acquireWorkspace(home, alias), /ownership/);
      if (process.platform === 'win32')
        assert.throws(() => acquireWorkspace(home, workspace.toUpperCase()), /ownership/);
    } finally {
      owner.release();
      await rm(alias);
    }
  }));

test('killed writer leaves durable messages and requires explicit ownership reconciliation', async () =>
  withTmpDir(async (d) => {
    const session = createSession(d, d);
    const child = fork('test/helpers/ownership-child.ts', [d, d, session.id], {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    let error = '';
    child.stderr!.on('data', (part) => (error += String(part)));
    try {
      await Promise.race([
        once(child, 'message'),
        once(child, 'exit').then(() => {
          throw new Error('Writer exited before ready: ' + error);
        }),
        new Promise((_, reject) => {
          const timer = setTimeout(() => reject(new Error('Writer readiness timeout: ' + error)), 10000);
          timer.unref();
        }),
      ]);
      assert.throws(() => openSession(d, d, session.id), /ownership/);
      const closed = once(child, 'exit');
      child.kill('SIGKILL');
      await closed;
      assert.throws(() => acquireWorkspace(d, d), /reconciliation/);
      for (const file of [join(session.dir, '.writer.lock'), workspaceOwnerFile(d, d)])
        reconcileOwnership(file, readOwner(file).owner, true);
      const reopened = openSession(d, d, session.id);
      assert.equal(reopened.context().messages[0]?.content[0]?.type, 'text');
      assert.match(await readFile(join(session.dir, 'session.jsonl'), 'utf8'), /durable child/);
      const owner = acquireWorkspace(d, d);
      owner.release();
    } finally {
      child.kill('SIGKILL');
    }
  }));
