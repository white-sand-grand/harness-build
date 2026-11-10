import { createHash } from 'node:crypto';
import { runAgent } from '../agent/index.ts';
import type { AgentEndReason, AgentEvent, ContextReplacement } from '../agent/index.ts';
import type { Provider, Usage, Message } from '../ai/index.ts';
import { zeroUsage, addUsage, cost } from '../ai/index.ts';
import { createSession } from '../session/index.ts';
import type { SessionStore } from '../session/index.ts';
import type { Asker } from '../hooks/permission.ts';
import type { Config } from './config.ts';
import { buildAgent } from './build-agent.ts';
export type StartRunOptions = {
  cwd: string;
  home: string;
  config: Config;
  prompt: string;
  session?: SessionStore;
  ask?: Asker;
  signal?: AbortSignal;
  onEvent?: (e: AgentEvent) => void;
  provider?: Provider;
  toolsFilter?: string[];
  systemOverride?: string;
  writeRoots?: string[];
  strictReadRoots?: string[];
  strictWritePaths?: string[];
  includeProjectInstructions?: boolean;
  maxTurns?: number;
  getSteering?: () => Message[];
};
export type StartRunResult = {
  reason: AgentEndReason;
  finalText: string;
  session: SessionStore;
  usage: Usage;
  turns: number;
};
export function persistReplacement(session: SessionStore, r: ContextReplacement) {
  const context = session.context();
  if (r.kind === 'compaction')
    session.append({
      type: 'compaction',
      summary: r.summary ?? '',
      firstKeptEntryId: context.entryIds[Number(r.meta.firstKeptIndex)] ?? '',
      tokensBefore: Number(r.meta.tokensBefore ?? 0),
    });
  else {
    const ids = new Set((r.meta.clearedToolCallIds as string[]) ?? []);
    session.append({
      type: 'clearing',
      clearedEntryIds: session
        .entries()
        .filter((e) => e.type === 'message' && e.message.role === 'toolResult' && ids.has(e.message.toolCallId))
        .map((e) => e.id),
    });
  }
}
export async function startRun(opts: StartRunOptions): Promise<StartRunResult> {
  const session = opts.session ?? createSession(opts.home, opts.cwd),
    cfg = buildAgent(opts, session),
    messages = session.context().messages;
  const startEntry = session.entries().length;
  let usage = zeroUsage(),
    turns = 0,
    started = Date.now(),
    finalText = '';
  if (!session.entries().some((e) => e.type === 'trace' && e.name === 'systemPrompt'))
    session.append({
      type: 'trace',
      name: 'systemPrompt',
      data: { hash: createHash('sha256').update(cfg.system).digest('hex'), length: cfg.system.length },
    });
  function onEvent(e: AgentEvent) {
    if (e.type === 'turnStart') {
      turns = e.turn;
      started = Date.now();
    }
    if (e.type === 'message') {
      session.append({ type: 'message', message: e.message });
      if (e.message.role === 'assistant') {
        usage = addUsage(usage, e.message.usage);
        finalText = e.message.content
          .filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join('');
        session.append({
          type: 'trace',
          name: 'turn',
          data: {
            turn: turns,
            usage: e.message.usage,
            latencyMs: Date.now() - started,
            stopReason: e.message.stopReason,
            ...(e.message.cache ? { cache: e.message.cache } : {}),
            ...(e.message.responsesId ? { responsesId: e.message.responsesId } : {}),
          },
        });
      }
    }
    if (e.type === 'toolEnd')
      session.append({
        type: 'trace',
        name: 'tool',
        data: {
          name: e.call.name,
          durationMs: e.durationMs,
          isError: !!e.result.isError,
          outputChars: JSON.stringify(e.result.content).length,
          truncated: !!(e.result.details as { truncated?: boolean } | undefined)?.truncated,
        },
      });
    if (e.type === 'stopHook')
      session.append({ type: 'trace', name: 'hook', data: { hook: 'stopCheck', decision: e.decision.action } });
    if (e.type === 'contextReplaced') persistReplacement(session, e.replacement);
    if (e.type === 'agentEnd') {
      usage = session
        .entries()
        .slice(startEntry)
        .filter((e) => e.type === 'trace' && e.name === 'turn')
        .reduce(
          (sum, e) => (e.type === 'trace' && e.data.usage ? addUsage(sum, e.data.usage as Usage) : sum),
          zeroUsage(),
        );
      session.append({
        type: 'trace',
        name: 'agentEnd',
        data: { reason: e.reason, error: e.error, turns, totalUsage: usage, cost: cost(usage, cfg.model) },
      });
    }
    opts.onEvent?.(e);
  }
  const pending = new Map<string, { id: string; name: string }>();
  for (const message of messages) {
    if (message.role === 'assistant') for (const b of message.content) if (b.type === 'toolCall') pending.set(b.id, b);
    if (message.role === 'toolResult') pending.delete(message.toolCallId);
  }
  for (const call of pending.values()) {
    const result: Message = {
      role: 'toolResult',
      toolCallId: call.id,
      toolName: call.name,
      isError: true,
      content: [
        {
          type: 'text',
          text: 'Tool call was not completed before the previous process stopped. Re-issue it if it is still needed.',
        },
      ],
    };
    messages.push(result);
    onEvent({ type: 'message', message: result });
  }
  if (opts.prompt) {
    const user: Message = { role: 'user', content: [{ type: 'text', text: opts.prompt }] };
    messages.push(user);
    onEvent({ type: 'message', message: user });
  }
  let reason: AgentEndReason;
  try {
    reason = await runAgent(cfg, messages, {
      signal: opts.signal ?? new AbortController().signal,
      onEvent,
      getSteering: opts.getSteering,
      toolContext: { cwd: opts.cwd, sessionDir: session.dir, home: opts.home },
    });
  } catch (error) {
    onEvent({
      type: 'agentEnd',
      reason: 'error',
      error: 'Internal harness error: ' + (error instanceof Error ? error.message : String(error)),
    });
    throw error;
  }
  return { reason, finalText, session, usage, turns };
}
