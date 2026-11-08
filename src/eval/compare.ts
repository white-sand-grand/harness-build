import type { AttemptResult } from './task.ts';
import { readManifest, readResults } from './runner.ts';
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
export function compareRuns(aDir: string, bDir: string) {
  const a = readResults(aDir),
    b = readResults(bDir),
    am = readManifest(aDir),
    bm = readManifest(bDir);
  function split(which: 'dev' | 'heldout') {
    const aid = new Set(am.tasks.filter((t) => t.split === which).map((t) => t.id)),
      bid = new Set(bm.tasks.filter((t) => t.split === which).map((t) => t.id)),
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
  return { dev: split('dev'), heldout: split('heldout') };
}
export function renderComparison(report: ReturnType<typeof compareRuns>): string {
  const percent = (n: number | null) => (n === null ? 'n/a' : (n * 100).toFixed(1) + '%');
  return (['dev', 'heldout'] as const)
    .map((split) => {
      const r = report[split];
      return `## ${split}\n\nPass rate ${percent(r.a.passRate)} → ${percent(r.b.passRate)} (delta ${percent(r.delta)})\nMean tokens ${r.a.meanTokens.toFixed(0)} → ${r.b.meanTokens.toFixed(0)}; turns ${r.a.meanTurns.toFixed(1)} → ${r.b.meanTurns.toFixed(1)}; tool errors ${r.a.meanToolErrors.toFixed(1)} → ${r.b.meanToolErrors.toFixed(1)}\n\n| Task | A | B |\n|---|---:|---:|\n${r.tasks.map((t) => `| ${t.id} | ${percent(t.a.passRate)} | ${percent(t.b.passRate)} |`).join('\n')}`;
    })
    .join('\n\n');
}
