import { mkdir, cp } from 'node:fs/promises';
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { join, basename, resolve } from 'node:path';
import type { Provider } from '../ai/index.ts';
import { zeroUsage, addUsage, cost, resolveModel, AnthropicProvider, OpenAIProvider } from '../ai/index.ts';
import { createSession } from '../session/index.ts';
import { startRun } from '../app/run.ts';
import { defaultPromptsDir, loadPrompts } from '../app/prompts.ts';
import type { Config } from '../app/config.ts';
import { runCommand } from '../util/process.ts';
import { spawnSync } from 'node:child_process';
import { loadTasks, type EvalTask, type AttemptResult } from './task.ts';
import { runJudge } from './judge.ts';
import { renderSummary, summarizeTrace } from './report.ts';
export type RunManifest = { v: 1; createdAt: string; model: string; variant: string; tasks: EvalTask[] };
export function readManifest(dir: string): RunManifest {
  return JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')) as RunManifest;
}
export function readResults(dir: string): AttemptResult[] {
  return readFileSync(join(dir, 'results.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l, i) => {
      try {
        return JSON.parse(l) as AttemptResult;
      } catch {
        throw new Error(`Corrupt evaluation results at line ${i + 1}`);
      }
    });
}
export type EvalOptions = {
  tasksDir: string;
  runDir: string;
  config: Config;
  split?: 'dev' | 'heldout' | 'all';
  pattern?: string;
  repeat?: number;
  concurrency?: number;
  promptsDir?: string;
  providerFactory?: (task: EvalTask, attempt: number) => Provider;
  signal?: AbortSignal;
  onAttempt?: (r: AttemptResult) => void;
};
export async function runEval(opts: EvalOptions): Promise<AttemptResult[]> {
  const tasks = loadTasks(opts.tasksDir, { pattern: opts.pattern, split: opts.split }),
    dir = resolve(opts.runDir),
    variant = opts.promptsDir ? basename(resolve(opts.promptsDir)) : 'default';
  if (!tasks.length) throw new Error('No evaluation tasks matched.');
  await mkdir(dir, { recursive: true });
  writeFileSync(join(dir, 'results.jsonl'), '', { flag: 'wx' });
  await cp(opts.promptsDir ?? opts.config.promptsDir ?? defaultPromptsDir, join(dir, 'prompts'), { recursive: true });
  const manifest: RunManifest = { v: 1, createdAt: new Date().toISOString(), model: opts.config.model, variant, tasks };
  writeFileSync(join(dir, 'run.json'), JSON.stringify(manifest, null, 2) + '\n');
  const model = resolveModel(opts.config.model, opts.config.models, opts.config.provider),
    jobs = tasks.flatMap((task) => Array.from({ length: opts.repeat ?? 1 }, (_, i) => ({ task, attempt: i + 1 }))),
    results: AttemptResult[] = [];
  let next = 0;
  async function attempt(task: EvalTask, n: number): Promise<AttemptResult> {
    const started = Date.now(),
      workspace = join(dir, 'workspaces', task.id, String(n)),
      home = join(dir, 'homes', task.id, String(n)),
      env = { MH_HOME: home };
    const result: AttemptResult = {
      taskId: task.id,
      attempt: n,
      variant,
      model: model.id,
      status: 'harnessError',
      turns: 0,
      usage: zeroUsage(),
      durationMs: 0,
      toolCalls: 0,
      toolErrors: 0,
      endReason: 'error',
      sessionPath: '',
    };
    try {
      opts.signal?.throwIfAborted();
      await mkdir(workspace, { recursive: true });
      await mkdir(home, { recursive: true });
      const files = join(opts.tasksDir, task.id, 'files');
      if (existsSync(files)) await cp(files, workspace, { recursive: true });
      for (const args of [
        ['init'],
        ['add', '-A'],
        [
          '-c',
          'user.name=mini-harness',
          '-c',
          'user.email=mini-harness@localhost',
          '-c',
          'commit.gpgsign=false',
          'commit',
          '--allow-empty',
          '-m',
          'init',
        ],
      ]) {
        const init = spawnSync('git', args, {
          cwd: workspace,
          encoding: 'utf8',
          windowsHide: true,
          timeout: 30000,
          env: { ...process.env, ...env },
        });
        if (init.status !== 0)
          throw new Error('Evaluation git setup failed: ' + (init.error?.message ?? init.stderr).slice(-1000));
      }
      if (task.setup) {
        const setup = await runCommand(task.setup, { cwd: workspace, timeoutSec: 120, signal: opts.signal, env });
        if (setup.exitCode !== 0 || setup.timedOut || setup.aborted) {
          result.status = 'setupError';
          result.checkOutputTail = setup.output.slice(-3000);
          return result;
        }
      }
      const session = createSession(home, workspace);
      result.sessionPath = session.dir;
      const provider =
        opts.providerFactory?.(task, n) ??
        (model.provider === 'anthropic' ? new AnthropicProvider() : new OpenAIProvider());
      const run = await startRun({
        cwd: workspace,
        home,
        session,
        config: { ...opts.config, promptsDir: join(dir, 'prompts') },
        prompt: task.prompt,
        maxTurns: task.maxTurns ?? 30,
        provider,
        signal: opts.signal,
      });
      const trace = summarizeTrace(session.entries());
      result.turns = run.turns;
      result.usage = run.usage;
      result.toolCalls = trace.toolCalls;
      result.toolErrors = trace.toolErrors;
      result.endReason = run.reason;
      const check = await runCommand(task.check.command, {
        cwd: workspace,
        timeoutSec: task.check.timeoutSec ?? 120,
        signal: opts.signal,
        env,
      });
      result.checkExitCode = check.exitCode ?? undefined;
      result.checkOutputTail = (
        check.output +
        (check.timedOut ? '\n[timed out]' : '') +
        (check.aborted ? '\n[aborted]' : '')
      ).slice(-3000);
      result.status = check.exitCode === 0 && !check.timedOut && !check.aborted ? 'pass' : 'fail';
      if (task.judge) {
        const diff = await runCommand('git diff HEAD --', { cwd: workspace, timeoutSec: 30, signal: opts.signal, env });
        const judged = await runJudge({
          provider,
          model,
          template: loadPrompts(join(dir, 'prompts')).judge,
          prompt: task.prompt,
          rubric: task.judge.rubric,
          diff: diff.output,
          finalText: run.finalText,
          signal: opts.signal ?? new AbortController().signal,
        });
        result.judge = judged.verdict;
        result.usage = addUsage(result.usage, judged.usage);
        if ('error' in judged.verdict || !judged.verdict.pass) result.status = 'fail';
        session.append({
          type: 'trace',
          name: 'turn',
          data: { kind: 'judge', usage: judged.usage, ...(judged.cache ? { cache: judged.cache } : {}) },
        });
      }
      const amount = cost(result.usage, model);
      if (amount !== undefined) result.cost = amount;
    } catch (error) {
      result.status = 'harnessError';
      result.checkOutputTail = error instanceof Error ? error.message : String(error);
    } finally {
      result.durationMs = Date.now() - started;
    }
    return result;
  }
  async function worker() {
    while (true) {
      if (opts.signal?.aborted) return;
      const job = jobs[next++];
      if (!job) return;
      const r = await attempt(job.task, job.attempt);
      results.push(r);
      appendFileSync(join(dir, 'results.jsonl'), JSON.stringify(r) + '\n');
      opts.onAttempt?.(r);
    }
  }
  await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? 1, jobs.length) }, () => worker()));
  results.sort((a, b) => a.taskId.localeCompare(b.taskId) || a.attempt - b.attempt);
  writeFileSync(join(dir, 'summary.md'), renderSummary(results, tasks));
  return results;
}
