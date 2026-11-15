import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFile, readFile, cp, appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { BackgroundStore } from '../../src/app/background/store.ts';
import { BackgroundWorker, recoverBackgroundRun, recoverSupervisor } from '../../src/app/background/worker.ts';
import { BackgroundApprovals } from '../../src/app/background/approvals.ts';
import { BackgroundOutbox } from '../../src/app/background/outbox.ts';
import { defaultConfig } from '../../src/app/config.ts';
import { startRun } from '../../src/app/run.ts';
import { compactSession } from '../../src/app/compact.ts';
import { openSession } from '../../src/session/index.ts';
import { zeroUsage } from '../../src/ai/index.ts';
import { withTmpDir } from '../helpers/tmp.ts';
import { scripted } from '../helpers/fake-provider.ts';

const mutation = { toolCalls: [{ name: 'write', args: { path: 'a.txt', content: 'changed' } }] };
async function pending(directory: string, now: () => number = Date.now) {
  const home = join(directory, 'home'),
    store = new BackgroundStore(home, now);
  await writeFile(join(directory, 'a.txt'), 'original');
  const task = store.createTask({ cwd: directory, goal: 'Update a.txt', editablePaths: ['a.txt'] });
  store.enqueue({ taskId: task.id, source: 'local', sourceEventId: 'start', payload: {} });
  const worker = new BackgroundWorker({ store, config: defaultConfig(), provider: scripted(mutation) });
  try {
    assert.equal((await worker.runOnce())?.state, 'suspended');
  } finally {
    worker.close();
  }
  return { home, store, task, approval: new BackgroundApprovals(store).list()[0]! };
}

test('background approval persists across restart and executes an exact mutation once', async () =>
  withTmpDir(async (d) => {
    const first = await pending(d);
    assert.equal(await readFile(join(d, 'a.txt'), 'utf8'), 'original');
    first.store.close();
    const store = new BackgroundStore(first.home),
      approvals = new BackgroundApprovals(store);
    approvals.respond(first.approval.id, 'allow');
    assert.throws(() => approvals.respond(first.approval.id, 'allow'), /already answered/);
    const provider = scripted((request) => {
      assert.ok(
        request.messages.some(
          (message) => message.role === 'toolResult' && message.toolName === 'write' && !message.isError,
        ),
      );
      return { text: 'updated' };
    });
    const worker = new BackgroundWorker({ store, config: defaultConfig(), provider });
    try {
      assert.equal((await worker.runOnce())?.state, 'completed');
      assert.equal(await readFile(join(d, 'a.txt'), 'utf8'), 'changed');
      assert.equal(provider.requests.length, 1);
      assert.equal(approvals.get(first.approval.id).state, 'consumed');
      assert.equal(store.run(first.approval.runId).state, 'resolved');
      assert.deepEqual(
        new BackgroundOutbox(store).outcomes().map((item) => item.decision),
        ['needsApproval', 'send'],
      );
      store.enqueue({ taskId: first.task.id, source: 'local', sourceEventId: 'followup', payload: {} });
    } finally {
      worker.close();
    }
    const followup = new BackgroundWorker({
      store,
      config: defaultConfig(),
      provider: scripted({ text: 'later event' }),
    });
    try {
      assert.equal((await followup.runOnce())?.state, 'completed');
    } finally {
      followup.close();
      store.close();
    }
  }));

test('denied mutations are not executed or repeatedly proposed with new call IDs', async () =>
  withTmpDir(async (d) => {
    const { store, approval } = await pending(d);
    const approvals = new BackgroundApprovals(store);
    approvals.respond(approval.id, 'deny');
    const provider = scripted(mutation, (request) => {
      assert.ok(
        request.messages.filter((message) => message.role === 'toolResult').every((message) => message.isError),
      );
      return { text: 'denied' };
    });
    const worker = new BackgroundWorker({ store, config: defaultConfig(), provider });
    try {
      await worker.runOnce();
      assert.equal(await readFile(join(d, 'a.txt'), 'utf8'), 'original');
      assert.equal(approvals.list().length, 1);
    } finally {
      worker.close();
      store.close();
    }
  }));

