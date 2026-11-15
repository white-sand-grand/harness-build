import test from 'node:test';
import assert from 'node:assert/strict';
import { createSession, openSession } from '../../src/session/index.ts';
import { startRun } from '../../src/app/run.ts';
import { durableJournal } from '../../src/app/background/journal.ts';
import { defaultConfig } from '../../src/app/config.ts';
import { zeroUsage } from '../../src/ai/index.ts';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { readOwner, reconcileOwnership } from '../../src/util/ownership.ts';
import { workspaceOwnerFile } from '../../src/app/background/ownership.ts';
import { withTmpDir } from '../helpers/tmp.ts';
import { scripted } from '../helpers/fake-provider.ts';

test('durable completed runs return their saved outcome without another model call', async () =>
  withTmpDir(async (d) => {
    const durable = { runId: 'run-1', eventIds: ['source:1'] };
    const base = { cwd: d, home: d, config: defaultConfig(), prompt: 'inspect', durable };
    const first = await startRun({ ...base, provider: scripted({ text: 'verified' }) });
    const session = openSession(d, d, first.session.id);
    const result = await startRun({ ...base, session, provider: scripted() });
    assert.equal(result.finalText, 'verified');
    assert.deepEqual(result.usage, first.usage);
    assert.equal(session.entries().filter((e) => e.type === 'message' && e.origin?.runId === durable.runId).length, 1);
    await assert.rejects(startRun({ ...base, prompt: 'different', session, provider: scripted() }), /metadata changed/);
  }));

test('durable inputs are not appended again after an interrupted run', async () =>
  withTmpDir(async (d) => {
    const session = createSession(d, d),
      durable = { runId: 'interrupted', eventIds: ['source:2'] };
    durableJournal(session, durable, 'inspect');
    session.append({
      type: 'message',
      origin: durable,
      message: { role: 'user', content: [{ type: 'text', text: 'inspect' }] },
    });
    session.flush();
    const result = await startRun({
      cwd: d,
      home: d,
      session: openSession(d, d, session.id),
      config: defaultConfig(),
      prompt: 'inspect',
      durable,
      provider: scripted((request) => {
        assert.equal(request.messages.filter((m) => m.role === 'user').length, 1);
        return { text: 'resumed' };
      }),
    });
    assert.equal(result.reason, 'done');
  }));

test('a possible unrecorded write blocks durable replay until reconciled', async () =>
  withTmpDir(async (d) => {
    const session = createSession(d, d),
      durable = { runId: 'uncertain', eventIds: ['source:3'] };
    const journal = durableJournal(session, durable, 'write');
    journal.event({ type: 'toolStart', call: { type: 'toolCall', id: 'write-1', name: 'write', args: {} } }, []);
    await assert.rejects(
      startRun({ cwd: d, home: d, session, config: defaultConfig(), prompt: 'write', durable, provider: scripted() }),
      /needs_reconciliation/,
    );
    assert.equal(session.entries().filter((e) => e.type === 'trace' && e.name === 'agentEnd').length, 0);
  }));

test('tool result persistence failure never creates a replayable completion after a real write', async () =>
  withTmpDir(async (d) => {
    const session = createSession(d, d),
      durable = { runId: 'write-error', eventIds: ['source:failure'] };
    const append = session.append.bind(session);
    let fail = true;
    session.append = (entry) => {
      if (fail && entry.type === 'message' && entry.message.role === 'toolResult') {
        fail = false;
        throw new Error('injected result persistence failure');
      }
      return append(entry);
    };
    await assert.rejects(
      startRun({
        cwd: d,
        home: d,
        session,
        config: defaultConfig(),
        prompt: 'write',
        durable,
        provider: scripted({ toolCalls: [{ name: 'write', args: { path: 'result.txt', content: 'saved' } }] }),
      }),
      /persistence failure/,
    );
    assert.equal(await readFile(join(d, 'result.txt'), 'utf8'), 'saved');
    await assert.rejects(
      startRun({ cwd: d, home: d, session, config: defaultConfig(), prompt: 'write', durable, provider: scripted() }),
      /needs_reconciliation/,
    );
    const pending = session.entries().findLast((e) => e.type === 'trace' && e.name === 'runLifecycle')!;
    assert.equal(pending.type === 'trace' && pending.data.phase, 'needsReconciliation');
  }));

for (const stage of ['input', 'tool', 'completion'] as const) {
  test(`durable run survives process exit at ${stage} without losing input or replaying uncertain writes`, async () =>
    withTmpDir(async (d) => {
      const session = createSession(d, d);
      const child = fork('test/helpers/durable-child.ts', [d, session.id, stage], {
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      });
      let error = '';
      child.stderr!.on('data', (part) => (error += String(part)));
      const timeout = setTimeout(() => child.kill('SIGKILL'), 10000);
      timeout.unref();
      const [code] = await once(child, 'exit');
      clearTimeout(timeout);
      assert.equal(code, 97, error);
      for (const file of [join(session.dir, '.writer.lock'), workspaceOwnerFile(d, d)])
        reconcileOwnership(file, readOwner(file).owner, true);
      const restored = openSession(d, d, session.id),
        durable = { runId: 'crash-run', eventIds: ['crash:event'] };
      const provider = stage === 'input' ? scripted({ text: 'recovered' }) : scripted();
      const retry = startRun({
        cwd: d,
        home: d,
        session: restored,
        config: defaultConfig(),
        prompt: 'inspect',
        durable,
        provider,
      });
      if (stage === 'tool') {
        await assert.rejects(retry, /needs_reconciliation/);
        assert.equal(await readFile(join(d, 'result.txt'), 'utf8'), 'one write');
      } else assert.equal((await retry).finalText, stage === 'input' ? 'recovered' : 'completed');
      assert.equal(
        restored.entries().filter((e) => e.type === 'message' && e.origin?.runId === durable.runId).length,
        1,
      );
      if (stage !== 'input') assert.equal(provider.requests.length, 0);
    }));
}

test('settled tool results permit recovery and malformed completion records fail closed', async () =>
  withTmpDir(async (d) => {
    const session = createSession(d, d),
      durable = { runId: 'settled', eventIds: ['source:4'] };
    const journal = durableJournal(session, durable, 'inspect');
    journal.event({ type: 'toolStart', call: { type: 'toolCall', id: 'w', name: 'write', args: {} } }, []);
    journal.event(
      {
        type: 'message',
        message: { role: 'toolResult', toolCallId: 'w', toolName: 'write', content: [], isError: false },
      },
      [],
    );
    const result = await startRun({
      cwd: d,
      home: d,
      session,
      config: defaultConfig(),
      prompt: 'inspect',
      durable,
      provider: scripted({ text: 'done' }),
    });
    assert.equal(result.reason, 'done');
    const entry = session.entries().findLast((e) => e.type === 'trace' && e.name === 'runLifecycle')!;
    assert.equal(entry.type, 'trace');
    if (entry.type === 'trace')
      session.append({ type: 'trace', name: 'runLifecycle', data: { ...entry.data, result: { usage: zeroUsage() } } });
    assert.throws(() => durableJournal(session, durable, 'inspect'), /Invalid durable run completion/);
  }));
