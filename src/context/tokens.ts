import type { Message, Usage } from '../ai/index.ts';
export function messageTokens(m: Message): number {
  return (
    Math.ceil(
      m.content.reduce(
        (n, b) =>
          n +
          (b.type === 'image'
            ? 6400
            : b.type === 'toolCall'
              ? JSON.stringify(b.args).length + b.name.length
              : b.text.length),
        0,
      ) / 4,
    ) + 8
  );
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
