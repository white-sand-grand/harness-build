import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import type { parseCLI } from './args.ts';
import type { Config } from '../app/config.ts';
import { BackgroundStore } from '../app/background/store.ts';
import { BackgroundWorker, recoverBackgroundRun, recoverSupervisor } from '../app/background/worker.ts';
import { defaultLimits } from '../app/background/types.ts';
import { BackgroundTimers } from '../app/background/timers.ts';
import { BackgroundOutbox } from '../app/background/outbox.ts';
import { BackgroundApprovals } from '../app/background/approvals.ts';
import { dreamJob } from '../app/background/jobs.ts';
import { evolutionJob } from './background-jobs.ts';
import { fileURLToPath } from 'node:url';
import type { BackgroundTask } from '../app/background/types.ts';

export async function handleBackgroundCommand(
  args: ReturnType<typeof parseCLI>,
  options: { home: string; cwd: string; config: Config },
): Promise<number> {
  const [, action, id, ...rest] = args.positionals,
    values = args.values;
  const store = new BackgroundStore(options.home);
  try {
    let output: unknown;
    if (action === 'create') {
      output = store.createTask({
        cwd: options.cwd,
        goal: [id, ...rest].filter(Boolean).join(' '),
        timezone: values.timezone,
        editablePaths: values['edit-path'],
        kind: values.kind as BackgroundTask['kind'] | undefined,
        limits: {
          ...defaultLimits,
          ...(values['max-calls'] ? { maxRunCalls: Number(values['max-calls']) } : {}),
          ...(values['max-tokens'] ? { maxRunTokens: Number(values['max-tokens']) } : {}),
          ...(values.timeout ? { maxDurationSec: Number(values.timeout) } : {}),
        },
      });
    } else if (action === 'enqueue' && id && values.input) {
      const bytes = readFileSync(resolve(values.input));
      if (bytes.length > 64000) throw new Error('Event input exceeds 64KB.');
      output = store.enqueue({
        taskId: id,
        source: values.source ?? 'local',
        sourceEventId: values['event-id'] ?? id + '-' + createHash('sha256').update(bytes).digest('hex'),
        payload: JSON.parse(bytes.toString('utf8')),
      });
    } else if (action === 'approvals') {
      const approvals = new BackgroundApprovals(store);
      approvals.expire();
      output = approvals.list();
    } else if ((action === 'approve' || action === 'deny') && id) {
      output = new BackgroundApprovals(store).respond(id, action === 'approve' ? 'allow' : 'deny');
    } else if (action === 'timer' && id && values.at) {
      if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(values.at)) throw new Error('--at must contain an explicit UTC offset.');
      output = new BackgroundTimers(store).create({
        taskId: id,
        atUtc: Date.parse(values.at),
        everyMs: values['every-ms'] ? Number(values['every-ms']) : undefined,
        timezone: values.timezone,
      });
    } else if (action === 'cancel-timer' && id) {
      new BackgroundTimers(store).cancel(id);
      output = { cancelled: id };
    } else if (action === 'outbox') {
      const outbox = new BackgroundOutbox(store);
      outbox.dispatch();
      output = { messages: outbox.messages(), outcomes: outbox.outcomes() };
    } else if (action === 'seen' && id) {
      new BackgroundOutbox(store).markSeen(id);
      output = { seen: id };
    } else if (action === 'list')
      output = {
        tasks: store.tasks(),
        runs: store.runs(),
        events: store.events(),
        timers: new BackgroundTimers(store).list(),
      };
    else if (action === 'cancel' && id) {
      store.cancelTask(id);
      output = store.task(id);
    } else if (action === 'recover-supervisor' && values['confirmed-stopped']) {
      recoverSupervisor(store, true);
      output = { recovered: true };
    } else if (action === 'recover' && id && values['confirmed-stopped']) {
      recoverBackgroundRun(store, id, true);
      output = store.run(id);
    } else if (action === 'run' || action === 'serve') {
      const worker = new BackgroundWorker({
          store,
          config: options.config,
          handlers: {
            dream: dreamJob,
            evolution: evolutionJob(fileURLToPath(new URL('../../evals/tasks/', import.meta.url))),
          },
        }),
        controller = new AbortController();
      const cancel = () => controller.abort();
      process.on('SIGINT', cancel);
      try {
        if (action === 'serve') await worker.serve(controller.signal);
        else {
          const results = [];
          for (let i = 0; i < Number(values['max-iter'] ?? 100); i++) {
            const run = await worker.runOnce(controller.signal);
            if (!run) break;
            results.push(run);
          }
          output = results;
        }
      } finally {
        process.removeListener('SIGINT', cancel);
        worker.close();
      }
    } else {
      console.error(
        'Usage: mh background create "goal" | enqueue <task> --input event.json | list | run | serve | cancel <task> | recover <run> --confirmed-stopped',
      );
      return 2;
    }
    if (output !== undefined) console.log(JSON.stringify(output, null, values.json ? undefined : 2));
    return 0;
  } finally {
    store.close();
  }
}