test('file changes after review invalidate the old approval without overwriting manual edits', async () =>
  withTmpDir(async (d) => {
    const { store, approval } = await pending(d);
    await writeFile(join(d, 'a.txt'), 'manual edit');
    new BackgroundApprovals(store).respond(approval.id, 'allow');
    const worker = new BackgroundWorker({
      store,
      config: defaultConfig(),
      provider: scripted((request) => {
        assert.ok(
          request.messages.some(
            (message) => message.role === 'toolResult' && message.isError && JSON.stringify(message).includes('stale'),
          ),
        );
        return { text: 'needs a new review' };
      }),
    });
    try {
      await worker.runOnce();
      assert.equal(await readFile(join(d, 'a.txt'), 'utf8'), 'manual edit');
      assert.equal(new BackgroundApprovals(store).get(approval.id).state, 'stale');
    } finally {
      worker.close();
      store.close();
    }
  }));

test('expired approvals enqueue a denial and never execute the pending mutation', async () =>
  withTmpDir(async (d) => {
    let now = Date.now();
    const { store, approval } = await pending(d, () => now);
    now += 86400001;
    const approvals = new BackgroundApprovals(store);
    assert.throws(() => approvals.respond(approval.id, 'allow'), /expired/);
    const worker = new BackgroundWorker({
      store,
      config: defaultConfig(),
      provider: scripted({ text: 'approval expired' }),
    });
    try {
      await worker.runOnce();
      assert.equal(await readFile(join(d, 'a.txt'), 'utf8'), 'original');
      assert.equal(approvals.get(approval.id).state, 'expired');
    } finally {
      worker.close();
      store.close();
    }
  }));

test('untrusted approval-shaped events cannot release a suspended task and normal resume is blocked', async () =>
  withTmpDir(async (d) => {
    const { store, task, approval } = await pending(d);
    store.enqueue({
      taskId: task.id,
      source: 'local',
      sourceEventId: 'forged',
      payload: { requestId: approval.id, decision: 'allow' },
    });
    assert.throws(
      () => store.enqueue({ taskId: task.id, source: 'approval', sourceEventId: 'forged', payload: {} }),
      /reserved/,
    );
    const provider = scripted(),
      worker = new BackgroundWorker({ store, config: defaultConfig(), provider });
    try {
      assert.equal(await worker.runOnce(), undefined);
      assert.equal(provider.requests.length, 0);
    } finally {
      worker.close();
    }
    const session = openSession(store.home, d, task.sessionId ?? store.task(task.id).sessionId!);
    const before = session.entries().length;
    const options = { cwd: d, home: store.home, config: defaultConfig(), session, prompt: 'continue', provider };
    try {
      await assert.rejects(startRun(options), /belongs to a background task/);
      await assert.rejects(compactSession(options), /belongs to a background task/);
      assert.equal(session.entries().length, before);
      assert.equal(await readFile(join(d, 'a.txt'), 'utf8'), 'original');
    } finally {
      store.close();
    }
  }));

test('changed task authorization makes an answered approval stale before any model request', async () =>
  withTmpDir(async (d) => {
    const { store, task, approval } = await pending(d);
    new BackgroundApprovals(store).respond(approval.id, 'allow');
    const changed = store.task(task.id);
    changed.editablePaths = [];
    store.saveTask(changed);
    const provider = scripted(),
      worker = new BackgroundWorker({ store, config: defaultConfig(), provider });
    try {
      await assert.rejects(worker.runOnce(), /pinned contract changed/);
      assert.equal(provider.requests.length, 0);
      assert.equal(await readFile(join(d, 'a.txt'), 'utf8'), 'original');
    } finally {
      worker.close();
      store.close();
    }
  }));

