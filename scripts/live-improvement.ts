import { join, resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import { defaultConfig } from '../src/app/config.ts';
import { runEval } from '../src/eval/runner.ts';
import { analyzeRun } from '../src/eval/analyze.ts';
import { compareRuns, renderComparison } from '../src/eval/compare.ts';
import { sessionId } from '../src/util/ids.ts';
if (process.env.MH_LIVE !== '1') throw new Error('Set MH_LIVE=1 to authorize real API usage.');
const config = defaultConfig();
config.provider = process.env.MH_LIVE_PROVIDER === 'openai' ? 'openai' : 'anthropic';
config.model = process.env.MH_LIVE_MODEL ?? 'step-5-preview';
const label = config.provider + '-' + sessionId(),
  baseline = resolve('evals/runs/' + label + '-baseline'),
  candidate = resolve('evals/runs/' + label + '-candidate');
const options = {
  tasksDir: resolve('evals/tasks'),
  config,
  split: 'all' as const,
  repeat: 2,
  concurrency: 2,
  signal: AbortSignal.timeout(1200000),
  onAttempt: (r: { taskId: string; attempt: number; status: string }) =>
    process.stdout.write(`${r.taskId} #${r.attempt}: ${r.status}\n`),
};
process.stdout.write(`BASELINE ${baseline}\n`);
await runEval({ ...options, runDir: baseline });
const analysis = await analyzeRun({
  runDir: baseline,
  variantsDir: resolve('evals/variants'),
  config,
  signal: options.signal,
});
process.stdout.write(`VARIANT ${analysis.variantDir}\n`);
process.stdout.write(`CANDIDATE ${candidate}\n`);
await runEval({ ...options, runDir: candidate, promptsDir: analysis.variantDir });
const comparison = compareRuns(baseline, candidate),
  report = renderComparison(comparison);
writeFileSync(join(candidate, 'compare.md'), report + '\n');
writeFileSync(join(candidate, 'compare.json'), JSON.stringify(comparison, null, 2) + '\n');
process.stdout.write(report + '\n');
