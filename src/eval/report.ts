import type { SessionEntry } from '../session/index.ts';
import type { Usage, CacheInfo } from '../ai/index.ts';
import { zeroUsage, addUsage } from '../ai/index.ts';
import type { AttemptResult, EvalTask } from './task.ts';
export function summarizeTrace(entries: SessionEntry[]) {
  const traces = entries.filter((e) => e.type === 'trace'),
    turns = traces.filter((e) => e.name === 'turn'),
    tools = traces.filter((e) => e.name === 'tool'),
    ends = traces.filter((e) => e.name === 'agentEnd');
  const prices = ends.map((e) => e.data.cost),
    allPrices = prices.length > 0 && prices.every((n) => typeof n === 'number');
  const usage = turns.reduce((sum, e) => (e.data.usage ? addUsage(sum, e.data.usage as Usage) : sum), zeroUsage());
  const input = usage.input + usage.cacheRead + usage.cacheWrite;
  const readReported =
    turns.length > 0 &&
    turns.every(
      (e) =>
        (e.data.cache as CacheInfo | undefined)?.readReported ??
        Number((e.data.usage as Usage | undefined)?.cacheRead) > 0,
    );
  const writeReported =
    turns.length > 0 &&
    turns.every(
      (e) =>
        (e.data.cache as CacheInfo | undefined)?.writeReported ??
        Number((e.data.usage as Usage | undefined)?.cacheWrite) > 0,
    );
  const misses = new Map<string, number>();
  for (const turn of turns) {
    const diagnostics = (turn.data.cache as CacheInfo | undefined)?.diagnostics;
    if (diagnostics?.type === 'cache_miss' && diagnostics.reason)
      misses.set(diagnostics.reason, (misses.get(diagnostics.reason) ?? 0) + 1);
  }
  return {
    turns: turns.filter((e) => !e.data.kind).length,
    modelCalls: turns.length,
    usage,
    cache: {
      readReported,
      writeReported,
      hitRate: readReported && input > 0 ? usage.cacheRead / input : null,
      misses: Object.fromEntries(misses),
    },
    cost: allPrices ? prices.reduce<number>((sum, n) => sum + Number(n), 0) : undefined,
    toolCalls: tools.length,
    toolErrors: tools.filter((e) => e.data.isError).length,
    truncations: tools.filter((e) => e.data.truncated).length,
    compactions: entries.filter((e) => e.type === 'compaction').length,
    clearings: entries.filter((e) => e.type === 'clearing').length,
    tools: Object.fromEntries(
      [...new Set(tools.map((e) => String(e.data.name)))].map((name) => {
        const rows = tools.filter((e) => e.data.name === name);
        return [
          name,
          {
            calls: rows.length,
            errors: rows.filter((e) => e.data.isError).length,
            meanDurationMs: rows.reduce((n, e) => n + Number(e.data.durationMs ?? 0), 0) / rows.length,
          },
        ];
      }),
    ),
    stopHooks: traces.filter((e) => e.name === 'hook').map((e) => e.data),
    endReason: ends.at(-1)?.data.reason,
  };
}
export function renderSummary(results: AttemptResult[], tasks: EvalTask[]): string {
  const rows = tasks.map((t) => {
    const a = results.filter((r) => r.taskId === t.id),
      passes = a.filter((r) => r.status === 'pass').length,
      tokens = a.reduce((n, r) => n + r.usage.input + r.usage.output + r.usage.cacheRead + r.usage.cacheWrite, 0);
    return `| ${t.id} | ${t.split} | ${passes}/${a.length} | ${tokens} | ${(a.reduce((n, r) => n + r.durationMs, 0) / 1000).toFixed(1)} |`;
  });
  const known = results.every((r) => r.cost !== undefined),
    total = known ? results.reduce((n, r) => n + r.cost!, 0).toFixed(6) : 'n/a';
  return `# Evaluation summary\n\n${results.filter((r) => r.status === 'pass').length}/${results.length} passed · cost USD ${total}\n\n| Task | Split | Pass | Tokens | Seconds |\n|---|---|---:|---:|---:|\n${rows.join('\n')}\n`;
}
