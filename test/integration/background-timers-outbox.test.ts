import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { createSession } from '../../src/session/index.ts';
import { zeroUsage } from '../../src/ai/index.ts';
import { BackgroundStore } from '../../src/app/background/store.ts';
import { BackgroundWorker, recoverBackgroundRun } from '../../src/app/background/worker.ts';
import { BackgroundTimers } from '../../src/app/background/timers.ts';
import { BackgroundOutbox } from '../../src/app/background/outbox.ts';
import { defaultConfig } from '../../src/app/config.ts';
import { withTmpDir } from '../helpers/tmp.ts';
import { scripted } from '../helpers/fake-provider.ts';

test('durable timers coalesce missed intervals and remain anchored after reopening', async () =>
  withTmpDir(async (d) => {
    let now = 1794700000000;
    const start = now,
      home = join(d, 'home');
    let store = new BackgroundStore(home, () => now);
    const task = store.createTask({ cwd: d, goal: 'follow up' });
    const timer = new BackgroundTimers(store).create({ taskId: task.id, atUtc: now + 1000, everyMs: 3600000 });
    store.close();
    now += 86400000;
    store = new BackgroundStore(home, () => now);
    try {
      const timers = new BackgroundTimers(store);
      assert.equal(timers.tick(), 1);
      assert.equal(timers.tick(), 0);
      const event = store.events()[0]!,
        payload = event.payload as { missedCount: number; scheduledAtUtc: number };
      assert.equal(payload.missedCount, 23);
      assert.equal(payload.scheduledAtUtc, start + 1000 + 23 * 3600000);
      assert.equal(timers.list()[0]!.dueAtUtc, start + 1000 + 24 * 3600000);
      assert.equal(timers.list()[0]!.id, timer.id);
    } finally {
      store.close();
    }
  }));

test('timer generation cancellation filters stale events before batching with valid ones', async () =>
  withTmpDir(async (d) => {
    const store = new BackgroundStore(join(d, 'home')),
      task = store.createTask({ cwd: d, goal: 'follow up' });
    const timers = new BackgroundTimers(store),
      valid = timers.create({ taskId: task.id, atUtc: store.now() }),
      stale = timers.create({ taskId: task.id, atUtc: store.now() });
    timers.tick();
    timers.cancel(stale.id);
    const provider = scripted((request) => {
      const user = request.messages.find((message) => message.role === 'user')!,
        text = user.content[0]!;
      if (text.type !== 'text') throw new Error('Expected event text.');
      const events = JSON.parse(text.text).events;
      assert.equal(events.length, 1);
      assert.equal(events[0].payload.timerId, valid.id);
      return { text: 'followed up' };
    });
    const worker = new BackgroundWorker({ store, config: defaultConfig(), provider });
    try {
      await worker.runOnce();
      assert.equal(store.events().filter((event) => event.status === 'dead_letter').length, 1);
    } finally {
      worker.close();
      store.close();
    }
  }));

test('timer enqueue and due-time advance roll back together when the database update fails', async () =>
  withTmpDir(async (d) => {
    const store = new BackgroundStore(join(d, 'home')),
      task = store.createTask({ cwd: d, goal: 'atomic timer' });
    const timers = new BackgroundTimers(store),
      timer = timers.create({ taskId: task.id, atUtc: store.now() });
    try {
      store.db.exec(
        "CREATE TRIGGER fail_timer BEFORE UPDATE ON timers BEGIN SELECT RAISE(ABORT,'injected timer failure'); END;",
      );
      assert.throws(() => timers.tick(), /injected timer failure/);
      assert.equal(store.events().length, 0);
      assert.equal(timers.list()[0]!.state, 'active');
      store.db.exec('DROP TRIGGER fail_timer');
      assert.equal(timers.tick(), 1);
      assert.equal(timers.tick(), 0);
      assert.equal((store.events()[0]!.payload as { timerId: string }).timerId, timer.id);
    } finally {
      store.close();
    }
  }));

