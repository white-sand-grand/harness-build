import { BackgroundStore } from '../../src/app/background/store.ts';
import { BackgroundWorker } from '../../src/app/background/worker.ts';
import { defaultConfig } from '../../src/app/config.ts';
import { scripted } from './fake-provider.ts';

const [home, taskId, stage] = process.argv.slice(2) as [string, string, string];
const store = new BackgroundStore(home);
if (stage === 'timer-tx') {
  const { BackgroundTimers } = await import('../../src/app/background/timers.ts');
  const insert = store.insertEvent.bind(store);
  store.insertEvent = (event) => {
    insert(event);
    process.exit(97);
  };
  new BackgroundTimers(store).tick();
}
if (stage === 'delivery-tx' || stage === 'dispatch') {
  const { BackgroundOutbox } = await import('../../src/app/background/outbox.ts');
  if (stage === 'delivery-tx') {
    const transaction = store.transaction.bind(store);
    store.transaction = (work) =>
      transaction(() => {
        work();
        process.exit(97);
      });
  }
  new BackgroundOutbox(store).dispatch();
  process.exit(0);
}
if (stage === 'transaction') {
  store.db.exec('BEGIN IMMEDIATE');
  store.insertEvent({
    taskId,
    source: 'local',
    sourceEventId: 'uncommitted',
    payload: '{}',
    kind: 'message',
    availableAt: Date.now(),
  });
  process.exit(97);
}
if (stage === 'commit-gap') store.finish = () => process.exit(97);
if (stage === 'approval-gap') store.finish = () => process.exit(97);
if (stage === 'job-gap') store.finish = () => process.exit(97);
if (stage === 'approval-commit') {
  const { BackgroundApprovals } = await import('../../src/app/background/approvals.ts');
  const defer = BackgroundApprovals.prototype.defer;
  BackgroundApprovals.prototype.defer = function (...args) {
    defer.apply(this, args);
    process.exit(97);
  };
}
const provider = scripted(() => {
  if (stage === 'claim') process.exit(97);
  if (stage === 'approval-commit')
    return { toolCalls: [{ name: 'write', args: { path: 'a.txt', content: 'changed' } }] };
  return { text: 'completed before DB commit' };
});
const worker = new BackgroundWorker({
  store,
  config: defaultConfig(),
  provider,
  handlers: {
    dream: async (context) => {
      const { writeFileSync } = await import('node:fs');
      const { join } = await import('node:path');
      const file = join(context.outputDir, 'proof.txt');
      writeFileSync(file, 'one maintenance side effect');
      if (stage === 'job-mid') process.exit(97);
      return {
        result: {
          reason: 'done',
          finalText: 'maintenance done',
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          turns: 0,
        },
        verification: 'notRun',
        artifacts: [file],
        evidence: { proof: 'once' },
      };
    },
  },
  onEvent(event) {
    if (
      stage === 'approval-result' &&
      event.type === 'message' &&
      event.message.role === 'toolResult' &&
      event.message.toolName === 'write'
    )
      process.exit(97);
    if (stage === 'approval-after-write' && event.type === 'toolEnd' && event.call.name === 'write') process.exit(97);
  },
});
if (stage === 'idle') process.exit(97);
if (stage === 'prepare') {
  const { createSession } = await import('../../src/session/index.ts');
  const { acquireWorkspace } = await import('../../src/app/background/ownership.ts');
  store.claim((task) => {
    acquireWorkspace(home, task.cwd);
    const session = createSession(home, task.cwd);
    session.acquireWriter();
    process.exit(97);
  });
}
await worker.runOnce();
throw new Error('Requested background crash boundary was not reached.');