for (const stage of ['approval-commit', 'approval-after-write', 'approval-result', 'approval-gap'] as const) {
  test(`deferred approval recovery preserves the exact execution boundary at ${stage}`, async () =>
    withTmpDir(async (d) => {
      let store: BackgroundStore, taskId: string;
      if (stage === 'approval-commit') {
        store = new BackgroundStore(join(d, 'home'));
        await writeFile(join(d, 'a.txt'), 'original');
        const task = store.createTask({ cwd: d, goal: 'Update', editablePaths: ['a.txt'] });
        taskId = task.id;
        store.enqueue({ taskId, source: 'local', sourceEventId: 'start', payload: {} });
      } else {
        const first = await pending(d);
        store = first.store;
        taskId = first.task.id;
        new BackgroundApprovals(store).respond(first.approval.id, 'allow');
      }
      const child = fork('test/helpers/background-child.ts', [store.home, taskId, stage], {
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      });
      let error = '';
      child.stderr!.on('data', (part) => (error += String(part)));
      const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
      timer.unref();
      const [code] = await once(child, 'exit');
      clearTimeout(timer);
      assert.equal(code, 97, error);
      if (stage === 'approval-commit') {
        recoverSupervisor(store, true);
        const item = new BackgroundApprovals(store).list()[0]!;
        assert.equal(item.state, 'pending');
        new BackgroundApprovals(store).respond(item.id, 'allow');
      } else recoverBackgroundRun(store, store.runs().at(-1)!.id, true);
      const provider =
        stage === 'approval-commit' || stage === 'approval-result' ? scripted({ text: 'resumed' }) : scripted();
      const worker = new BackgroundWorker({ store, config: defaultConfig(), provider });
      try {
        if (stage === 'approval-after-write') await assert.rejects(worker.runOnce(), /needs_reconciliation/);
        else assert.equal((await worker.runOnce())?.state, 'completed');
        assert.equal(await readFile(join(d, 'a.txt'), 'utf8'), 'changed');
        if (stage !== 'approval-commit' && stage !== 'approval-result') assert.equal(provider.requests.length, 0);
      } finally {
        worker.close();
        store.close();
      }
    }));
}

test('real A/B/C file tools resume after approval without repeating the earlier read', async () =>
  withTmpDir(async (d) => {
    const store = new BackgroundStore(join(d, 'home'));
    await writeFile(join(d, 'a.txt'), 'original');
    const task = store.createTask({ cwd: d, goal: 'Update a.txt', editablePaths: ['a.txt'] });
    store.enqueue({ taskId: task.id, source: 'local', sourceEventId: 'start', payload: {} });
    const first = new BackgroundWorker({
      store,
      config: defaultConfig(),
      provider: scripted({
        toolCalls: [
          { name: 'read', args: { path: 'a.txt' } },
          { name: 'write', args: { path: 'a.txt', content: 'changed' } },
          { name: 'read', args: { path: 'a.txt' } },
        ],
      }),
    });
    try {
      assert.equal((await first.runOnce())?.state, 'suspended');
    } finally {
      first.close();
    }
    const approvals = new BackgroundApprovals(store);
    approvals.respond(approvals.list()[0]!.id, 'allow');
    const provider = scripted((request) => {
      const results = request.messages.filter((message) => message.role === 'toolResult');
      assert.equal(results.length, 3);
      assert.match(JSON.stringify(results[0]), /original/);
      assert.match(JSON.stringify(results[2]), /changed/);
      return { text: 'done' };
    });
    const resumed = new BackgroundWorker({ store, config: defaultConfig(), provider });
    try {
      await resumed.runOnce();
      const session = openSession(store.home, d, store.task(task.id).sessionId!);
      assert.equal(
        session
          .entries()
          .filter((entry) => entry.type === 'trace' && entry.name === 'tool' && entry.data.name === 'read').length,
        2,
      );
      assert.equal(
        session
          .entries()
          .filter((entry) => entry.type === 'trace' && entry.name === 'tool' && entry.data.name === 'write').length,
        1,
      );
    } finally {
      resumed.close();
      store.close();
    }
  }));

