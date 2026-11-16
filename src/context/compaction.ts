import type { Message, ModelInfo, Provider, Usage, CacheInfo } from '../ai/index.ts';
import type { Hooks } from '../agent/index.ts';
import { clearedText, summaryMessage, renderMessages } from '../session/index.ts';
import { renderTemplate } from '../util/template.ts';
import { estimateContextTokens, messageTokens, requestTokens, requestBudget } from './tokens.ts';
import { parseContinuation, continuationFacts } from './continuation.ts';
import type { SessionEntry, ClearingReceipt } from '../session/index.ts';
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
  onSummary?: (usage: Usage, latencyMs: number, cache?: CacheInfo) => void;
  onFailure?: (message: string) => void;
  source?: () => { entryIds: string[]; entries: SessionEntry[] };
  prepareClearing?: (indices: number[]) => ClearingReceipt[];
  onBudget?: (data: Record<string, unknown>) => void;
}): Hooks {
  return {
    async beforeModel(messages, info) {
      if (!opts.config.enabled && !info.force) return undefined;
      const budget = info.request ? requestBudget(opts.model, info.request) : undefined;
      const tokens = info.request
          ? requestTokens(messages, info.request, info.lastUsage, info.previousRequest)
          : estimateContextTokens(messages, info.lastUsage),
        cut = findCutPoint(messages, opts.config.keepRecentTokens);
      opts.onBudget?.({ tokens, inputLimit: budget?.inputLimit, outputReserve: budget?.reserve });
      const admit = (candidate: Message[]) => {
        if (info.request && requestTokens(candidate, info.request) > budget!.inputLimit)
          throw new Error(
            'Context budget exhausted: system, tools or retained messages cannot fit with the output reserve. Reduce the input or output limit.',
          );
      };
      if (info.request) admit([]);
      const clear = () => {
        const indices: number[] = [];
        messages.forEach((m, i) => {
          if (
            i < cut &&
            m.role === 'toolResult' &&
            !m.isError &&
            m.content.some((b) => b.type === 'text' && b.text.length > 1000 && !b.text.startsWith('[Output of '))
          )
            indices.push(i);
        });
        const receipts = opts.prepareClearing?.(indices) ?? [];
        const replaced = messages.map((m, i) =>
          !indices.includes(i) || m.role !== 'toolResult'
            ? m
            : {
                ...m,
                content: [
                  {
                    type: 'text' as const,
                    text: clearedText(
                      m.toolName,
                      receipts.find((receipt) => receipt.index === i),
                      opts.sessionDir,
                    ),
                  },
                  ...m.content.filter((b) => b.type === 'image'),
                ],
              },
        );
        return indices.length
          ? { kind: 'clearing' as const, messages: replaced, meta: { clearedIndices: indices, receipts } }
          : undefined;
      };
      if (
        info.force ||
        tokens >= Math.min(opts.model.contextWindow * opts.config.compactAtRatio, budget?.inputLimit ?? Infinity)
      ) {
        if (!info.force) {
          const cleared = clear();
          const after = cleared
            ? info.request
              ? requestTokens(cleared.messages, info.request)
              : estimateContextTokens(cleared.messages)
            : tokens;
          if (
            cleared &&
            tokens - after >= 256 &&
            after < Math.min(opts.model.contextWindow * opts.config.compactAtRatio, budget?.inputLimit ?? Infinity)
          )
            return cleared;
          if (opts.config.compactAtRatio === Infinity) {
            admit(cleared?.messages ?? messages);
            return cleared;
          }
        }
        if (!messages.length || !cut) {
          admit(messages);
          return undefined;
        }
        const source = opts.source?.();
        const structured = !!source && opts.template.includes('ContinuationSummaryV1');
        const prefix = messages.slice(0, cut),
          previous = prefix[0]?.content.find((b) => b.type === 'text');
        const system = renderTemplate(opts.template, {
          previousSummary: previous?.type === 'text' && previous.text.startsWith('<summary>') ? previous.text : '',
          conversation: structured
            ? prefix
                .map((message, index) => `Entry ${source!.entryIds[index]}\n${renderMessages([message])}`)
                .join('\n\n')
            : renderMessages(prefix),
        });
        const summaryRequest = {
          system,
          tools: [],
          maxOutputTokens: Math.min(4096, opts.model.maxOutputTokens),
        };
        const summaryMessages: Message[] = [
          { role: 'user', content: [{ type: 'text', text: 'Summarize the conversation above so work can continue.' }] },
        ];
        if (
          info.request &&
          requestTokens(summaryMessages, summaryRequest) > requestBudget(opts.model, summaryRequest).inputLimit
        ) {
          opts.onFailure?.('Summary input cannot fit within the context budget.');
          admit(messages);
          return undefined;
        }
        const start = Date.now();
        const out = await opts.provider.stream(
          {
            model: opts.model,
            ...summaryRequest,
            messages: summaryMessages,
            thinking: 'off',
            maxOutputTokens: Math.min(4096, opts.model.maxOutputTokens),
          },
          opts.signal,
          () => {},
        );
        opts.onSummary?.(out.usage, Date.now() - start, out.cache);
        let summary = out.content
          .filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join('');
        if (out.stopReason !== 'end' || out.content.some((b) => b.type === 'toolCall') || !summary.trim()) {
          opts.onFailure?.(out.errorMessage ?? 'Summary generation did not complete.');
          admit(messages);
          return undefined;
        }
        let continuation;
        if (structured) {
          try {
            continuation = {
              summary: parseContinuation(summary, source!.entryIds.slice(0, cut)),
              facts: continuationFacts(source!.entries),
            };
            summary = JSON.stringify(continuation);
          } catch (error) {
            opts.onFailure?.(error instanceof Error ? error.message : String(error));
            admit(messages);
            return undefined;
          }
        }
        const reduced = [summaryMessage(summary, opts.sessionDir), ...messages.slice(cut)];
        admit(reduced);
        return {
          kind: 'compaction',
          summary,
          messages: reduced,
          meta: { firstKeptIndex: cut, tokensBefore: tokens, ...(continuation ? { continuation } : {}) },
        };
      }
      if (tokens < opts.model.contextWindow * opts.config.clearAtRatio) return undefined;
      const cleared = clear();
      admit(cleared?.messages ?? messages);
      return cleared;
    },
  };
}
