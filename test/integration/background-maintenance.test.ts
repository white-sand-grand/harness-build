import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdir, writeFile, readFile, cp, chmod, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync, fork } from 'node:child_process';
import { once } from 'node:events';
import { BackgroundStore } from '../../src/app/background/store.ts';
import { BackgroundWorker, recoverBackgroundRun } from '../../src/app/background/worker.ts';
import { BackgroundApprovals } from '../../src/app/background/approvals.ts';
import { BackgroundOutbox } from '../../src/app/background/outbox.ts';
import { dreamJob, type BackgroundJobHandler } from '../../src/app/background/jobs.ts';
import { defaultLimits } from '../../src/app/background/types.ts';
import { defaultConfig } from '../../src/app/config.ts';
import { defaultPromptsDir } from '../../src/app/prompts.ts';
import { createSession, listSessions } from '../../src/session/index.ts';
import { memoryDir } from '../../src/memory/memory-dir.ts';
import { projectSlug } from '../../src/util/paths.ts';
import { ensureRepo, commitAll } from '../../src/memory/git.ts';
import { evolutionJob } from '../../src/cli/background-jobs.ts';
import { runEval, readResults } from '../../src/eval/runner.ts';
import type { ModelRequest } from '../../src/ai/index.ts';
import { withTmpDir } from '../helpers/tmp.ts';
import { scripted, type StepData } from '../helpers/fake-provider.ts';

test('new background runs recall fresh notes, task progress and only delivered summaries', async () =>
  withTmpDir(async (d) => {
    const home = join(d, 'home'),
      notes = memoryDir(home, d);
    await mkdir(notes, { recursive: true });
    await writeFile(join(notes, 'MEMORY.md'), 'First note index');
    await writeFile(join(notes, 'note.md'), 'first fact');
    const store = new BackgroundStore(home),
      task = store.createTask({ cwd: d, goal: 'Read project notes' });
    const provider = scripted(
      (request) => {
        assert.match(request.system, /First note index/);
        return { toolCalls: [{ name: 'read', args: { path: join(notes, 'note.md') } }] };
      },
      { text: 'First delivered summary' },
      (request) => {
        assert.match(request.system, /Second note index/);
        assert.match(request.system, /First delivered summary/);
        assert.match(request.system, /Current user rule/);
        assert.ok(request.systemCacheBoundary! < request.system.indexOf('Background continuity data'));
        return { toolCalls: [{ name: 'read', args: { path: join(notes, 'note.md') } }] };
      },
      { text: 'Second delivered summary' },
    );
    const worker = new BackgroundWorker({ store, config: defaultConfig(), provider });
    try {
      store.enqueue({ taskId: task.id, source: 'local', sourceEventId: 'first', payload: {} });
      await worker.runOnce();
      await writeFile(join(notes, 'MEMORY.md'), 'Second note index');
      await writeFile(join(notes, 'note.md'), 'second fact');
      await writeFile(join(d, 'AGENTS.md'), 'Current user rule');
      store.enqueue({ taskId: task.id, source: 'local', sourceEventId: 'second', payload: {} });
      await worker.runOnce();
      assert.ok(store.runs().every((run) => !!run.contextRevision));
      assert.equal(listSessions(home, d)[0]!.firstUserText, task.goal);
    } finally {
      worker.close();
      store.close();
    }
  }));

test('note updates are recalled on approval resume while the exact file grant remains bound', async () =>
  withTmpDir(async (d) => {
    const home = join(d, 'home'),
      store = new BackgroundStore(home);
    await writeFile(join(d, 'a.txt'), 'original');
    const task = store.createTask({ cwd: d, goal: 'Update a.txt', editablePaths: ['a.txt'] });
    store.enqueue({ taskId: task.id, source: 'local', sourceEventId: 'start', payload: {} });
    const provider = scripted(
      { toolCalls: [{ name: 'write', args: { path: 'a.txt', content: 'changed' } }] },
      (request) => {
        assert.match(request.system, /New continuity note/);
        return { text: 'done' };
      },
    );
    const worker = new BackgroundWorker({ store, config: defaultConfig(), provider });
    try {
      await worker.runOnce();
      const notes = memoryDir(home, d);
      await mkdir(notes, { recursive: true });
      await writeFile(join(notes, 'MEMORY.md'), 'New continuity note');
      const approvals = new BackgroundApprovals(store);
      approvals.respond(approvals.list()[0]!.id, 'allow');
      await worker.runOnce();
      assert.equal(await readFile(join(d, 'a.txt'), 'utf8'), 'changed');
      assert.equal(approvals.list()[0]!.state, 'consumed');
    } finally {
      worker.close();
      store.close();
    }
  }));