test('outbox stays quiet for unchanged observations and sends changes including a return to prior state', async () =>
  withTmpDir(async (d) => {
    const store = new BackgroundStore(join(d, 'home')),
      task = store.createTask({ cwd: d, goal: 'inspect evidence' });
    const file = join(d, 'evidence.txt');
    await writeFile(file, 'first');
    const read = { toolCalls: [{ name: 'read', args: { path: 'evidence.txt' } }] };
    const provider = scripted(
      read,
      { text: 'first summary' },
      read,
      { text: 'different wording, same facts' },
      read,
      { text: 'changed' },
      read,
      { text: 'restored' },
    );
    const worker = new BackgroundWorker({ store, config: defaultConfig(), provider }),
      outbox = new BackgroundOutbox(store);
    try {
      for (let i = 0; i < 4; i++) {
        if (i === 2) await writeFile(file, 'second');
        if (i === 3) await writeFile(file, 'first');
        store.enqueue({ taskId: task.id, source: 'local', sourceEventId: 'event-' + i, payload: {} });
        await worker.runOnce();
      }
      assert.deepEqual(
        outbox.outcomes().map((row) => row.decision),
        ['send', 'quiet', 'send', 'send'],
      );
      assert.equal(outbox.messages().length, 3);
      assert.ok(outbox.messages().every((message) => message.state === 'delivered' && message.seenAt === undefined));
      assert.equal(outbox.dispatch(), 0);
      outbox.markSeen(outbox.messages()[0]!.id);
      assert.ok(outbox.messages()[0]!.seenAt);
      assert.equal(store.db.prepare('SELECT count(*) AS n FROM deliveries').get()!.n, 3);
      assert.ok(outbox.outcomes().every((outcome) => outcome.verification === 'notRun'));
    } finally {
      worker.close();
      store.close();
    }
  }));

test('new CI failures notify despite unchanged reads while later timer metadata stays quiet', async () =>
  withTmpDir(async (d) => {
    const store = new BackgroundStore(join(d, 'home')),
      task = store.createTask({ cwd: d, goal: 'Follow CI status' });
    await writeFile(join(d, 'README.md'), 'unchanged reference');
    const read = { toolCalls: [{ name: 'read', args: { path: 'README.md' } }] };
    const provider = scripted(
      read,
      { text: 'CI passed' },
      read,
      { text: 'CI now failed and needs attention' },
      read,
      { text: 'Still the same failure' },
      read,
      { text: 'CI passed again' },
    );
    const worker = new BackgroundWorker({ store, config: defaultConfig(), provider }),
      outbox = new BackgroundOutbox(store);
    try {
      store.enqueue({ taskId: task.id, source: 'ci', sourceEventId: 'pass', payload: { status: 'pass' } });
      await worker.runOnce();
      store.enqueue({ taskId: task.id, source: 'ci', sourceEventId: 'fail', payload: { status: 'fail' } });
      await worker.runOnce();
      new BackgroundTimers(store).create({ taskId: task.id, atUtc: store.now() });
      await worker.runOnce();
      store.enqueue({ taskId: task.id, source: 'ci', sourceEventId: 'pass-again', payload: { status: 'pass' } });
      await worker.runOnce();
      assert.deepEqual(
        outbox.outcomes().map((row) => row.decision),
        ['send', 'send', 'quiet', 'send'],
      );
      assert.equal(outbox.outcomes()[1]!.sourceHash, outbox.outcomes()[2]!.sourceHash);
      assert.deepEqual(outbox.outcomes()[1]!.sourceEventIds, outbox.outcomes()[2]!.sourceEventIds);
      assert.equal(outbox.messages().length, 3);
      assert.match(outbox.messages()[1]!.body, /failed/);
      const failureEvent = store.events().find((event) => event.sourceEventId === 'fail')!;
      assert.deepEqual(outbox.outcomes()[1]!.sourceEventIds, [failureEvent.id]);
    } finally {
      worker.close();
      store.close();
    }
  }));

