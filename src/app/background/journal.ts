import { createHash } from 'node:crypto';
import type { AgentEvent, Tool } from '../../agent/index.ts';
import type { SessionStore } from '../../session/index.ts';
import type { StartRunResult } from '../run.ts';

export type DurableInput = { runId: string; eventIds: string[] };
export type SavedRunResult = Omit<StartRunResult, 'session'>;

export function durableJournal(session: SessionStore, input: DurableInput, prompt: string) {
  if (
    !/^[\w-]{1,128}$/.test(input.runId) ||
    !input.eventIds.length ||
    input.eventIds.length > 16 ||
    new Set(input.eventIds).size !== input.eventIds.length ||
    input.eventIds.some((id) => !/^[\w:.-]{1,200}$/.test(id))
  )
    throw new Error('Invalid durable run identity or event IDs.');
  const hash = createHash('sha256')
    .update(JSON.stringify({ prompt, eventIds: input.eventIds }))
    .digest('hex');
  const records = session.entries();
  const lifecycle = records.filter(
    (e) => e.type === 'trace' && e.name === 'runLifecycle' && e.data.runId === input.runId,
  );
  const pending = new Map<string, boolean>();
  let result: SavedRunResult | undefined;
  for (const entry of lifecycle) {
    if (entry.type !== 'trace') continue;
    const data = entry.data;
    if (data.v !== 1 || data.inputHash !== hash) throw new Error('Durable run metadata changed or is invalid.');
    if (data.phase === 'toolPending') pending.set(String(data.callId), data.readOnly === true);
    if (data.phase === 'toolSettled' || data.phase === 'toolDeferred') pending.delete(String(data.callId));
    if (data.phase === 'completed' || data.phase === 'suspended') {
      if ([...pending.values()].some((readOnly) => !readOnly))
        throw new Error('needs_reconciliation: a completion record has an unsettled side effect.');
      const saved = data.result as SavedRunResult;
      if (
        !saved ||
        !['done', 'aborted', 'error', 'maxTurns', 'suspended'].includes(saved.reason) ||
        typeof saved.finalText !== 'string' ||
        !Number.isInteger(saved.turns) ||
        !saved.usage ||
        !['input', 'output', 'cacheRead', 'cacheWrite'].every(
          (key) =>
            Number.isFinite(saved.usage[key as keyof typeof saved.usage]) &&
            saved.usage[key as keyof typeof saved.usage] >= 0,
        )
      )
        throw new Error('Invalid durable run completion record; reconciliation is required.');
      result = saved;
    }
  }
  if (!result && [...pending.values()].some((readOnly) => !readOnly))
    throw new Error(
      'needs_reconciliation: a tool may have changed state before its result was saved. Do not replay it.',
    );
  const append = (phase: string, data: Record<string, unknown> = {}) => {
    session.append({
      type: 'trace',
      name: 'runLifecycle',
      data: { v: 1, runId: input.runId, eventIds: input.eventIds, inputHash: hash, phase, ...data },
    });
    session.flush();
  };
  if (!lifecycle.length) append('started');
  return {
    result,
    inputPresent: records.some((e) => e.type === 'message' && e.origin?.runId === input.runId),
    event(event: AgentEvent, tools: Tool[]) {
      if (event.type === 'toolDeferred') {
        append('toolDeferred', { callId: event.call.id, requestId: event.requestId });
        pending.delete(event.call.id);
      }
      if (event.type === 'toolStart') {
        const tool = tools.find((t) => t.name === event.call.name);
        const readOnly = !!tool?.readOnly && !tool.external;
        append('toolPending', {
          callId: event.call.id,
          tool: event.call.name,
          readOnly,
        });
        pending.set(event.call.id, readOnly);
      }
      if (event.type === 'message') {
        session.flush();
        if (event.message.role === 'toolResult') {
          append('toolSettled', { callId: event.message.toolCallId });
          pending.delete(event.message.toolCallId);
        }
      }
    },
    complete(saved: SavedRunResult) {
      if (!result) {
        if ([...pending.values()].some((readOnly) => !readOnly)) {
          append('needsReconciliation');
          return;
        }
        append(saved.reason === 'suspended' ? 'suspended' : 'completed', { result: saved });
        result = saved;
      }
    },
  };
}
