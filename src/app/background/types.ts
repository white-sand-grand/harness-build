import type { SavedRunResult } from './journal.ts';

export type BackgroundLimits = {
  maxRunCalls: number;
  maxRunTokens: number;
  maxTaskCalls: number;
  maxDayCalls: number;
  maxDayRuns: number;
  maxDurationSec: number;
};
export const defaultLimits: BackgroundLimits = {
  maxRunCalls: 12,
  maxRunTokens: 100000,
  maxTaskCalls: 288,
  maxDayCalls: 144,
  maxDayRuns: 24,
  maxDurationSec: 180,
};
export type BackgroundTask = {
  id: string;
  cwd: string;
  goal: string;
  kind: 'inspect' | 'dream' | 'evolution';
  state: 'active' | 'blocked' | 'waitingApproval' | 'completed' | 'cancelled' | 'expired';
  sessionId?: string;
  timezone: string;
  limits: BackgroundLimits;
  progress: string;
  revision: number;
  expiresAt: number;
  createdAt: number;
  editablePaths: string[];
};
export type InboxEvent = {
  id: string;
  taskId: string;
  source: string;
  sourceEventId: string;
  kind: string;
  payload: unknown;
  status: 'pending' | 'claimed' | 'handled' | 'dead_letter';
  availableAt: number;
  runId?: string;
};
export type BackgroundRun = {
  id: string;
  taskId: string;
  eventIds: string[];
  sessionId: string;
  state: 'running' | 'recovering' | 'completed' | 'failed' | 'suspended' | 'resolved' | 'needs_reconciliation';
  contractHash: string;
  prompt: string;
  pid: number;
  result?: SavedRunResult;
  error?: string;
  approvalId?: string;
  contextRevision?: string;
  verification?: 'passed' | 'failed' | 'unknown' | 'notRun';
  job?: { evidenceKey?: string; artifacts: string[]; evidence?: unknown };
};
export type ClaimedRun = { run: BackgroundRun; task: BackgroundTask; events: InboxEvent[] };