test('ordinary work precedes dream jobs and curation excludes unfinished sessions', async () =>
  withTmpDir(async (d) => {
    const home = join(d, 'home'),
      store = new BackgroundStore(home),
      unfinished = createSession(home, d);
    unfinished.append({
      type: 'message',
      message: { role: 'user', content: [{ type: 'text', text: 'not finished' }] },
    });
    const dream = store.createTask({ cwd: d, goal: 'Curate completed facts', kind: 'dream' }),
      inspect = store.createTask({ cwd: d, goal: 'Inspect first' });
    for (const task of [dream, inspect])
      store.enqueue({ taskId: task.id, source: 'local', sourceEventId: task.id, payload: {} });
    const provider = scripted(
      { text: 'verified completed fact' },
      (request) => {
        const text = JSON.stringify(request.messages);
        assert.ok(!text.includes(unfinished.id));
        assert.deepEqual(
          request.tools.map((tool) => tool.name),
          ['read', 'write', 'edit'],
        );
        return {
          toolCalls: [
            { name: 'write', args: { path: 'MEMORY.md', content: '- Verified fact from the completed session.' } },
          ],
        };
      },
      { text: 'Curated completed evidence.' },
    );
    const worker = new BackgroundWorker({ store, config: defaultConfig(), provider, handlers: { dream: dreamJob } });
    try {
      assert.equal((await worker.runOnce())?.taskId, inspect.id);
      const result = await worker.runOnce();
      assert.equal(result?.taskId, dream.id);
      assert.equal(result?.state, 'completed');
      assert.match(await readFile(join(memoryDir(home, d), 'MEMORY.md'), 'utf8'), /Verified fact/);
      assert.equal(store.counter('task:' + dream.id).calls, 2);
      assert.equal(result?.verification, 'notRun');
    } finally {
      worker.close();
      store.close();
    }
  }));

test('memory snapshots never execute hooks stored in the memory repository', async () =>
  withTmpDir(async (d) => {
    ensureRepo(d);
    const marker = join(d, 'hook-ran'),
      hook = join(d, '.git', 'hooks', 'pre-commit');
    await writeFile(hook, `#!/bin/sh\nprintf hooked > "${marker.replaceAll('\\', '/')}"\n`);
    await chmod(hook, 0o755);
    execFileSync(
      'git',
      [
        '-C',
        d,
        '-c',
        'user.name=Hook control',
        '-c',
        'user.email=hook@example.invalid',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'core.hooksPath=' + join(d, '.git', 'hooks'),
        'commit',
        '--allow-empty',
        '-m',
        'control',
      ],
      { windowsHide: true, stdio: 'ignore' },
    );
    assert.equal(existsSync(marker), true);
    await unlink(marker);
    await writeFile(join(d, 'note.md'), 'fact');
    assert.ok(commitAll(d, 'safe snapshot'));
    assert.equal(existsSync(marker), false);
  }));

for (const stage of ['job-gap', 'job-mid'] as const) {
  test(`maintenance process recovery handles ${stage} without repeating side effects`, async () =>
    withTmpDir(async (d) => {
      const store = new BackgroundStore(join(d, 'home')),
        task = store.createTask({ cwd: d, goal: 'maintenance', kind: 'dream' });
      store.enqueue({ taskId: task.id, source: 'local', sourceEventId: 'start', payload: {} });
      const child = fork('test/helpers/background-child.ts', [store.home, task.id, stage], {
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      });
      let error = '';
      child.stderr!.on('data', (part) => (error += String(part)));
      const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
      timer.unref();
      const [code] = await once(child, 'exit');
      clearTimeout(timer);
      assert.equal(code, 97, error);
      recoverBackgroundRun(store, store.runs()[0]!.id, true);
      const handler: BackgroundJobHandler = async () => {
        throw new Error('Maintenance must not be replayed.');
      };
      const worker = new BackgroundWorker({
        store,
        config: defaultConfig(),
        provider: scripted(),
        handlers: { dream: handler },
      });
      try {
        if (stage === 'job-gap') assert.equal((await worker.runOnce())?.state, 'completed');
        else await assert.rejects(worker.runOnce(), /needs_reconciliation/);
      } finally {
        worker.close();
        store.close();
      }
    }));
}

