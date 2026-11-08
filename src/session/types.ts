import type { Message, ProviderId } from '../ai/index.ts';
import type { DistributiveOmit } from '../util/ids.ts';
export type SessionEntry =
  | { type: 'header'; v: 1; id: string; cwd: string; createdAt: string; harnessVersion: string }
  | { type: 'message'; id: string; ts: string; message: Message }
  | { type: 'compaction'; id: string; ts: string; summary: string; firstKeptEntryId: string; tokensBefore: number }
  | { type: 'clearing'; id: string; ts: string; clearedEntryIds: string[] }
  | { type: 'modelChange'; id: string; ts: string; provider: ProviderId; model: string }
  | {
      type: 'trace';
      id: string;
      ts: string;
      name: 'systemPrompt' | 'turn' | 'tool' | 'hook' | 'agentEnd';
      data: Record<string, unknown>;
    };
export interface SessionStore {
  readonly id: string;
  readonly dir: string;
  append(entry: DistributiveOmit<SessionEntry, 'id' | 'ts'>): string;
  entries(): SessionEntry[];
  context(): { messages: Message[]; entryIds: string[] };
}
