import { createHash, randomUUID } from 'node:crypto';
import type { SessionStore } from '../../session/index.ts';
import { realPath, resolvePath } from '../../util/paths.ts';
import { BackgroundStore } from './store.ts';
import type { BackgroundRun, BackgroundTask, InboxEvent } from './types.ts';

export type BackgroundOutcome = {
  runId: string;
  taskId: string;
  decision: 'send' | 'quiet' | 'needsApproval';
  evidenceHash: string;
  sourceHash: string;
  sourceEventIds: string[];
  verification: 'notRun' | 'passed' | 'failed' | 'unknown';
  reason: string;
};
export type OutgoingMessage = {
  id: string;
  taskId: string;
  runId: string;
  kind: 'result' | 'blocked' | 'approval';
  body: string;
  state: 'pending' | 'retry_wait' | 'delivered' | 'failed';
  attempts: number;
  nextAttemptAt?: number;
  error?: string;
  createdAt: number;
  deliveredAt?: number;
  seenAt?: number;
  receipt?: string;
};
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, data]) => [key, canonical(data)]),
    );
  return value;
}
type ObservedEvidence = { observationHash: string; sourceHash?: string; sourceEventIds?: string[]; reason?: string };

export function observedEvidence(session: SessionStore, run: BackgroundRun, events: InboxEvent[]): ObservedEvidence {
  const entries = session.entries();
  const first = entries.findIndex(
    (entry) => entry.type === 'trace' && entry.name === 'runLifecycle' && entry.data.runId === run.id,
  );
  const cwd = entries[0]?.type === 'header' ? entries[0].cwd : '';
  const paths = new Map<string, string>();
  const observed: string[] = [];
  for (const entry of entries.slice(first))
    if (entry.type === 'message') {
      if (entry.message.role === 'assistant')
        for (const block of entry.message.content)
          if (block.type === 'toolCall')
            paths.set(
              block.id,
              typeof block.args.path === 'string' ? realPath(resolvePath(cwd, block.args.path)) : block.name,
            );
      if (entry.message.role === 'toolResult')
        observed.push(
          JSON.stringify({
            tool: entry.message.toolName,
            path: paths.get(entry.message.toolCallId),
            content: entry.message.content,
            isError: entry.message.isError,
          }),
        );
    }
  // Scheduling metadata and generated call IDs do not indicate a change in observed task evidence.
  const external = events.filter((event) => !['timer', 'approval', 'control'].includes(event.source));
  return {
    observationHash: digest([...new Set(observed)].sort()),
    reason: run.result?.reason,
    ...(external.length
      ? {
          sourceHash: digest(
            external.map((event) => ({ source: event.source, kind: event.kind, payload: canonical(event.payload) })),
          ),
          sourceEventIds: external.map((event) => event.id),
        }
      : {}),
  };
}
export class BackgroundOutbox {
  private store: BackgroundStore;
  constructor(store: BackgroundStore) {
    this.store = store;
  }
  outcomes(taskId?: string): BackgroundOutcome[] {
    const rows = taskId
      ? this.store.db.prepare('SELECT data FROM outcomes WHERE task_id=? ORDER BY rowid').all(taskId)
      : this.store.db.prepare('SELECT data FROM outcomes ORDER BY rowid').all();
    return rows.map((row) => JSON.parse(String(row.data)) as BackgroundOutcome);
  }
  messages(taskId?: string): OutgoingMessage[] {
    const rows = taskId
      ? this.store.db.prepare('SELECT data FROM outbox WHERE task_id=? ORDER BY rowid').all(taskId)
      : this.store.db.prepare('SELECT data FROM outbox ORDER BY rowid').all();
    return rows.map((row) => JSON.parse(String(row.data)) as OutgoingMessage);
  }
  /** Called inside the same transaction as run/task/inbox completion. */
  record(run: BackgroundRun, task: BackgroundTask, evidence: ObservedEvidence) {
    if (this.store.db.prepare('SELECT run_id FROM outcomes WHERE run_id=?').get(run.id)) return;
    const previous = this.outcomes(task.id).at(-1);
    const sourceHash = evidence.sourceHash ?? previous?.sourceHash ?? digest([]);
    const sourceEventIds = evidence.sourceEventIds ?? previous?.sourceEventIds ?? [];
    const evidenceHash = digest({ observationHash: evidence.observationHash, sourceHash, reason: evidence.reason });
    const quiet = task.state === 'cancelled' || previous?.evidenceHash === evidenceHash;
    const outcome: BackgroundOutcome = {
      runId: run.id,
      taskId: task.id,
      decision: run.state === 'suspended' ? 'needsApproval' : quiet ? 'quiet' : 'send',
      evidenceHash,
      sourceHash,
      sourceEventIds,
      verification: run.verification ?? 'notRun',
      reason: run.result?.reason ?? run.state,
    };
    this.store.db
      .prepare('INSERT INTO outcomes(run_id,task_id,data) VALUES(?,?,?)')
      .run(run.id, task.id, JSON.stringify(outcome));
    if (!quiet && run.state !== 'suspended')
      this.enqueue(
        run.id,
        task.id,
        run.result?.reason === 'done' ? 'result' : 'blocked',
        (run.result?.finalText || run.error || 'Run ended: ' + outcome.reason).slice(0, 12000) +
          (outcome.verification === 'notRun'
            ? '\n\n本轮未执行检查；请查看导入证据与会话记录。'
            : '\n\n检查结论：' + outcome.verification + '；完整结果见评测报告。'),
        `${task.id}:${evidenceHash}:${task.revision}`,
      );
  }
  enqueue(
    runId: string,
    taskId: string,
    kind: OutgoingMessage['kind'],
    body: string,
    dedupeKey: string,
  ): OutgoingMessage {
    const existing = this.store.db.prepare('SELECT data FROM outbox WHERE dedupe_key=?').get(dedupeKey);
    if (existing) return JSON.parse(String(existing.data)) as OutgoingMessage;
    const message: OutgoingMessage = {
      id: randomUUID(),
      taskId,
      runId,
      kind,
      body,
      state: 'pending',
      attempts: 0,
      createdAt: this.store.now(),
    };
    this.store.db
      .prepare('INSERT INTO outbox(id,run_id,task_id,dedupe_key,data) VALUES(?,?,?,?,?)')
      .run(message.id, runId, taskId, dedupeKey, JSON.stringify(message));
    return message;
  }
  /** A local durable feed is the delivery target; user seen/read is tracked separately. */
  dispatch(): number {
    let count = 0;
    for (const message of this.messages()) {
      if (
        message.state !== 'pending' &&
        !(message.state === 'retry_wait' && (message.nextAttemptAt ?? 0) <= this.store.now())
      )
        continue;
      const attempts = (message.attempts ?? 0) + 1;
      const delivered = {
        ...message,
        attempts,
        state: 'delivered' as const,
        deliveredAt: this.store.now(),
        receipt: 'local:' + message.id,
      };
      delete delivered.error;
      delete delivered.nextAttemptAt;
      try {
        const committed = this.store.transaction(() => {
          const current = JSON.parse(
            String(this.store.db.prepare('SELECT data FROM outbox WHERE id=?').get(message.id)!.data),
          ) as OutgoingMessage;
          if (
            current.state === 'delivered' ||
            current.state === 'failed' ||
            (current.attempts ?? 0) !== (message.attempts ?? 0)
          )
            return false;
          this.store.db
            .prepare('INSERT OR IGNORE INTO deliveries(outbox_id,data) VALUES(?,?)')
            .run(message.id, JSON.stringify(delivered));
          this.store.db.prepare('UPDATE outbox SET data=? WHERE id=?').run(JSON.stringify(delivered), message.id);
          return true;
        });
        if (committed) count++;
      } catch (error) {
        const retry: OutgoingMessage = {
          ...message,
          attempts,
          state: attempts >= 3 ? 'failed' : 'retry_wait',
          nextAttemptAt: this.store.now() + Math.min(30000, 1000 * 2 ** (attempts - 1)),
          error: (error instanceof Error ? error.message : String(error)).slice(0, 300),
        };
        this.store.transaction(() => {
          const current = JSON.parse(
            String(this.store.db.prepare('SELECT data FROM outbox WHERE id=?').get(message.id)!.data),
          ) as OutgoingMessage;
          if (current.state !== 'delivered' && (current.attempts ?? 0) === (message.attempts ?? 0))
            this.store.db.prepare('UPDATE outbox SET data=? WHERE id=?').run(JSON.stringify(retry), message.id);
        });
      }
    }
    return count;
  }
  markSeen(id: string) {
    this.store.transaction(() => {
      const message = this.messages().find((item) => item.id === id);
      if (!message || message.state !== 'delivered') throw new Error('Message has not been delivered.');
      message.seenAt = this.store.now();
      this.store.db.prepare('UPDATE outbox SET data=? WHERE id=?').run(JSON.stringify(message), id);
      this.store.db.prepare('UPDATE deliveries SET data=? WHERE outbox_id=?').run(JSON.stringify(message), id);
    });
  }
}
