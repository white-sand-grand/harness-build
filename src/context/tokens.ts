import type { Message, Usage, ModelRequest } from '../ai/index.ts';
export type RequestEnvelope = Pick<ModelRequest, 'system' | 'tools' | 'maxOutputTokens'>;
export const textTokens = (text: string): number => Math.ceil(Buffer.byteLength(text, 'utf8') / 4);
export function messageTokens(m: Message): number {
  const normalized = m.content.reduce(
    (n, b) =>
      n +
      (b.type === 'image'
        ? 1600
        : b.type === 'toolCall'
          ? textTokens(JSON.stringify(b.args) + b.name)
          : textTokens(b.text)),
    0,
  );
  const native = m.role === 'assistant' && m.responsesOutput ? textTokens(JSON.stringify(m.responsesOutput)) : 0;
  return Math.max(normalized, native) + 8;
}

/** Complete local estimate; provider usage already contains the previous system and tool definitions. */
export function requestTokens(
  messages: Message[],
  envelope: RequestEnvelope,
  usage?: Usage,
  previous?: RequestEnvelope,
): number {
  const fresh =
    textTokens(envelope.system) +
    textTokens(JSON.stringify(envelope.tools)) +
    messages.reduce((sum, message) => sum + messageTokens(message), 0) +
    32;
  const comparable =
    previous?.system === envelope.system && JSON.stringify(previous.tools) === JSON.stringify(envelope.tools);
  return Math.max(fresh, comparable ? estimateContextTokens(messages, usage) : 0);
}

export function requestBudget(model: { contextWindow: number; maxOutputTokens: number }, envelope: RequestEnvelope) {
  const reserve = envelope.maxOutputTokens ?? model.maxOutputTokens;
  return { reserve, inputLimit: model.contextWindow - reserve - Math.max(1024, Math.ceil(model.contextWindow * 0.03)) };
}
export function estimateContextTokens(
  messages: Message[],
  lastUsage?: Usage,
  lastUsageIndex = messages.findLastIndex((m) => m.role === 'assistant'),
): number {
  if (lastUsage && lastUsage.input + lastUsage.cacheRead + lastUsage.cacheWrite > 0)
    return (
      lastUsage.input +
      lastUsage.cacheRead +
      lastUsage.cacheWrite +
      lastUsage.output +
      messages.slice(lastUsageIndex + 1).reduce((n, m) => n + messageTokens(m), 0)
    );
  return messages.reduce((n, m) => n + messageTokens(m), 0);
}
