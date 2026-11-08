import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createSession } from '../session/index.ts';
import { runCommand, type CommandResult } from '../util/process.ts';
import { projectRoot } from '../util/paths.ts';
import { startRun, type StartRunOptions } from './run.ts';
import { loadPrompts, renderTemplate } from './prompts.ts';
export type RalphResult = {
  reason: 'passed' | 'maxIterations' | 'stuck' | 'aborted' | 'error';
  iterations: number;
  sessionIds: string[];
  progressFile: string;
  lastCheck?: CommandResult;
};
export function normalizeFailure(text: string): string {
  return text
    .replace(/\d{4}-\d{2}-\d{2}[T ][\d:.+-]+Z?/g, '<timestamp>')
    .replace(/\b\d{10,13}\b/g, '<timestamp>')
    .split('\n')
    .map((l) => l.trimEnd())
    .join('\n')
    .trim();
}
export async function runRalph(
  opts: StartRunOptions & { checkCommand: string; maxIterations?: number },
): Promise<RalphResult> {
  const first = createSession(opts.home, opts.cwd),
    progressFile = join(first.dir, 'ralph-progress.md'),
    sessionIds: string[] = [];
  writeFileSync(progressFile, '# Ralph progress\n');
  let previous: string | undefined, lastCheck: CommandResult | undefined;
  const result = (reason: RalphResult['reason']): RalphResult => ({
    reason,
    iterations: sessionIds.length,
    sessionIds,
    progressFile,
    lastCheck,
  });
  for (let iteration = 1; iteration <= (opts.maxIterations ?? 5); iteration++) {
    if (opts.signal?.aborted) return result('aborted');
    const session = iteration === 1 ? first : createSession(opts.home, opts.cwd);
    sessionIds.push(session.id);
    const prompt = renderTemplate(loadPrompts(opts.config.promptsDir).fragments.ralphIteration, {
      prompt: opts.prompt,
      iteration,
      progressFile,
      check: opts.checkCommand,
      lastCheckOutput: lastCheck?.output.slice(-3000) ?? '',
    });
    const run = await startRun({
      ...opts,
      session,
      prompt,
      ask: undefined,
      maxTurns: opts.maxTurns ?? 50,
      writeRoots: [projectRoot(opts.cwd), first.dir],
    });
    if (run.reason === 'aborted') return result('aborted');
    if (run.reason === 'error') return result('error');
    lastCheck = await runCommand(opts.checkCommand, { cwd: opts.cwd, timeoutSec: 120, signal: opts.signal });
    if (lastCheck.aborted) return result('aborted');
    if (lastCheck.exitCode === 0 && !lastCheck.timedOut) return result('passed');
    const normalized =
      normalizeFailure(lastCheck.output) + `\nexit:${lastCheck.exitCode};timeout:${lastCheck.timedOut}`;
    if (previous === normalized) return result('stuck');
    previous = normalized;
  }
  return result('maxIterations');
}
