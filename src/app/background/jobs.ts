import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import type { Provider } from '../../ai/index.ts';
import type { SessionStore } from '../../session/index.ts';
import type { Config } from '../config.ts';
import { runDream } from '../dream.ts';
import { fingerprint } from './contract.ts';
import type { SavedRunResult } from './journal.ts';
import type { BackgroundRun, ClaimedRun, InboxEvent } from './types.ts';
import type { Ownership } from '../../util/ownership.ts';

export type BackgroundJobResult = {
  result: SavedRunResult;
  verification: 'passed' | 'failed' | 'unknown' | 'notRun';
  artifacts: string[];
  evidenceKey?: string;
  evidence?: unknown;
};
export type BackgroundJobContext = {
  claim: ClaimedRun;
  home: string;
  config: Config;
  provider: Provider;
  signal: AbortSignal;
  session: SessionStore;
  outputDir: string;
  sourceEvents: InboxEvent[];
  previousRuns: BackgroundRun[];
  sessionGuard: (session: SessionStore, taskId: string) => void;
  workspaceOwnership: Ownership;
};
export type BackgroundJobHandler = (context: BackgroundJobContext) => Promise<BackgroundJobResult>;
function validJobResult(value: BackgroundJobResult): boolean {
  return (
    !!value?.result &&
    ['done', 'error', 'aborted', 'maxTurns'].includes(value.result.reason) &&
    typeof value.result.finalText === 'string' &&
    Number.isSafeInteger(value.result.turns) &&
    value.result.turns >= 0 &&
    !!value.result.usage &&
    Object.values(value.result.usage).length === 4 &&
    Object.values(value.result.usage).every((number) => Number.isFinite(number) && number >= 0) &&
    ['passed', 'failed', 'unknown', 'notRun'].includes(value.verification) &&
    Array.isArray(value.artifacts) &&
    value.artifacts.every((path) => typeof path === 'string')
  );
}

export async function runBackgroundJob(
  context: BackgroundJobContext,
  handler: BackgroundJobHandler,
): Promise<BackgroundJobResult> {
  const { session, claim } = context;
  const previous = session
    .entries()
    .filter((entry) => entry.type === 'trace' && entry.name === 'jobLifecycle' && entry.data.runId === claim.run.id);
  const completed = previous.findLast((entry) => entry.type === 'trace' && entry.data.phase === 'completed');
  if (completed?.type === 'trace') {
    const saved = completed.data.result as BackgroundJobResult;
    if (completed.data.v !== 1 || completed.data.hash !== fingerprint(saved) || !validJobResult(saved))
      throw new Error('Invalid maintenance completion record.');
    return saved;
  }
  if (previous.length)
    throw new Error('needs_reconciliation: interrupted maintenance work must be reviewed before starting a new job.');
  mkdirSync(context.outputDir, { recursive: true });
  session.append({
    type: 'message',
    origin: { runId: claim.run.id, eventIds: claim.run.eventIds },
    message: { role: 'user', content: [{ type: 'text', text: claim.run.prompt }] },
  });
  session.append({
    type: 'trace',
    name: 'jobLifecycle',
    data: { v: 1, runId: claim.run.id, phase: 'started', kind: claim.task.kind },
  });
  session.flush();
  const result = await handler(context);
  if (!validJobResult(result)) throw new Error('Maintenance handler returned an invalid or unsupported result.');
  session.append({
    type: 'trace',
    name: 'jobLifecycle',
    data: { v: 1, runId: claim.run.id, phase: 'completed', result, hash: fingerprint(result) },
  });
  session.flush();
  return result;
}

export const dreamJob: BackgroundJobHandler = async (context) => {
  const output = await runDream({
    cwd: context.claim.task.cwd,
    home: context.home,
    config: context.config,
    provider: context.provider,
    signal: context.signal,
    session: context.session,
    sessionGuard: context.sessionGuard,
    includeProjectInstructions: false,
    completedOnly: true,
    maxTurns: context.claim.task.limits.maxRunCalls,
    workspaceOwnership: context.workspaceOwnership,
  });
  return {
    result: {
      reason: output.reason,
      finalText: output.finalText + '\nMemory snapshot: ' + output.after,
      usage: output.usage,
      turns: output.turns,
    },
    verification: 'notRun',
    artifacts: [output.sessionPath],
    evidence: { memoryHead: output.after },
  };
};
export const jobOutputDir = (home: string, runId: string) => join(home, 'background', 'jobs', runId);