async function tasks(directory: string) {
  for (const [id, split, expected] of [
    ['repair', 'dev', 'ready'],
    ['audit', 'heldout', 'checked'],
  ] as const) {
    const root = join(directory, id);
    await mkdir(join(root, 'files'), { recursive: true });
    await writeFile(join(root, 'files', 'answer.txt'), 'broken');
    await writeFile(
      join(root, 'files', 'check.cjs'),
      `process.exit(require('node:fs').readFileSync('answer.txt','utf8')===${JSON.stringify(expected)}?0:1);`,
    );
    await writeFile(
      join(root, 'task.json'),
      JSON.stringify({
        id,
        split,
        prompt: `Set answer.txt to ${expected}.`,
        check: { command: 'node check.cjs' },
        protectedFiles: ['check.cjs'],
        maxTurns: 4,
      }),
    );
  }
}

test('untrusted heldout relabeling cannot trigger an evolution model call', async () =>
  withTmpDir(async (d) => {
    const tasksDir = join(d, 'tasks'),
      evidence = join(d, 'evidence');
    await tasks(tasksDir);
    await mkdir(evidence);
    await writeFile(
      join(evidence, 'run.json'),
      JSON.stringify({
        v: 1,
        tasks: [
          { id: 'repair', split: 'dev' },
          { id: 'audit', split: 'dev' },
        ],
        provenance: { contractHash: 'untrusted' },
      }),
    );
    await writeFile(
      join(evidence, 'results.jsonl'),
      [1, 2]
        .map((attempt) => JSON.stringify({ taskId: 'audit', attempt, status: 'fail', endReason: 'done' }))
        .join('\n'),
    );
    const store = new BackgroundStore(join(d, 'home')),
      task = store.createTask({ cwd: d, goal: 'Evaluate reliable dev evidence', kind: 'evolution' });
    store.enqueue({ taskId: task.id, source: 'local', sourceEventId: 'start', payload: { evidenceRun: evidence } });
    const provider = scripted(),
      worker = new BackgroundWorker({
        store,
        config: defaultConfig(),
        provider,
        handlers: { evolution: evolutionJob(tasksDir) },
      });
    try {
      const result = await worker.runOnce();
      assert.equal(result?.state, 'completed');
      assert.equal(provider.requests.length, 0);
      assert.equal(result?.verification, 'notRun');
    } finally {
      worker.close();
      store.close();
    }
  }));

