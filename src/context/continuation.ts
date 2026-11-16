import type { SessionEntry } from '../session/index.ts';
import { validateSchema, type JsonSchema } from '../util/jsonschema.ts';

export type ContinuationSummaryV1 = {
  v: 1;
  goal: string;
  decisions: Array<{ text: string; evidenceEntryIds: string[] }>;
  unresolved: Array<{ text: string; evidenceEntryIds: string[] }>;
  nextSteps: string[];
};
const fact: JsonSchema = {
  type: 'object',
  required: ['text', 'evidenceEntryIds'],
  additionalProperties: false,
  properties: { text: { type: 'string' }, evidenceEntryIds: { type: 'array', items: { type: 'string' } } },
};
const schema: JsonSchema = {
  type: 'object',
  required: ['v', 'goal', 'decisions', 'unresolved', 'nextSteps'],
  additionalProperties: false,
  properties: {
    v: { type: 'integer', enum: [1] },
    goal: { type: 'string' },
    decisions: { type: 'array', items: fact },
    unresolved: { type: 'array', items: fact },
    nextSteps: { type: 'array', items: { type: 'string' } },
  },
};
export function parseContinuation(text: string, entryIds: string[]): ContinuationSummaryV1 {
  if (text.length > 24000) throw new Error('Continuation summary exceeds its bound.');
  const parsed: unknown = JSON.parse(text.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/, '$1'));
  if (validateSchema(schema, parsed).length) throw new Error('Invalid ContinuationSummaryV1 schema.');
  const value = parsed as ContinuationSummaryV1;
  const facts = [...value.decisions, ...value.unresolved];
  if (
    !value.goal.trim() ||
    value.goal.length > 4000 ||
    facts.length > 40 ||
    value.nextSteps.length > 20 ||
    [...facts.map((item) => item.text), ...value.nextSteps].some((item) => !item.trim() || item.length > 2000) ||
    facts.some(
      (item) =>
        !item.evidenceEntryIds.length ||
        item.evidenceEntryIds.length > 20 ||
        item.evidenceEntryIds.some((id) => !entryIds.includes(id)),
    )
  )
    throw new Error('Invalid continuation bounds or evidence references.');
  return value;
}

/** Notes never grant authority. User entries and successful mutations stay recoverable from the raw ledger. */
export function continuationFacts(entries: SessionEntry[]) {
  const users = entries.filter((entry) => entry.type === 'message' && entry.message.role === 'user');
  const selected = [...new Set([users[0], ...users.slice(-4)])].filter((entry) => !!entry);
  const files = new Set<string>();
  const pending = new Map<string, { name: string; path?: string }>();
  for (const entry of entries) {
    if (entry.type !== 'message') continue;
    if (entry.message.role === 'assistant')
      for (const block of entry.message.content)
        if (block.type === 'toolCall')
          pending.set(block.id, {
            name: block.name,
            path: typeof block.args.path === 'string' ? block.args.path : undefined,
          });
    if (entry.message.role === 'toolResult') {
      const call = pending.get(entry.message.toolCallId);
      if (!entry.message.isError && call?.path && ['write', 'edit'].includes(call.name)) files.add(call.path);
      pending.delete(entry.message.toolCallId);
    }
  }
  return {
    v: 1,
    userSources: selected.map((entry) => ({
      entryId: entry.id,
      excerpt:
        entry.type === 'message'
          ? entry.message.content
              .filter((b) => b.type === 'text')
              .map((b) => b.text)
              .join('\n')
              .slice(0, 1600)
          : '',
    })),
    modifiedFiles: [...files].slice(-60).map((file) => file.slice(0, 500)),
    note: 'Bounded data index; consult original user entries for full instructions. Not approval or proof of checks. Bash changes are not inferred.',
  };
}