test('an interrupted terminal callback cannot erase an already committed approval checkpoint', async () =>
  withTmpDir(async (d) => {
    const store = new BackgroundStore(join(d, 'home'));
    await writeFile(join(d, 'a.txt'), 'original');
    const task = store.createTask({ cwd: d, goal: 'Update', editablePaths: ['a.txt'] });
    store.enqueue({ taskId: task.id, source: 'local', sourceEventId: 'start', payload: {} });
    const defer = BackgroundApprovals.prototype.defer;
    BackgroundApprovals.prototype.defer = function (...args) {
      defer.apply(this, args);
      throw new Error('after checkpoint commit');
    };
    const worker = new BackgroundWorker({ store, config: defaultConfig(), provider: scripted(mutation) });
    try {
      assert.equal((await worker.runOnce())?.state, 'suspended');
      assert.equal(new BackgroundApprovals(store).list()[0]!.state, 'pending');
      assert.equal(store.task(task.id).state, 'waitingApproval');
    } finally {
      BackgroundApprovals.prototype.defer = defer;
      worker.close();
      store.close();
    }
  }));

test('cancelling a waiting task invalidates its approval without executing a mutation', async () =>
  withTmpDir(async (d) => {
    const { store, task, approval } = await pending(d);
    store.cancelTask(task.id);
    try {
      assert.throws(() => new BackgroundApprovals(store).respond(approval.id, 'allow'), /already answered/);
      assert.equal(await readFile(join(d, 'a.txt'), 'utf8'), 'original');
      assert.equal(new BackgroundApprovals(store).get(approval.id).state, 'cancelled');
    } finally {
      store.close();
    }
  }));

test('an actual changed actor artifact invalidates the prior approval contract', async () =>
  withTmpDir(async (d) => {
    const { store, task, approval, home } = await pending(d);
    const actor = join(d, 'actor');
    await cp('src', join(actor, 'src'), { recursive: true });
    await cp('prompts', join(actor, 'prompts'), { recursive: true });
    await writeFile(join(actor, 'package.json'), '{"type":"module"}');
    const module = (await import(
      pathToFileURL(join(actor, 'src/app/background/contract.ts')).href
    )) as typeof import('../../src/app/background/contract.ts');
    const config = {
      ...defaultConfig(),
      runtime: undefined,
      permissions: { mode: 'ask' as const, extraRiskyPatterns: [] },
      hooks: { afterEdit: [], onStop: [], maxStopContinuations: 0 },
    };
    assert.equal(module.backgroundContract(config, d, home), approval.contractHash);
    await appendFile(join(actor, 'src/tools/write.ts'), '\n// independently changed actor artifact\n');
    assert.equal(
      module.backgroundContract(config, d, home),
      approval.contractHash,
      'Loaded implementation is pinned until the next generation.',
    );
    const nextActor = join(d, 'next-actor');
    await cp(actor, nextActor, { recursive: true });
    const nextModule = (await import(
      pathToFileURL(join(nextActor, 'src/app/background/contract.ts')).href
    )) as typeof import('../../src/app/background/contract.ts');
    const changed = nextModule.backgroundContract(config, d, home);
    assert.notEqual(changed, approval.contractHash);
    const approvals = new BackgroundApprovals(store);
    approvals.respond(approval.id, 'allow');
    const session = openSession(home, d, store.task(task.id).sessionId!);
    const claim = store.claim(() => ({ sessionId: session.id, contractHash: changed }))!;
    try {
      assert.throws(() => approvals.beginResume(claim, session), /pinned contract changed/);
      assert.equal(await readFile(join(d, 'a.txt'), 'utf8'), 'original');
      assert.equal(approvals.get(approval.id).state, 'stale');
    } finally {
      store.close();
    }
  }));

test('cancellation arriving with a proposed write never creates an approval or changes a file', async () =>
  withTmpDir(async (d) => {
    const store = new BackgroundStore(join(d, 'home'));
    await writeFile(join(d, 'a.txt'), 'original');
    const task = store.createTask({ cwd: d, goal: 'Update', editablePaths: ['a.txt'] });
    store.enqueue({ taskId: task.id, source: 'local', sourceEventId: 'start', payload: {} });
    const provider = scripted(() => {
      store.cancelTask(task.id);
      return mutation;
    });
    const worker = new BackgroundWorker({ store, config: defaultConfig(), provider });
    try {
      await worker.runOnce();
      assert.equal(store.task(task.id).state, 'cancelled');
      assert.equal(new BackgroundApprovals(store).list().length, 0);
      assert.equal(provider.requests.length, 1);
      assert.equal(await readFile(join(d, 'a.txt'), 'utf8'), 'original');
    } finally {
      worker.close();
      store.close();
    }
  }));

