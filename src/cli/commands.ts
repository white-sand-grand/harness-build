import type { parseCLI } from './args.ts';
import type { Config } from '../app/config.ts';
import { runRalph } from '../app/ralph.ts';
import { runDream } from '../app/dream.ts';
import { memoryDir, readIndex, memoryUndo } from '../memory/index.ts';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { join, resolve, basename } from 'node:path';
import { readFileSync } from 'node:fs';
import { runEval } from '../eval/runner.ts';
import { compareRuns, renderComparison } from '../eval/compare.ts';
import { analyzeRun } from '../eval/analyze.ts';
import { runEvolution, renderEvolution } from '../eval/evolve.ts';
import type { PromptTarget } from '../eval/candidate.ts';
import { summarizeTrace } from '../eval/report.ts';
import { openSession } from '../session/index.ts';
import { sessionId } from '../util/ids.ts';
import type { RuntimeLease, RuntimeManager } from '../app/runtime.ts';
export async function handleCommand(
  args: ReturnType<typeof parseCLI>,
  opts: { cwd: string; home: string; config: Config; runtime?: RuntimeManager },
): Promise<number | undefined> {
  const [command, ...rest] = args.positionals,
    v = args.values;
  if (command === 'plugins') {
    console.log(
      JSON.stringify(
        opts.runtime?.status() ?? { profile: 'default', plugins: [], activeRuns: 0 },
        null,
        v.json ? undefined : 2,
      ),
    );
    return 0;
  }
  if (command === 'trace') {
    const trace = summarizeTrace(openSession(opts.home, opts.cwd, rest[0] ?? 'latest').entries());
    console.log(JSON.stringify({ ...trace, cost: trace.cost ?? 'n/a' }, null, v.json ? undefined : 2));
    return 0;
  }
  if (command === 'evolve') {
    let lease: RuntimeLease | undefined;
    const controller = new AbortController(),
      abort = () => controller.abort();
    process.on('SIGINT', abort);
    try {
      lease = await opts.runtime?.acquireRun();
      const result = await runEvolution({
        tasksDir: fileURLToPath(new URL('../../evals/tasks/', import.meta.url)),
        outputDir: resolve(v.output ?? join(opts.cwd, 'evals', 'runs', sessionId() + '-evolution')),
        config: opts.config,
        runtimeSnapshot: lease?.snapshot,
        optimizerConfig: {
          ...opts.config,
          model: v['optimizer-model'] ?? opts.config.model,
          provider: (v['optimizer-provider'] ?? opts.config.provider) as Config['provider'],
        },
        promptsDir: v.variant ? resolve(v.variant) : undefined,
        pattern: v.tasks,
        repeat: v.repeat ? Number(v.repeat) : undefined,
        concurrency: v.concurrency ? Number(v.concurrency) : undefined,
        maxRounds: v.rounds ? Number(v.rounds) : undefined,
        candidatesPerRound: v.candidates ? Number(v.candidates) : undefined,
        targets: v.targets?.split(',') as PromptTarget[] | undefined,
        optimizerMaxTurns: v['max-turns'] ? Number(v['max-turns']) : undefined,
        limits: {
          ...(v['max-calls'] ? { maxModelCalls: Number(v['max-calls']) } : {}),
          ...(v['max-tokens'] ? { maxTokens: Number(v['max-tokens']) } : {}),
          ...(v.timeout ? { maxDurationSec: Number(v.timeout) } : {}),
        },
        signal: controller.signal,
        onProgress: v.json ? undefined : (message) => console.error(message),
      });
      console.log(
        v.json ? JSON.stringify(result) : renderEvolution(result) + '\nReport: ' + join(result.outputDir, 'report.md'),
      );
      return result.stopReason === 'aborted' ? 130 : result.decision === 'inconclusive' ? 1 : 0;
    } finally {
      process.removeListener('SIGINT', abort);
      await lease?.release();
    }
  }
  if (command === 'eval') {
    if (rest[0] === 'compare' && rest[1] && rest[2]) {
      const report = compareRuns(resolve(rest[1]), resolve(rest[2]));
      console.log(v.json ? JSON.stringify(report) : renderComparison(report));
      return 0;
    }
    if (rest[0] !== 'run') {
      console.error('Usage: mh eval run [options] | mh eval compare <runA> <runB>');
      return 2;
    }
    let lease: RuntimeLease | undefined;
    const runDir = resolve(
        v.output ??
          join(opts.cwd, 'evals', 'runs', sessionId() + '-' + (v.variant ? basename(resolve(v.variant)) : 'default')),
      ),
      controller = new AbortController(),
      abort = () => controller.abort();
    process.on('SIGINT', abort);
    try {
      lease = await opts.runtime?.acquireRun();
      const results = await runEval({
        tasksDir: fileURLToPath(new URL('../../evals/tasks/', import.meta.url)),
        runDir,
        config: opts.config,
        runtimeSnapshot: lease?.snapshot,
        promptsDir: v.variant ? resolve(v.variant) : undefined,
        pattern: v.tasks,
        split: (v.split as 'dev' | 'heldout' | 'all' | undefined) ?? 'all',
        repeat: v.repeat ? Number(v.repeat) : 1,
        concurrency: v.concurrency ? Number(v.concurrency) : 1,
        signal: controller.signal,
        onAttempt: (r) => {
          if (!v.json) console.error(`${r.taskId} #${r.attempt}: ${r.status}`);
        },
      });
      console.log(
        v.json
          ? JSON.stringify({ runDir, results })
          : readFileSync(join(runDir, 'summary.md'), 'utf8') + '\nRun: ' + runDir,
      );
      return controller.signal.aborted ? 130 : results.every((r) => r.status === 'pass') ? 0 : 1;
    } finally {
      process.removeListener('SIGINT', abort);
      await lease?.release();
    }
  }
  if (command === 'analyze') {
    if (!rest[0]) {
      console.error('Usage: mh analyze <run>');
      return 2;
    }
    const r = await analyzeRun({
      runDir: resolve(rest[0]),
      variantsDir: join(opts.cwd, 'evals', 'variants'),
      config: opts.config,
    });
    console.log(
      v.json
        ? JSON.stringify(r)
        : `Analyze: ${r.reason}\n${r.analysis}\nVariant: ${r.variantDir}\n` +
            (r.validation.valid
              ? `Next: mh eval run --variant "${r.variantDir}" --split all\nThen: mh eval compare "${resolve(rest[0])}" <new-run>`
              : `No candidate is ready for adoption.\n${r.validation.errors.join('\n')}`),
    );
    return r.reason === 'aborted'
      ? 130
      : r.validation.valid || ['noChange', 'insufficientEvidence'].includes(r.reason)
        ? 0
        : 1;
  }
  if (command === 'memory') {
    const dir = memoryDir(opts.home, opts.cwd);
    if (rest[0] === 'path') {
      console.log(dir);
      return 0;
    }
    if (rest[0] === 'undo') {
      const r = await memoryUndo(dir, async (stat) => {
        console.log(stat);
        if (!process.stdin.isTTY) {
          console.error('Undo requires interactive confirmation.');
          return false;
        }
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const answer = await new Promise<string>((resolve) => rl.question('Revert this dream commit? [y/N] ', resolve));
        rl.close();
        return answer.trim().toLowerCase() === 'y';
      });
      console.log(r.undone ? 'Dream reverted.' : 'Undo cancelled.');
      return r.undone ? 0 : 1;
    }
    if (rest[0] && rest[0] !== 'show') {
      console.error('Usage: mh memory [show|path|undo]');
      return 2;
    }
    console.log(
      v.json ? JSON.stringify({ path: dir, ...readIndex(dir) }) : readIndex(dir).text || '(memory index is empty)',
    );
    return 0;
  }
  if (command === 'dream') {
    const controller = new AbortController(),
      abort = () => controller.abort();
    process.on('SIGINT', abort);
    try {
      const r = await runDream({
        ...opts,
        dryRun: v['dry-run'],
        sessions: v.sessions ? Number(v.sessions) : 10,
        signal: controller.signal,
      });
      console.log(
        v.json
          ? JSON.stringify(r)
          : `${r.dryRun ? 'Dry run\n' : ''}${r.diffStat || 'No memory changes.'}\n${r.finalText}\n${r.warnings.join('\n')}`,
      );
      return r.reason === 'done' ? 0 : r.reason === 'aborted' ? 130 : 1;
    } finally {
      process.removeListener('SIGINT', abort);
    }
  }
  if (command === 'ralph') {
    if (!v.check || !rest.length) {
      console.error('Usage: mh ralph "prompt" --check "command" [--max-iter N]');
      return 2;
    }
    const controller = new AbortController(),
      abort = () => controller.abort();
    process.on('SIGINT', abort);
    try {
      const r = await runRalph({
        ...opts,
        prompt: rest.join(' '),
        checkCommand: v.check,
        maxIterations: v['max-iter'] ? Number(v['max-iter']) : 5,
        maxTurns: v['max-turns'] ? Number(v['max-turns']) : 50,
        signal: controller.signal,
      });
      console.log(
        v.json
          ? JSON.stringify(r)
          : `Ralph: ${r.reason} after ${r.iterations} iteration(s)\nProgress: ${r.progressFile}\n${r.lastCheck?.output.slice(-3000) ?? ''}`,
      );
      return r.reason === 'passed' ? 0 : r.reason === 'aborted' ? 130 : 1;
    } finally {
      process.removeListener('SIGINT', abort);
    }
  }
  return undefined;
}
