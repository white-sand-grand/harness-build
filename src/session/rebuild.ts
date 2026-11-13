import type { Message } from '../ai/index.ts';
import type { SessionEntry } from './types.ts';
export const clearedText = (name: string) =>
  `[Output of ${name} cleared to save context. Re-run the tool call if you need it again.]`;
export const summaryMessage = (summary: string, dir: string): Message => ({
  role: 'user',
  content: [{ type: 'text', text: `<summary>${summary}</summary>\n(The full transcript is at ${dir}/session.jsonl)` }],
});
const ROLES = new Set(['user', 'assistant', 'toolResult']);
/**
 * A transcript is model-writable data replayed into model context; entries that do not match the
 * Message schema (role enum, content blocks) are dropped instead of trusted.
 */
function isValidMessage(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const message = value as { role?: unknown; content?: unknown; toolCallId?: unknown };
  if (typeof message.role !== 'string' || !ROLES.has(message.role)) return false;
  if (!Array.isArray(message.content)) return false;
  if (message.role === 'toolResult' && typeof message.toolCallId !== 'string') return false;
  return message.content.every((block) => {
    if (!block || typeof block !== 'object') return false;
    const b = block as {
      type?: unknown;
      text?: unknown;
      data?: unknown;
      mediaType?: unknown;
      id?: unknown;
      name?: unknown;
      args?: unknown;
    };
    switch (b.type) {
      case 'text':
      case 'thinking':
        return typeof b.text === 'string';
      case 'image':
        return typeof b.data === 'string' && typeof b.mediaType === 'string';
      case 'toolCall':
        return (
          typeof b.id === 'string' &&
          typeof b.name === 'string' &&
          !!b.args &&
          typeof b.args === 'object' &&
          !Array.isArray(b.args)
        );
      default:
        return false;
    }
  });
}
export function rebuild(entries: SessionEntry[], dir: string): { messages: Message[]; entryIds: string[] } {
  const compact = entries.findLast((e) => e.type === 'compaction');
  const messages: Message[] = [],
    entryIds: string[] = [];
  let start = 0;
  if (compact?.type === 'compaction') {
    messages.push(summaryMessage(compact.summary, dir));
    entryIds.push(compact.id);
    start = compact.firstKeptEntryId
      ? entries.findIndex((e) => e.id === compact.firstKeptEntryId)
      : entries.indexOf(compact) + 1;
    if (start < 0) {
      // A dangling reference must not brick the session; fall back to replaying after the compaction point.
      process.emitWarning(
        `Compaction refers to missing entry ${compact.firstKeptEntryId}; replaying after the compaction entry instead.`,
      );
      start = entries.indexOf(compact) + 1;
    }
  }
  const cleared = new Set(entries.flatMap((e) => (e.type === 'clearing' ? e.clearedEntryIds : [])));
  for (const entry of entries.slice(start))
    if (entry.type === 'message') {
      if (!isValidMessage(entry.message)) {
        process.emitWarning(`Skipping invalid message entry ${entry.id} during session replay.`);
        continue;
      }
      const m = structuredClone(entry.message);
      if (cleared.has(entry.id) && m.role === 'toolResult')
        m.content = [{ type: 'text', text: clearedText(m.toolName) }];
      messages.push(m);
      entryIds.push(entry.id);
    }
  return { messages, entryIds };
}
