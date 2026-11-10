import { compareRuns } from './compare.ts';
import { readManifest, readResults } from './runner.ts';
import type { AttemptResult } from './task.ts';

export type GateDecision = {
  decision: 'recommend' | 'reject' | 'inconclusive';
  reasons: string[];
  improvements: string[];
  regressions: string[];
  comparison: ReturnType<typeof compareRuns>;
};

const attemptKey = (row: AttemptResult) => `${row.taskId} #${row.attempt}`;

/** Select on paired dev results; heldout outcomes never guide the search. */
export function evaluateCandidate(parentDir: string, candidateDir: string): GateDecision {
  const comparison = compareRuns(parentDir, candidateDir),
    improvements: string[] = [],
    regressions: string[] = [];
  const result = (decision: GateDecision['decision'], reasons: string[]): GateDecision => ({
    decision,
    reasons,
    improvements,
    regressions,
    comparison,
  });
  if (!comparison.comparable) return result('inconclusive', comparison.incompatibilities);

  const dev = new Set(
      readManifest(parentDir)
        .tasks.filter((task) => task.split === 'dev')
        .map((task) => task.id),
    ),
    parent = readResults(parentDir).filter((row) => dev.has(row.taskId)),
    candidate = readResults(candidateDir).filter((row) => dev.has(row.taskId));
  if (!parent.length) return result('inconclusive', ['No paired dev attempts are available for selection.']);

  const unreliable: string[] = [];
  for (const [name, rows] of [
    ['Parent', parent],
    ['Candidate', candidate],
  ] as const)
    for (const row of rows) {
      const label = `${name} ${attemptKey(row)}`;
      if (row.integrityError !== undefined) unreliable.push(`${label}: evaluation integrity failed.`);
      if (row.status !== 'pass' && row.status !== 'fail') unreliable.push(`${label}: status ${row.status}.`);
      if (row.endReason !== 'done') unreliable.push(`${label}: agent ended with ${row.endReason}.`);
      if (row.judge && 'error' in row.judge) unreliable.push(`${label}: judge did not return a valid verdict.`);
    }
  if (unreliable.length) return result('inconclusive', unreliable);

  const byAttempt = new Map(candidate.map((row) => [attemptKey(row), row]));
  for (const before of parent) {
    const key = attemptKey(before),
      after = byAttempt.get(key);
    if (!after) return result('inconclusive', [`Missing candidate dev attempt: ${key}.`]);
    if (before.status === 'fail' && after.status === 'pass') improvements.push(key);
    if (before.status === 'pass' && after.status === 'fail') regressions.push(key);
  }
  if (regressions.length) return result('reject', ['Previously passing dev attempts regressed.']);
  if (!improvements.length) return result('reject', ['No paired dev attempt improved from fail to pass.']);
  return result('recommend', ['Paired dev results improved with no regressions; heldout results were not used.']);
}