test('real compaction cannot erase approval consumption or block later task events', async () =>
  withTmpDir(async (d) => {
    const store = new BackgroundStore(join(d, 'home'));
    await writeFile(join(d, 'a.txt'), 'original');
    await writeFile(
      join(d, 'large.txt'),
      Array.from({ length: 200 }, (_, index) => `Evidence ${index} ${'detail '.repeat(30)}`).join('\n'),
    );
    const task = store.createTask({ cwd: d, goal: 'Update then inspect', editablePaths: ['a.txt'] });
    store.enqueue({ taskId: task.id, source: 'local', sourceEventId: 'start', payload: {} });
    const config = defaultConfig();
    config.models[config.model] = { contextWindow: 2048 };
    config.compaction.keepRecentTokens = 1000;
    const provider = scripted(
      mutation,
      { toolCalls: [{ name: 'read', args: { path: 'large.txt' } }] },
      { text: 'Goal: update and inspect. The file was updated; continue from the recorded evidence.' },
      { text: 'done' },
      { text: 'Updated file and inspected evidence; continue with the new follow-up.' },
      { text: 'followup complete' },
    );
    const worker = new BackgroundWorker({ store, config, provider }),
      approvals = new BackgroundApprovals(store);
    try {
      assert.equal((await worker.runOnce())?.state, 'suspended');
      const request = approvals.list()[0]!;
      approvals.respond(request.id, 'allow');
      assert.equal((await worker.runOnce())?.state, 'completed');
      const session = openSession(store.home, d, store.task(task.id).sessionId!);
      assert.ok(session.entries().some((entry) => entry.type === 'compaction'));
      assert.ok(
        session
          .entries()
          .some(
            (entry) =>
              entry.type === 'message' && entry.message.role === 'toolResult' && entry.message.toolName === 'write',
          ),
      );
      assert.ok(
        !session.context().messages.some((message) => message.role === 'toolResult' && message.toolName === 'write'),
      );
      assert.equal(approvals.get(request.id).state, 'consumed');
      assert.equal(store.run(request.runId).state, 'resolved');
      assert.equal(await readFile(join(d, 'a.txt'), 'utf8'), 'changed');
      store.enqueue({ taskId: task.id, source: 'local', sourceEventId: 'later', payload: {} });
      assert.equal((await worker.runOnce())?.state, 'completed');
    } finally {
      worker.close();
      store.close();
    }
  }));

test('a later read with a reused tool ID is not evidence that the approved write completed', async () =>
  withTmpDir(async (d) => {
    const { store, task, approval, home } = await pending(d),
      approvals = new BackgroundApprovals(store);
    approvals.respond(approval.id, 'allow');
    const session = openSession(home, d, store.task(task.id).sessionId!);
    const claim = store.claim(() => ({ sessionId: session.id, contractHash: approval.contractHash }))!;
    approvals.beginResume(claim, session);
    const id = approval.batch.calls[approval.batch.nextCallIndex]!.id;
    session.append({
      type: 'message',
      message: {
        role: 'assistant',
        content: [{ type: 'toolCall', id, name: 'read', args: { path: 'a.txt' } }],
        stopReason: 'toolUse',
        usage: zeroUsage(),
        model: 'test',
        provider: 'anthropic',
      },
    });
    session.append({
      type: 'message',
      message: {
        role: 'toolResult',
        toolCallId: id,
        toolName: 'read',
        content: [{ type: 'text', text: 'original' }],
        isError: false,
      },
    });
    session.flush();
    try {
      approvals.consume(claim, session);
      assert.equal(approvals.get(approval.id).state, 'answered');
      assert.equal(store.run(approval.runId).state, 'suspended');
      assert.equal(await readFile(join(d, 'a.txt'), 'utf8'), 'original');
    } finally {
      store.close();
    }
  }));