test('scheduled evolution runs real paired evaluation and audit, reports a candidate, and never adopts it', async () =>
  withTmpDir(async (d) => {
    const tasksDir = join(d, 'tasks'),
      promptsDir = join(d, 'prompts'),
      evidence = join(d, 'evidence');
    await tasks(tasksDir);
    await cp(defaultPromptsDir, promptsDir, { recursive: true });
    await writeFile(join(promptsDir, 'system.md'), 'ACK_ONLY: only acknowledge the task, do not act.');
    const config = defaultConfig();
    config.model = 'offline-evolution';
    config.promptsDir = promptsDir;
    await runEval({
      tasksDir,
      runDir: evidence,
      config,
      split: 'all',
      repeat: 2,
      providerFactory: () => scripted({ text: 'ACK' }),
    });
    const store = new BackgroundStore(join(d, 'home')),
      task = store.createTask({
        cwd: d,
        goal: 'Propose an evidenced candidate',
        kind: 'evolution',
        limits: { ...defaultLimits, maxRunCalls: 80, maxRunTokens: 100000, maxDurationSec: 120 },
      });
    const respond = (request: ModelRequest): StepData => {
      if (request.tools.length === 3 && request.system.includes('recorded development-task evidence')) {
        if (request.messages.some((message) => message.role === 'toolResult'))
          return { text: 'One candidate prepared.' };
        return {
          toolCalls: [
            {
              name: 'write',
              args: {
                path: 'proposal.json',
                content: JSON.stringify({
                  hypothesis: 'Acknowledgement-only instructions prevent action.',
                  targetFile: 'system.md',
                  category: 'prompt',
                  evidenceRefs: ['repair#1:check', 'repair#2:check'],
                  expectedImprovement: 'Carry out requested changes.',
                  regressionRisk: 'More model calls.',
                }),
              },
            },
            {
              name: 'write',
              args: {
                path: 'analysis.md',
                content: 'Two reliable dev attempts finished without performing the requested change.',
              },
            },
            {
              name: 'write',
              args: {
                path: 'prompts/system.md',
                content:
                  'Read relevant files, perform the requested change, and report actual verification evidence before finishing.',
              },
            },
          ],
        };
      }
      if (request.system.includes('ACK_ONLY')) return { text: 'ACK' };
      if (request.messages.some((message) => message.role === 'toolResult' && message.toolName === 'write'))
        return { text: 'Changed the requested file.' };
      return {
        toolCalls: [
          {
            name: 'write',
            args: {
              path: 'answer.txt',
              content: JSON.stringify(request.messages).includes('checked') ? 'checked' : 'ready',
            },
          },
        ],
      };
    };
    const provider = scripted(...Array.from({ length: 80 }, () => respond));
    const worker = new BackgroundWorker({ store, config, provider, handlers: { evolution: evolutionJob(tasksDir) } });
    try {
      store.enqueue({ taskId: task.id, source: 'local', sourceEventId: 'first', payload: { evidenceRun: evidence } });
      const result = await worker.runOnce();
      assert.equal(result?.state, 'completed', JSON.stringify(result));
      assert.equal(result?.verification, 'passed');
      assert.match(result?.result?.finalText ?? '', /recommend/);
      assert.ok(result?.job?.artifacts.some((file) => file.endsWith('prompt-artifact.json')));
      assert.match(await readFile(join(promptsDir, 'system.md'), 'utf8'), /ACK_ONLY/);
      const calls = provider.requests.length;
      assert.ok(calls > 5);
      const rows = readResults(evidence);
      for (const row of rows) if (row.taskId === 'audit') row.status = 'pass';
      await writeFile(join(evidence, 'results.jsonl'), rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
      store.enqueue({
        taskId: task.id,
        source: 'local',
        sourceEventId: 'heldout-only-change',
        payload: { evidenceRun: evidence },
      });
      await worker.runOnce();
      assert.equal(provider.requests.length, calls);
      assert.equal(new BackgroundOutbox(store).outcomes().at(-1)!.decision, 'quiet');
    } finally {
      worker.close();
      store.close();
    }
  }));

for (const corrupt of [false, true]) {
  test(`recovered runs preserve their context snapshot and reject corruption=${corrupt}`, async () =>
    withTmpDir(async (d) => {
      const home = join(d, 'home'),
        store = new BackgroundStore(home),
        task = store.createTask({ cwd: d, goal: 'Inspect continuity' });
      store.enqueue({ taskId: task.id, source: 'local', sourceEventId: 'start', payload: {} });
      const child = fork('test/helpers/background-child.ts', [home, task.id, 'claim'], {
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      });
      let error = '';
      child.stderr!.on('data', (part) => (error += String(part)));
      const timeout = setTimeout(() => child.kill('SIGKILL'), 10000);
      timeout.unref();
      const [code] = await once(child, 'exit');
      clearTimeout(timeout);
      assert.equal(code, 97, error);
      const run = store.runs()[0]!;
      const notes = memoryDir(home, d);
      await mkdir(notes, { recursive: true });
      await writeFile(join(notes, 'MEMORY.md'), 'New note after interruption');
      if (corrupt)
        await writeFile(
          join(home, 'projects', projectSlug(d), 'sessions', run.sessionId, 'background-context', run.id + '.json'),
          '{"v":1,"runId":"wrong","taskId":"wrong"}',
        );
      recoverBackgroundRun(store, run.id, true);
      const provider = corrupt
        ? scripted()
        : scripted(
            (request) => {
              assert.ok(!request.system.includes('New note after interruption'));
              return { text: 'resumed original run' };
            },
            (request) => {
              assert.match(request.system, /New note after interruption/);
              return { text: 'new run context' };
            },
          );
      const worker = new BackgroundWorker({ store, config: defaultConfig(), provider });
      try {
        if (corrupt) {
          await assert.rejects(worker.runOnce(), /background context/);
          assert.equal(provider.requests.length, 0);
        } else {
          assert.equal((await worker.runOnce())?.state, 'completed');
          store.enqueue({ taskId: task.id, source: 'local', sourceEventId: 'next', payload: {} });
          assert.equal((await worker.runOnce())?.state, 'completed');
        }
      } finally {
        worker.close();
        store.close();
      }
    }));
}