test('delivery failure leaves a completed run intact and retries delivery without calling the model', async () =>
  withTmpDir(async (d) => {
    let now = Date.now();
    const store = new BackgroundStore(join(d, 'home'), () => now),
      task = store.createTask({ cwd: d, goal: 'inspect' });
    store.enqueue({ taskId: task.id, source: 'local', sourceEventId: 'one', payload: {} });
    store.db.exec(
      "CREATE TRIGGER fail_delivery BEFORE UPDATE ON outbox WHEN json_extract(NEW.data,'$.state')='delivered' BEGIN SELECT RAISE(ABORT,'injected delivery failure'); END;",
    );
    const worker = new BackgroundWorker({ store, config: defaultConfig(), provider: scripted({ text: 'ready' }) });
    try {
      assert.equal((await worker.runOnce())?.state, 'completed');
    } finally {
      worker.close();
    }
    const outbox = new BackgroundOutbox(store);
    assert.equal(store.runs()[0]!.state, 'completed');
    assert.equal(store.events()[0]!.status, 'handled');
    assert.equal(outbox.messages()[0]!.state, 'retry_wait');
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM deliveries').get()!.n, 0);
    store.db.exec('DROP TRIGGER fail_delivery');
    now += 1000;
    const provider = scripted(),
      restarted = new BackgroundWorker({ store, config: defaultConfig(), provider });
    try {
      assert.equal(await restarted.runOnce(), undefined);
      assert.equal(provider.requests.length, 0);
      assert.equal(outbox.messages()[0]!.state, 'delivered');
    } finally {
      restarted.close();
      store.close();
    }
  }));

test('result, inbox completion and outbox commit atomically and recover from the saved transcript', async () =>
  withTmpDir(async (d) => {
    const store = new BackgroundStore(join(d, 'home')),
      task = store.createTask({ cwd: d, goal: 'inspect' });
    store.enqueue({ taskId: task.id, source: 'local', sourceEventId: 'one', payload: {} });
    store.db.exec(
      "CREATE TRIGGER fail_outcome BEFORE INSERT ON outcomes BEGIN SELECT RAISE(ABORT,'injected outcome failure'); END;",
    );
    const worker = new BackgroundWorker({ store, config: defaultConfig(), provider: scripted({ text: 'saved' }) });
    try {
      await assert.rejects(worker.runOnce(), /injected outcome failure/);
    } finally {
      worker.close();
    }
    const outbox = new BackgroundOutbox(store);
    assert.equal(outbox.messages().length, 0);
    assert.equal(outbox.outcomes().length, 0);
    assert.equal(store.events()[0]!.status, 'claimed');
    store.db.exec('DROP TRIGGER fail_outcome');
    recoverBackgroundRun(store, store.runs()[0]!.id, true);
    const provider = scripted(),
      restarted = new BackgroundWorker({ store, config: defaultConfig(), provider });
    try {
      await restarted.runOnce();
      assert.equal(provider.requests.length, 0);
      assert.equal(outbox.messages().length, 1);
      assert.equal(store.events()[0]!.status, 'handled');
    } finally {
      restarted.close();
      store.close();
    }
  }));

test('task cancellation stops timers and external callers cannot forge timer events', async () =>
  withTmpDir(async (d) => {
    const store = new BackgroundStore(join(d, 'home')),
      task = store.createTask({ cwd: d, goal: 'follow up' });
    const timers = new BackgroundTimers(store);
    timers.create({ taskId: task.id, atUtc: store.now() + 10000, everyMs: 1000 });
    try {
      assert.throws(
        () => store.enqueue({ taskId: task.id, source: 'timer', sourceEventId: 'fake', payload: {} }),
        /reserved/,
      );
      store.cancelTask(task.id);
      assert.equal(timers.list()[0]!.state, 'cancelled');
      assert.equal(timers.tick(), 0);
    } finally {
      store.close();
    }
  }));

