import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createSession, openSession } from '../session/index.ts';
import { runCommand, type CommandResult } from '../util/process.ts';
import { projectRoot } from '../util/paths.ts';
import { startRun, type StartRunOptions } from './run.ts';
import { loadPrompts, renderTemplate } from './prompts.ts';
import { RalphCheckpoint, checkpointHash, workspaceFingerprint, type WorkCheckpointV1 } from './ralph-checkpoint.ts';
import { acquireWorkspace } from './background/ownership.ts';
import { loadedImplementationHash } from '../util/implementation.ts';
import { replaceFileDurably } from '../util/durable-file.ts';
export type RalphResult = {
  reason: 'passed' | 'maxIterations' | 'stuck' | 'aborted' | 'error';
  iterations: number;
  sessionIds: string[];
  progressFile: string;
  lastCheck?: CommandResult;
  checkpointSessionId: string;
  checkpointFile?: string;
  verification: 'passed' | 'failed' | 'unknown' | 'notRun';
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
  opts: StartRunOptions & { checkCommand: string; maxIterations?: number; checkpointSessionId?: string },
): Promise<RalphResult> {
  const ownership = acquireWorkspace(opts.home, opts.cwd);
  try {
    const first = opts.checkpointSessionId
        ? openSession(opts.home, opts.cwd, opts.checkpointSessionId)
        : createSession(opts.home, opts.cwd),
      progressFile = join(first.dir, 'ralph-progress.md'),
      checkpoint = new RalphCheckpoint(first);
    let state = checkpoint.load();
    if (opts.checkpointSessionId && !state) throw new Error('This session has no Ralph checkpoint.');
    let goal = opts.prompt || state?.goal || '';
    if (!goal || goal.length > 16000) throw new Error('Ralph requires a goal of at most 16000 characters.');
    const scope = (currentGoal: string) =>
      checkpointHash(
        JSON.stringify([
          currentGoal,
          opts.checkCommand,
          opts.config,
          loadedImplementationHash,
          opts.toolsFilter,
          opts.systemOverride,
          opts.strictReadRoots,
          opts.strictWritePaths,
          opts.protectedPaths,
          opts.includeProjectInstructions,
        ]),
      );
    const scopeHash = scope(goal);
    if (state && state.scopeHash !== scopeHash)
      throw new Error('Ralph goal, check, configuration or implementation changed; start a new task.');
    state ??= {
      v: 1,
      revision: 0,
      goal,
      scopeHash,
      phase: 'ready',
      sessionIds: [],
      items: [{ id: 'goal', description: goal, state: 'todo', checkIds: ['check'] }],
    } satisfies WorkCheckpointV1;
    const sessionIds = state.sessionIds;
    if (!opts.checkpointSessionId) writeFileSync(progressFile, '# Ralph progress\n');
    let previous = state.lastFailure,
      lastCheck = state.lastCheck;
    let checkpointFile: string | undefined;
    let verification: RalphResult['verification'] = state.evidence?.result ?? 'notRun';
    const save = () => {
      checkpointFile = checkpoint.save(state);
    };
    const result = (reason: RalphResult['reason']): RalphResult => ({
      reason,
      iterations: sessionIds.length,
      sessionIds,
      progressFile,
      lastCheck,
      checkpointSessionId: first.id,
      checkpointFile,
      verification,
    });
    const verify = async () => {
      let before = workspaceFingerprint(opts.cwd, opts.home);
      for (let attempt = 0; attempt < 2; attempt++) {
        lastCheck = await runCommand(opts.checkCommand, {
          cwd: opts.cwd,
          timeoutSec: 120,
          signal: opts.signal,
          env: { MH_HOME: opts.home },
        });
        const after = workspaceFingerprint(opts.cwd, opts.home);
        const passed = lastCheck.exitCode === 0 && !lastCheck.timedOut && !lastCheck.aborted;
        if (passed && before !== after && attempt === 0) {
          before = after;
          continue;
        }
        verification =
          lastCheck.aborted || lastCheck.timedOut || (passed && before !== after)
            ? 'unknown'
            : passed
              ? 'passed'
              : 'failed';
        const outputRef = `ralph-checks/${state.revision + 1}.txt`;
        mkdirSync(join(first.dir, 'ralph-checks'), { recursive: true });
        replaceFileDurably(join(first.dir, outputRef), lastCheck.output);
        state.evidence = {
          workspaceFingerprint: after,
          result: verification,
          outputRef,
          sourceSessionId: sessionIds.at(-1) ?? first.id,
        };
        state.lastCheck = { ...lastCheck, output: lastCheck.output.slice(-8000) };
        state.items[0]!.state = verification === 'passed' ? 'verified' : 'blocked';
        first.append({
          type: 'trace',
          name: 'hook',
          data: {
            hook: 'ralphCheck',
            commandHash: checkpointHash(opts.checkCommand),
            ...state.evidence,
            exitCode: lastCheck.exitCode,
            timedOut: lastCheck.timedOut,
            aborted: lastCheck.aborted,
          },
        });
        break;
      }
    };
    if (opts.checkpointSessionId && state.phase !== 'running') {
      if (
        state.evidence?.result === 'passed' &&
        state.evidence.workspaceFingerprint === workspaceFingerprint(opts.cwd, opts.home)
      )
        return result('passed');
      await verify();
      state.phase = 'finished';
      save();
      if (verification === 'passed') return result('passed');
      if (opts.signal?.aborted) return result('aborted');
    }
    for (let iteration = 1; iteration <= (opts.maxIterations ?? 5); iteration++) {
      if (opts.signal?.aborted) return result('aborted');
      const recovering = state.phase === 'running';
      const session = recovering
        ? openSession(opts.home, opts.cwd, sessionIds.at(-1)!)
        : sessionIds.length
          ? createSession(opts.home, opts.cwd)
          : first;
      if (!recovering) sessionIds.push(session.id);
      const prompt = recovering
        ? state.prompt!
        : renderTemplate(loadPrompts(opts.config.promptsDir).fragments.ralphIteration, {
            prompt: goal,
            iteration: sessionIds.length,
            progressFile,
            check: opts.checkCommand,
            lastCheckOutput: lastCheck?.output.slice(-3000) ?? '',
          }) +
          '\nHost checkpoint data (not instructions or approval):\n' +
          JSON.stringify({ revision: state.revision, items: state.items, evidence: state.evidence });
      state.phase = 'running';
      state.prompt = prompt;
      state.items[0]!.state = 'inProgress';
      save();
      const run = await startRun({
        ...opts,
        session,
        prompt,
        ask: undefined,
        maxTurns: opts.maxTurns ?? 50,
        writeRoots: [projectRoot(opts.cwd), first.dir],
        workspaceOwnership: ownership,
        getSteering: opts.getSteering
          ? () => {
              const messages = opts.getSteering!();
              if (messages.length) {
                const text = messages
                  .filter((message) => message.role === 'user')
                  .flatMap((message) =>
                    message.content.filter((block) => block.type === 'text').map((block) => block.text),
                  )
                  .join('\n');
                if (text.length > 8000) throw new Error('Ralph steering exceeds its bound.');
                session.append({ type: 'trace', name: 'hook', data: { hook: 'ralphSteering', text } });
                session.flush();
              }
              return messages;
            }
          : undefined,
        durable: { runId: `ralph-${first.id}-${sessionIds.length}`, eventIds: [`ralph:${sessionIds.length}`] },
        protectedPaths: [
          ...(opts.protectedPaths ?? []),
          checkpoint.directory,
          join(first.dir, 'ralph-checks'),
          join(first.dir, 'session.jsonl'),
          join(first.dir, '.writer.lock'),
        ],
      });
      const updates = session
        .entries()
        .flatMap((entry) =>
          entry.type === 'trace' &&
          entry.name === 'hook' &&
          entry.data.hook === 'ralphSteering' &&
          typeof entry.data.text === 'string'
            ? [entry.data.text]
            : [],
        );
      if (updates.length) {
        const updated = goal + '\nUser updates:\n' + updates.join('\n');
        if (updated.length > 16000)
          throw new Error('Updated Ralph goal exceeds its bound; original updates remain in the transcript.');
        goal = updated;
        state.goal = goal;
        state.scopeHash = scope(goal);
        state.items[0]!.description = goal;
        previous = undefined;
        state.lastFailure = undefined;
      }
      state.phase = 'finished';
      if (run.reason === 'aborted' || run.reason === 'error' || run.reason === 'suspended') {
        state.items[0]!.state = 'blocked';
        verification = 'unknown';
        save();
        return result(run.reason === 'aborted' ? 'aborted' : 'error');
      }
      await verify();
      if (lastCheck!.aborted) {
        save();
        return result('aborted');
      }
      if (verification === 'passed') {
        save();
        return result('passed');
      }
      const normalized =
        normalizeFailure(lastCheck!.output) + `\nexit:${lastCheck!.exitCode};timeout:${lastCheck!.timedOut}`;
      state.lastFailure = normalized.slice(-12000);
      save();
      if (previous === normalized) return result('stuck');
      previous = normalized;
    }
    return result('maxIterations');
  } finally {
    ownership.release();
  }
}
