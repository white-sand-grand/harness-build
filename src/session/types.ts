import type { Message, ProviderId } from '../ai/index.ts';
import type { DistributiveOmit } from '../util/ids.ts';
export type ClearingReceipt = { entryId: string; index: number; outputRef: string; sha256: string };
export type SessionEntry =
  | { type: 'header'; v: 1; id: string; cwd: string; createdAt: string; harnessVersion: string; title?: string }
  | { type: 'message'; id: string; ts: string; message: Message; origin?: { runId: string; eventIds: string[] } }
  | {
      type: 'compaction';
      id: string;
      ts: string;
      summary: string;
      firstKeptEntryId: string;
      tokensBefore: number;
      continuation?: unknown;
    }
  | { type: 'clearing'; id: string; ts: string; clearedEntryIds: string[]; receipts?: ClearingReceipt[] }
  | { type: 'modelChange'; id: string; ts: string; provider: ProviderId; model: string }
  | {
      type: 'trace';
      id: string;
      ts: string;
      name: 'systemPrompt' | 'turn' | 'tool' | 'hook' | 'agentEnd' | 'runtime' | 'runLifecycle' | 'jobLifecycle';
      data: Record<string, unknown>;
    };
export interface SessionStore {
  readonly id: string;
  readonly dir: string;
  acquireWriter(): () => void;
  flush(): void;
  append(entry: DistributiveOmit<SessionEntry, 'id' | 'ts'>): string;
  entries(): SessionEntry[];
  context(): { messages: Message[]; entryIds: string[] };
}