test('delivery retries have durable backoff and stop after three failures', async () =>
  withTmpDir(async (d) => {
    let now = Date.now();
    const store = new BackgroundStore(join(d, 'home'), () => now),
      task = store.createTask({ cwd: d, goal: 'inspect' });
    store.enqueue({ taskId: task.id, source: 'local', sourceEventId: 'ready', payload: {} });
    store.db.exec(
      "CREATE TRIGGER fail_delivery BEFORE UPDATE ON outbox WHEN json_extract(NEW.data,'$.state')='delivered' BEGIN SELECT RAISE(ABORT,'delivery unavailable'); END;",
    );
    const provider = scripted({ text: 'ready' }),
      worker = new BackgroundWorker({ store, config: defaultConfig(), provider }),
      outbox = new BackgroundOutbox(store);
    try {
      await worker.runOnce();
      assert.equal(outbox.messages()[0]!.attempts, 1);
      await worker.runOnce();
      assert.equal(outbox.messages()[0]!.attempts, 1);
      now += 1000;
      await worker.runOnce();
      assert.equal(outbox.messages()[0]!.attempts, 2);
      now += 2000;
      await worker.runOnce();
      assert.equal(outbox.messages()[0]!.state, 'failed');
      now += 100000;
      await worker.runOnce();
      assert.equal(outbox.messages()[0]!.attempts, 3);
      assert.equal(provider.requests.length, 1);
    } finally {
      worker.close();
      store.close();
    }
  }));

for (const stage of ['timer-tx', 'delivery-tx', 'dispatch'] as const) {
  test(`SQLite atomicity and local delivery idempotency survive ${stage} processes`, async () =>
    withTmpDir(async (d) => {
      const home = join(d, 'home'),
        store = new BackgroundStore(home),
        task = store.createTask({ cwd: d, goal: 'inspect' });
      const timers = new BackgroundTimers(store),
        outbox = new BackgroundOutbox(store);
      if (stage === 'timer-tx') timers.create({ taskId: task.id, atUtc: store.now() });
      else {
        store.enqueue({ taskId: task.id, source: 'local', sourceEventId: 'ready', payload: {} });
        const claim = store.claim(() => ({ sessionId: createSession(home, d).id, contractHash: 'local-test' }))!;
        store.finish(claim.run.id, { reason: 'done', finalText: 'ready', usage: zeroUsage(), turns: 0 }, 'ready');
        outbox.enqueue(claim.run.id, task.id, 'result', 'ready', 'one');
      }
      const invoke = async () => {
        const child = fork('test/helpers/background-child.ts', [home, task.id, stage], {
          stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        });
        let error = '';
        child.stderr!.on('data', (part) => (error += String(part)));
        const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
        timer.unref();
        const [code] = await once(child, 'exit');
        clearTimeout(timer);
        assert.equal(code, stage === 'dispatch' ? 0 : 97, error);
      };
      try {
        if (stage === 'dispatch') await Promise.all([invoke(), invoke()]);
        else await invoke();
        if (stage === 'timer-tx') {
          assert.equal(store.events().length, 0);
          assert.equal(timers.tick(), 1);
          assert.equal(timers.tick(), 0);
        } else {
          if (stage === 'delivery-tx') {
            assert.equal(outbox.messages()[0]!.state, 'pending');
            assert.equal(store.db.prepare('SELECT count(*) AS n FROM deliveries').get()!.n, 0);
          }
          outbox.dispatch();
          assert.equal(store.db.prepare('SELECT count(*) AS n FROM deliveries').get()!.n, 1);
          assert.equal(outbox.messages()[0]!.state, 'delivered');
        }
      } finally {
        store.close();
      }
    }));
}
