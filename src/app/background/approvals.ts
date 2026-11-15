import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import type { ToolCallBlock } from '../../ai/index.ts';
import type { DeferredBatch, BeforeToolDecision } from '../../agent/index.ts';
import type { SessionStore } from '../../session/index.ts';
import { realPath, resolvePath } from '../../util/paths.ts';
import { BackgroundStore } from './store.ts';
import { BackgroundOutbox, observedEvidence } from './outbox.ts';
import { fingerprint, taskPolicy } from './contract.ts';
import type { ClaimedRun } from './types.ts';

export type BackgroundApproval = {
  id: string;
  taskId: string;
  runId: string;
  sessionId: string;
  batch: DeferredBatch;
  assistantEntryId: string;
  callHash: string;
  actionHash: string;
  contractHash: string;
  policyHash: string;
  precondition: string;
  state: 'pending' | 'answered' | 'consumed' | 'stale' | 'expired' | 'cancelled';
  createdAt: number;
  expiresAt: number;
  detail: string;
  decision?: 'allow' | 'deny';
  responseEventId?: string;
  executionRunId?: string;
};
const actionHash = (call: ToolCallBlock) => fingerprint({ name: call.name, args: call.args });
/** Model context may be compacted. Match the original call's durable transcript boundary. */
function hasPersistedResult(session: SessionStore, approval: BackgroundApproval): boolean {
  const entries = session.entries(),
    call = approval.batch.calls[approval.batch.nextCallIndex]!;
  const start = entries.findIndex((entry) => entry.id === approval.assistantEntryId);
  if (start < 0) return false;
  for (const entry of entries.slice(start + 1)) {
    if (entry.type !== 'message' || !entry.message) continue;
    const message = entry.message;
    if (
      message.role === 'assistant' &&
      message.content.some((block) => block.type === 'toolCall' && block.id === call.id)
    )
      return false;
    if (
      message.role === 'toolResult' &&
      message.toolCallId === call.id &&
      message.toolName === call.name &&
      typeof message.isError === 'boolean' &&
      Array.isArray(message.content)
    )
      return true;
  }
  return false;
}
export function filePrecondition(cwd: string, call: ToolCallBlock): string {
  const path = realPath(resolvePath(cwd, String(call.args.path)));
  if (!existsSync(path)) return fingerprint({ path, missing: true });
  const stat = statSync(path);
  if (!stat.isFile() || stat.size > 1024 * 1024)
    throw new Error('Deferred writes require an ordinary file no larger than 1MiB.');
  return fingerprint({ path, content: readFileSync(path).toString('base64') });
}
export class BackgroundApprovals {
  private store: BackgroundStore;
  constructor(store: BackgroundStore) {
    this.store = store;
  }
  list(taskId?: string): BackgroundApproval[] {
    const rows = taskId
      ? this.store.db.prepare('SELECT data FROM approvals WHERE task_id=? ORDER BY rowid').all(taskId)
      : this.store.db.prepare('SELECT data FROM approvals ORDER BY rowid').all();
    return rows.map((row) => JSON.parse(String(row.data)) as BackgroundApproval);
  }
  get(id: string): BackgroundApproval {
    const item = this.list().find((approval) => approval.id === id);
    if (!item) throw new Error('Unknown approval request.');
    return item;
  }
  private save(item: BackgroundApproval) {
    this.store.db.prepare('UPDATE approvals SET data=? WHERE id=?').run(JSON.stringify(item), item.id);
  }
  defer(claim: ClaimedRun, session: SessionStore, batch: DeferredBatch, reason: string): { requestId: string } {
    const call = batch.calls[batch.nextCallIndex];
    if (
      !call ||
      !['write', 'edit'].includes(call.name) ||
      Buffer.byteLength(JSON.stringify(batch)) > 1024 * 1024 ||
      Buffer.byteLength(JSON.stringify(call.args)) > 16000
    )
      throw new Error('The deferred mutation is invalid or too large to review.');
    const task = this.store.task(claim.task.id);
    if (task.state !== 'active' || task.expiresAt <= this.store.now())
      throw new Error('The background task is no longer active.');
    const assistant = session
      .entries()
      .findLast(
        (entry) =>
          entry.type === 'message' &&
          entry.message.role === 'assistant' &&
          entry.message.content.some((block) => block.type === 'toolCall' && block.id === call.id),
      );
    if (!assistant) throw new Error('Deferred call has no persisted assistant entry.');
    const approval: BackgroundApproval = {
      id: randomUUID(),
      taskId: task.id,
      runId: claim.run.id,
      sessionId: session.id,
      batch: structuredClone(batch),
      assistantEntryId: assistant.id,
      callHash: fingerprint(call),
      actionHash: actionHash(call),
      contractHash: claim.run.contractHash,
      policyHash: taskPolicy(task),
      precondition: filePrecondition(task.cwd, call),
      state: 'pending',
      createdAt: this.store.now(),
      expiresAt: Math.min(task.expiresAt, this.store.now() + 86400000),
      detail: `${reason}\n${call.name}\n${JSON.stringify(call.args, null, 2)}`,
    };
    session.flush();
    this.store.transaction(() => {
      const currentTask = this.store.task(task.id);
      if (currentTask.state !== 'active') throw new Error('Task state changed before suspension.');
      this.store.db
        .prepare('INSERT INTO approvals(id,task_id,run_id,data) VALUES(?,?,?,?)')
        .run(approval.id, task.id, claim.run.id, JSON.stringify(approval));
      const run = this.store.run(claim.run.id);
      run.state = 'suspended';
      this.store.saveRun(run);
      this.store.db.prepare("UPDATE inbox SET status='handled' WHERE run_id=? AND status='claimed'").run(run.id);
      currentTask.state = 'waitingApproval';
      currentTask.progress = 'Waiting for an exact tool approval.';
      this.store.saveTask(currentTask);
      const outbox = new BackgroundOutbox(this.store);
      outbox.record(run, currentTask, observedEvidence(session, run, claim.events));
      outbox.enqueue(run.id, task.id, 'approval', approval.detail, 'approval:' + approval.id);
    });
    return { requestId: approval.id };
  }
  respond(id: string, decision: 'allow' | 'deny'): BackgroundApproval {
    if (!['allow', 'deny'].includes(decision)) throw new Error('Only a single allow or deny response is supported.');
    this.expire();
    const result = this.store.transaction(() => {
      const approval = this.get(id),
        task = this.store.task(approval.taskId);
      if (approval.state !== 'pending')
        throw new Error('Approval was already answered, expired or is no longer valid.');
      if (approval.expiresAt <= this.store.now() || task.expiresAt <= this.store.now()) {
        approval.state = 'expired';
        this.save(approval);
        task.state = 'expired';
        this.store.saveTask(task);
        return { error: 'Approval expired.' };
      }
      if (task.state !== 'waitingApproval') throw new Error('The approval does not belong to a waiting task.');
      const response = this.store.insertEvent({
        taskId: task.id,
        source: 'approval',
        sourceEventId: approval.id,
        kind: 'approvalResponse',
        payload: JSON.stringify({ requestId: approval.id, decision }),
        availableAt: this.store.now(),
      });
      approval.state = 'answered';
      approval.decision = decision;
      approval.responseEventId = response.event.id;
      this.save(approval);
      task.state = 'active';
      this.store.saveTask(task);
      return { approval };
    });
    if ('error' in result) throw new Error(result.error);
    return result.approval;
  }
  beginResume(claim: ClaimedRun, session: SessionStore): BackgroundApproval {
    const result = this.store.transaction(() => {
      const item = this.get(claim.run.approvalId!),
        task = this.store.task(claim.task.id);
      if (
        item.taskId !== task.id ||
        item.sessionId !== session.id ||
        !['answered', 'expired'].includes(item.state) ||
        !claim.run.eventIds.includes(item.responseEventId!) ||
        (item.executionRunId && item.executionRunId !== claim.run.id)
      )
        throw new Error('The approval response is not valid for this run/session.');
      const assistant = session.entries().find((entry) => entry.id === item.assistantEntryId);
      if (
        (item.expiresAt <= this.store.now() && item.decision !== 'deny') ||
        item.contractHash !== claim.run.contractHash ||
        item.policyHash !== taskPolicy(task) ||
        assistant?.type !== 'message' ||
        assistant.message.role !== 'assistant'
      ) {
        item.state = item.expiresAt <= this.store.now() ? 'expired' : 'stale';
        this.save(item);
        return { error: 'Approval is expired or its pinned contract changed; create a newly reviewed task.' };
      }
      const call = item.batch.calls[item.batch.nextCallIndex]!;
      if (
        fingerprint(call) !== item.callHash ||
        fingerprint(item.batch.calls) !==
          fingerprint(assistant.message.content.filter((block) => block.type === 'toolCall'))
      )
        throw new Error('Approval parameters no longer match the persisted call.');
      item.executionRunId = claim.run.id;
      this.save(item);
      return { item };
    });
    if ('error' in result) throw new Error(result.error);
    return result.item;
  }
  beforeTool(claim: ClaimedRun, session: SessionStore, approved?: BackgroundApproval) {
    let used = false;
    return async (call: ToolCallBlock): Promise<BeforeToolDecision> => {
      const current = this.store.task(claim.task.id);
      if (current.state !== 'active' || current.expiresAt <= this.store.now())
        return { action: 'deny', reason: 'The task was cancelled, blocked or expired. No further tool may execute.' };
      if (!['write', 'edit'].includes(call.name)) return { action: 'allow' };
      if (
        approved &&
        call.id === approved.batch.calls[approved.batch.nextCallIndex]!.id &&
        fingerprint(call) === approved.callHash
      ) {
        if (used || hasPersistedResult(session, approved))
          return { action: 'deny', reason: 'This exact approval has already been consumed; do not repeat the action.' };
        used = true;
        if (approved.decision !== 'allow')
          return {
            action: 'deny',
            reason:
              approved.state === 'expired'
                ? 'Approval expired. The action was not executed.'
                : 'The user denied this action. Do not retry it.',
          };
        const task = this.store.task(claim.task.id);
        if (
          approved.expiresAt <= this.store.now() ||
          task.state !== 'active' ||
          approved.policyHash !== taskPolicy(task) ||
          filePrecondition(task.cwd, call) !== approved.precondition
        ) {
          approved.state = 'stale';
          this.save(approved);
          return {
            action: 'deny',
            reason: 'Approval is stale: file contents or policy changed. Do not execute the old action.',
          };
        }
        return { action: 'allow' };
      }
      if (this.list(claim.task.id).some((item) => item.decision === 'deny' && item.actionHash === actionHash(call)))
        return { action: 'deny', reason: 'The user already denied this mutation. Do not retry it.' };
      return { action: 'defer', reason: 'Approve this exact file mutation before it executes.' };
    };
  }
  consume(claim: ClaimedRun, session: SessionStore) {
    if (!claim.run.approvalId) return;
    const item = this.get(claim.run.approvalId);
    if (item.executionRunId === claim.run.id && hasPersistedResult(session, item)) {
      if (item.state === 'answered') item.state = 'consumed';
      this.save(item);
      const original = this.store.run(item.runId);
      if (original.state === 'suspended') {
        original.state = 'resolved';
        this.store.saveRun(original);
      }
    }
  }
  expire() {
    this.store.transaction(() => {
      for (const item of this.list()) {
        if (item.state !== 'pending' || item.expiresAt > this.store.now()) continue;
        const task = this.store.task(item.taskId);
        item.state = 'expired';
        item.decision = 'deny';
        if (task.expiresAt <= this.store.now() || task.state === 'cancelled') {
          task.state = task.state === 'cancelled' ? 'cancelled' : 'expired';
          this.store.saveTask(task);
          this.save(item);
          continue;
        }
        if (task.state !== 'waitingApproval') {
          this.save(item);
          continue;
        }
        const event = this.store.insertEvent({
          taskId: task.id,
          source: 'approval',
          sourceEventId: item.id,
          kind: 'approvalResponse',
          payload: JSON.stringify({ requestId: item.id, decision: 'deny', reason: 'expired' }),
          availableAt: this.store.now(),
        });
        item.responseEventId = event.event.id;
        this.save(item);
        task.state = 'active';
        this.store.saveTask(task);
      }
    });
  }
}
