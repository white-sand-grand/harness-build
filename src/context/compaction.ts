import type { Message, ModelInfo, Provider, Usage } from '../ai/index.ts';
import type { Hooks } from '../agent/index.ts';
import { clearedText, summaryMessage, renderMessages } from '../session/index.ts';
import { renderTemplate } from '../util/template.ts';
import { estimateContextTokens, messageTokens } from './tokens.ts';
export function findCutPoint(messages: Message[], keepRecentTokens: number): number {
  if (messages.length < 2) return messages.length;
  let tokens = 0,
    index = messages.length - 1;
  for (; index > 0; index--) {
    tokens += messageTokens(messages[index]!);
    if (tokens > keepRecentTokens) break;
  }
  for (let i = index; i > 0; i--) if (messages[i]!.role === 'user') return i;
  // Tool-only loops have no later user boundary. Keep the entire assistant/result batch.
  if (index === 0) index = 1;
  while (index > 1 && messages[index]?.role === 'toolResult') index--;
  return index;
}
export function compactionHook(opts: {
  provider: Provider;
  model: ModelInfo;
  sessionDir: string;
  template: string;
  config: { enabled: boolean; clearAtRatio: number; compactAtRatio: number; keepRecentTokens: number };
  signal: AbortSignal;
  onSummary?: (usage: Usage, latencyMs: number) => void;
  onFailure?: (message: string) => void;
}): Hooks {
  return {
    async beforeModel(messages, info) {
      if (!opts.config.enabled && !info.force) return undefined;
      const tokens = estimateContextTokens(messages, info.lastUsage),
        cut = findCutPoint(messages, opts.config.keepRecentTokens);
      if (info.force || tokens >= opts.model.contextWindow * opts.config.compactAtRatio) {
        if (!messages.length || !cut) return undefined;
        const prefix = messages.slice(0, cut),
          previous = prefix[0]?.content.find((b) => b.type === 'text');
        const system = renderTemplate(opts.template, {
          previousSummary: previous?.type === 'text' && previous.text.startsWith('<summary>') ? previous.text : '',
          conversation: renderMessages(prefix),
        });
        const start = Date.now();
        const out = await opts.provider.stream(
          {
            model: opts.model,
            system,
            messages: [
              {
                role: 'user',
                content: [{ type: 'text', text: 'Summarize the conversation above so work can continue.' }],
              },
            ],
            tools: [],
            thinking: 'off',
            maxOutputTokens: Math.min(4096, opts.model.maxOutputTokens),
          },
          opts.signal,
          () => {},
        );
        opts.onSummary?.(out.usage, Date.now() - start);
        const summary = out.content
          .filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join('');
        if (out.stopReason === 'error' || out.stopReason === 'aborted' || !summary.trim()) {
          opts.onFailure?.(out.errorMessage ?? 'Summary generation did not complete.');
          return undefined;
        }
        return {
          kind: 'compaction',
          summary,
          messages: [summaryMessage(summary, opts.sessionDir), ...messages.slice(cut)],
          meta: { firstKeptIndex: cut, tokensBefore: tokens },
        };
      }
      if (tokens < opts.model.contextWindow * opts.config.clearAtRatio) return undefined;
      const ids: string[] = [];
      const replaced = messages.map((m, i) => {
        if (
          i >= cut ||
          m.role !== 'toolResult' ||
          m.content.filter((b) => b.type === 'text').reduce((n, b) => n + b.text.length, 0) <= 1000
        )
          return m;
        ids.push(m.toolCallId);
        return { ...m, content: [{ type: 'text' as const, text: clearedText(m.toolName) }] };
      });
      return ids.length ? { kind: 'clearing', messages: replaced, meta: { clearedToolCallIds: ids } } : undefined;
    },
  };
}
