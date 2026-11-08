import type { Message, ToolResultMessage } from '../ai/index.ts';
import type { SessionEntry } from './types.ts';
export const clearedText = (name: string) =>
  `[Output of ${name} cleared to save context. Re-run the tool call if you need it again.]`;
export const summaryMessage = (summary: string, dir: string): Message => ({
  role: 'user',
  content: [{ type: 'text', text: `<summary>${summary}</summary>\n(The full transcript is at ${dir}/session.jsonl)` }],
});
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
    if (start < 0) throw new Error(`Compaction refers to missing entry ${compact.firstKeptEntryId}`);
  }
  const cleared = new Set(entries.flatMap((e) => (e.type === 'clearing' ? e.clearedEntryIds : [])));
  for (const entry of entries.slice(start))
    if (entry.type === 'message') {
      const m = structuredClone(entry.message);
      if (cleared.has(entry.id) && m.role === 'toolResult')
        m.content = [{ type: 'text', text: clearedText(m.toolName) }];
      messages.push(m);
      entryIds.push(entry.id);
    }
  return { messages, entryIds };
}
