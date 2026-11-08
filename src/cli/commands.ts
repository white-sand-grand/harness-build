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
import { summarizeTrace } from '../eval/report.ts';
import { openSession } from '../session/index.ts';
import { sessionId } from '../util/ids.ts';
export async function handleCommand(
  args: ReturnType<typeof parseCLI>,
  opts: { cwd: string; home: string; config: Config },
): Promise<number | undefined> {
  const [command, ...rest] = args.positionals,
    v = args.values;
  if (command === 'trace') {
    const trace = summarizeTrace(openSession(opts.home, opts.cwd, rest[0] ?? 'latest').entries());
    console.log(JSON.stringify({ ...trace, cost: trace.cost ?? 'n/a' }, null, v.json ? undefined : 2));
    return 0;
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
    const runDir = resolve(
        v.output ??
          join(opts.cwd, 'evals', 'runs', sessionId() + '-' + (v.variant ? basename(resolve(v.variant)) : 'default')),
      ),
      controller = new AbortController(),
      abort = () => controller.abort();
    process.on('SIGINT', abort);
    try {
      const results = await runEval({
        tasksDir: fileURLToPath(new URL('../../evals/tasks/', import.meta.url)),
        runDir,
        config: opts.config,
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
        : `${r.analysis}\nVariant: ${r.variantDir}\nNext: mh eval run --variant "${r.variantDir}" --split all\nThen: mh eval compare "${resolve(rest[0])}" <new-run>`,
    );
    return 0;
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
