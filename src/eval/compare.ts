import type { AttemptResult } from './task.ts';
import { readManifest, readResults, type RunManifest } from './runner.ts';
import { hashText, stableJson } from './provenance.ts';
function metrics(rows: AttemptResult[]) {
  const n = rows.length;
  return {
    attempts: n,
    passRate: n ? rows.filter((r) => r.status === 'pass').length / n : null,
    meanTokens: n
      ? rows.reduce((s, r) => s + r.usage.input + r.usage.output + r.usage.cacheRead + r.usage.cacheWrite, 0) / n
      : 0,
    meanTurns: n ? rows.reduce((s, r) => s + r.turns, 0) / n : 0,
    meanToolErrors: n ? rows.reduce((s, r) => s + r.toolErrors, 0) / n : 0,
  };
}
function readSide(dir: string, label: string) {
  const issues: string[] = [];
  let manifest: RunManifest | undefined,
    rows: AttemptResult[] = [];
  try {
    manifest = readManifest(dir);
    if (
      !Array.isArray(manifest.tasks) ||
      manifest.tasks.some((t) => !t || typeof t.id !== 'string' || !['dev', 'heldout'].includes(t.split))
    )
      throw new Error('Invalid task manifest');
  } catch (error) {
    issues.push(`${label}: cannot read manifest: ${error instanceof Error ? error.message : String(error)}`);
    manifest = undefined;
  }
  try {
    rows = readResults(dir).filter((r) => {
      const valid =
        r &&
        typeof r.taskId === 'string' &&
        Number.isInteger(r.attempt) &&
        r.attempt > 0 &&
        ['pass', 'fail', 'setupError', 'harnessError'].includes(r.status) &&
        typeof r.model === 'string' &&
        [r.turns, r.toolErrors, r.usage?.input, r.usage?.output, r.usage?.cacheRead, r.usage?.cacheWrite].every(
          (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0,
        );
      if (!valid) issues.push(`${label}: invalid evaluation result`);
      return valid;
    });
  } catch (error) {
    issues.push(`${label}: cannot read results: ${error instanceof Error ? error.message : String(error)}`);
  }
  const seen = new Set<string>();
  for (const row of rows) {
    const key = `${row.taskId}:${row.attempt}`;
    if (seen.has(key)) issues.push(`${label}: duplicate result ${key}`);
    seen.add(key);
    if (manifest && row.model !== manifest.model) issues.push(`${label}: result model differs for ${key}`);
  }
  const provenance = manifest?.provenance;
  if (!provenance) issues.push(`${label}: missing provenance; legacy runs cannot establish comparability`);
  else {
    const { contractHash, ...contract } = provenance;
    if (contractHash !== hashText(stableJson(contract))) issues.push(`${label}: provenance contract hash is invalid`);
    if (!Number.isInteger(provenance.repeat) || provenance.repeat < 1) issues.push(`${label}: invalid repeat count`);
    else {
      const expected = new Set(
        manifest!.tasks.flatMap((t) => Array.from({ length: provenance.repeat }, (_, i) => `${t.id}:${i + 1}`)),
      );
      if (new Set(manifest!.tasks.map((t) => t.id)).size !== manifest!.tasks.length)
        issues.push(`${label}: duplicate task in manifest`);
      for (const key of expected) if (!seen.has(key)) issues.push(`${label}: missing result ${key}`);
      for (const key of seen) if (!expected.has(key)) issues.push(`${label}: unexpected result ${key}`);
    }
  }
  return { manifest, rows, issues, pairs: [...seen].sort() };
}
export function compareRuns(aDir: string, bDir: string) {
  const leftRun = readSide(aDir, 'baseline'),
    rightRun = readSide(bDir, 'candidate'),
    a = leftRun.rows,
    b = rightRun.rows,
    am = leftRun.manifest,
    bm = rightRun.manifest,
    incompatibilities = [...leftRun.issues, ...rightRun.issues];
  if (am && bm && stableJson(am.tasks) !== stableJson(bm.tasks)) incompatibilities.push('Task definitions differ');
  if (am?.provenance && bm?.provenance && am.provenance.contractHash !== bm.provenance.contractHash)
    incompatibilities.push('Experiment conditions differ (model, configuration, tasks, evaluator, runtime or budget)');
  if (stableJson(leftRun.pairs) !== stableJson(rightRun.pairs)) incompatibilities.push('Attempt pairs differ');
  function split(which: 'dev' | 'heldout') {
    const aid = new Set((am?.tasks ?? []).filter((t) => t.split === which).map((t) => t.id)),
      bid = new Set((bm?.tasks ?? []).filter((t) => t.split === which).map((t) => t.id)),
      ar = a.filter((r) => aid.has(r.taskId)),
      br = b.filter((r) => bid.has(r.taskId)),
      left = metrics(ar),
      right = metrics(br);
    return {
      a: left,
      b: right,
      delta: left.passRate !== null && right.passRate !== null ? right.passRate - left.passRate : null,
      tasks: [...new Set([...aid, ...bid])].sort().map((id) => ({
        id,
        a: metrics(ar.filter((r) => r.taskId === id)),
        b: metrics(br.filter((r) => r.taskId === id)),
      })),
    };
  }
  return { dev: split('dev'), heldout: split('heldout'), comparable: !incompatibilities.length, incompatibilities };
}
export function renderComparison(report: ReturnType<typeof compareRuns>): string {
  const percent = (n: number | null) => (n === null ? 'n/a' : (n * 100).toFixed(1) + '%');
  const body = (['dev', 'heldout'] as const)
    .map((split) => {
      const r = report[split];
      return `## ${split}\n\nPass rate ${percent(r.a.passRate)} → ${percent(r.b.passRate)} (delta ${percent(r.delta)})\nMean tokens ${r.a.meanTokens.toFixed(0)} → ${r.b.meanTokens.toFixed(0)}; turns ${r.a.meanTurns.toFixed(1)} → ${r.b.meanTurns.toFixed(1)}; tool errors ${r.a.meanToolErrors.toFixed(1)} → ${r.b.meanToolErrors.toFixed(1)}\n\n| Task | A | B |\n|---|---:|---:|\n${r.tasks.map((t) => `| ${t.id} | ${percent(t.a.passRate)} | ${percent(t.b.passRate)} |`).join('\n')}`;
    })
    .join('\n\n');
  return `${report.comparable ? 'Comparable experiment conditions.' : 'Not comparable: ' + report.incompatibilities.join('; ')}\n\n${body}`;
}
