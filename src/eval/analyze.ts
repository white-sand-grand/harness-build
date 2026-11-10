import { mkdtemp, cp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  AnthropicProvider,
  OpenAIProvider,
  addUsage,
  resolveModel,
  zeroUsage,
  type AssistantMessage,
  type Provider,
} from '../ai/index.ts';
import type { Config } from '../app/config.ts';
import { startRun } from '../app/run.ts';
import { defaultPromptsDir, loadPrompts } from '../app/prompts.ts';
import { createSession, renderSession, type SessionEntry } from '../session/index.ts';
import { sessionId } from '../util/ids.ts';
import { isWithin, realPath } from '../util/paths.ts';
import { detectShell } from '../util/process.ts';
import { readManifest, readResults } from './runner.ts';
import type { AttemptResult } from './task.ts';
import { PROMPT_FILES, PROMPT_TARGETS, promptHash, validateCandidate, type PromptTarget } from './candidate.ts';

export type Proposal = {
  hypothesis: string;
  targetFile: PromptTarget;
  category: 'prompt' | 'model/task' | 'environment/provider' | 'harness-code' | 'unknown';
  evidenceRefs: string[];
  expectedImprovement: string;
  regressionRisk: string;
};
export type AnalyzeReason =
  'done' | 'noChange' | 'insufficientEvidence' | 'modelCallBudget' | 'maxTurns' | 'aborted' | 'error';
type Evidence = { ref: string; attempt: string; failure: boolean };
type RecordWithSession = { result: AttemptResult; entries: SessionEntry[] };

async function copyPrompts(from: string, to: string) {
  for (const file of PROMPT_FILES) {
    await mkdir(dirname(join(to, file)), { recursive: true });
    await cp(join(from, file), join(to, file));
  }
}

function analyzable(result: AttemptResult, runDir: string): RecordWithSession | undefined {
  if (!['pass', 'fail'].includes(result.status) || !result.sessionPath || result.endReason === 'aborted') return;
  if (result.judge && 'error' in result.judge) return;
  try {
    const path = join(result.sessionPath, 'session.jsonl');
    if (!isWithin(realPath(runDir), realPath(path))) return;
    const entries = readFileSync(path, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as SessionEntry);
    if (!entries.some((e) => e.type === 'message' && e.message.role === 'assistant')) return;
    const providerErrors = entries.flatMap((e) =>
      e.type === 'message' && e.message.role === 'assistant' && ['error', 'aborted'].includes(e.message.stopReason)
        ? [e.message.errorMessage ?? e.message.stopReason]
        : e.type === 'trace' && e.name === 'agentEnd' && e.data.error
          ? [String(e.data.error)]
          : [],
    );
    if (
      providerErrors.some((error) =>
        /fetch failed|ECONN|ENOTFOUND|ETIMEDOUT|network|connection|socket|rate.?limit|HTTP [45]\d\d|terminated|aborted|timed? ?out|unauthori[sz]ed|invalid api key/i.test(
          error,
        ),
      )
    )
      return;
    return { result, entries };
  } catch {
    return;
  }
}

function proposalErrors(value: unknown, target: PromptTarget, evidence: Evidence[]): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['Missing or invalid proposal.json.'];
  const p = value as Partial<Proposal>,
    errors: string[] = [];
  for (const key of ['hypothesis', 'expectedImprovement', 'regressionRisk'] as const)
    if (typeof p[key] !== 'string' || !p[key]!.trim()) errors.push(`Proposal requires ${key}.`);
  if (p.targetFile !== target) errors.push('Proposal target does not match the selected prompt.');
  if (!['prompt', 'model/task', 'environment/provider', 'harness-code', 'unknown'].includes(String(p.category)))
    errors.push('Invalid proposal category.');
  if (!Array.isArray(p.evidenceRefs) || p.evidenceRefs.some((ref) => typeof ref !== 'string'))
    errors.push('Proposal evidenceRefs must be an array of event references.');
  else {
    const byRef = new Map(evidence.map((e) => [e.ref, e]));
    for (const ref of p.evidenceRefs) if (!byRef.has(ref)) errors.push(`Unknown evidence reference: ${ref}`);
    const failedAttempts = new Set(
      p.evidenceRefs
        .map((ref) => byRef.get(ref))
        .filter((e) => e?.failure)
        .map((e) => e!.attempt),
    );
    if (p.category === 'prompt' && failedAttempts.size < 2)
      errors.push('Prompt changes require evidence from at least two failed attempts.');
  }
  return errors;
}

export async function analyzeRun(opts: {
  runDir: string;
  variantsDir: string;
  config: Config;
  provider?: Provider;
  signal?: AbortSignal;
  targetFile?: PromptTarget;
  candidateIndex?: number;
  maxTurns?: number;
  maxModelCalls?: number;
  onModelCall?: () => void;
  onModelResult?: (message: AssistantMessage) => void;
}) {
  const targetFile = opts.targetFile ?? 'system.md';
  if (!(PROMPT_TARGETS as readonly string[]).includes(targetFile)) throw new Error('Unsupported prompt target.');
  if (targetFile === 'tools/bash.md' && detectShell().kind === 'powershell')
    throw new Error('The bash prompt is overridden by PowerShell on this platform.');
  if (opts.maxModelCalls !== undefined && (!Number.isSafeInteger(opts.maxModelCalls) || opts.maxModelCalls < 0))
    throw new Error('maxModelCalls must be a nonnegative integer.');
  if (opts.maxTurns !== undefined && (!Number.isSafeInteger(opts.maxTurns) || opts.maxTurns < 1))
    throw new Error('maxTurns must be a positive integer.');
  const sourcePrompts = join(opts.runDir, 'prompts');
  promptHash(sourcePrompts);
  const manifest = readManifest(opts.runDir),
    dev = new Set(manifest.tasks.filter((t) => t.split === 'dev').map((t) => t.id)),
    records = readResults(opts.runDir)
      .filter((r) => dev.has(r.taskId))
      .map((r) => analyzable(r, opts.runDir))
      .filter((r): r is RecordWithSession => !!r),
    failures = records.filter((r) => r.result.status === 'fail'),
    controls = records.filter((r) => r.result.status === 'pass').slice(0, 2),
    temp = await mkdtemp(join(tmpdir(), 'mh-analyze-')),
    variantDir = join(opts.variantsDir, sessionId()),
    evidence: Evidence[] = [];
  let modelCalls = 0,
    usage = zeroUsage(),
    reason: AnalyzeReason = 'noChange',
    sessionPath: string | undefined;
  let proposal: Proposal = {
    hypothesis: 'There is insufficient repeated failure evidence for a prompt change.',
    targetFile,
    category: 'unknown',
    evidenceRefs: [],
    expectedImprovement: 'None established.',
    regressionRisk: 'Unverified changes may damage successful behavior.',
  };
  let errorDetail = '',
    proposalValidation: string[] = [];
  const optimizerPrompt = loadPrompts().analyze;
  try {
    await mkdir(join(temp, 'traces'));
    await mkdir(join(temp, 'evidence'));
    await copyPrompts(sourcePrompts, join(temp, 'prompts'));
    await writeFile(
      join(temp, 'results.jsonl'),
      failures
        .map(({ result }) => JSON.stringify({ ...result, sessionPath: `traces/${result.taskId}-${result.attempt}.md` }))
        .join('\n') + '\n',
    );
    for (const { result, entries } of [...failures, ...controls]) {
      const attempt = `${result.taskId}#${result.attempt}`,
        failure = result.status === 'fail';
      const checkRef = `${attempt}:check`;
      evidence.push({ ref: checkRef, attempt, failure });
      const sections = [
        `[${checkRef}] Final check: ${JSON.stringify({ status: result.status, exitCode: result.checkExitCode, output: result.checkOutputTail, judge: result.judge })}`,
      ];
      for (const entry of entries) {
        if (entry.type === 'header') continue;
        const ref = `${attempt}:${entry.id}`;
        evidence.push({ ref, attempt, failure });
        sections.push(`[${ref}]\n${renderSession([entry])}`);
      }
      await writeFile(join(temp, 'traces', `${result.taskId}-${result.attempt}.md`), sections.join('\n\n'));
    }
    await writeFile(join(temp, 'evidence/index.json'), JSON.stringify(evidence, null, 2));
    if (new Set(failures.map(({ result }) => `${result.taskId}#${result.attempt}`)).size < 2) {
      reason = failures.length ? 'insufficientEvidence' : 'noChange';
      await writeFile(
        join(temp, 'analysis.md'),
        '# Analysis\n\nFewer than two analyzable dev failures; prompts unchanged. Heldout, setup/harness failures and explicit provider interruptions were excluded.\n',
      );
    } else {
      const model = resolveModel(opts.config.model, opts.config.models, opts.config.provider);
      const baseProvider =
        opts.provider ?? (model.provider === 'anthropic' ? new AnthropicProvider() : new OpenAIProvider());
      let budgetReached = false;
      const provider: Provider = {
        id: baseProvider.id,
        async stream(request, signal, emit) {
          try {
            if (modelCalls >= (opts.maxModelCalls ?? Infinity))
              throw new Error('Optimizer model-call budget exhausted.');
            opts.onModelCall?.();
          } catch (error) {
            budgetReached = true;
            errorDetail = error instanceof Error ? error.message : String(error);
            return {
              role: 'assistant',
              content: [],
              model: request.model.id,
              provider: baseProvider.id,
              stopReason: 'error',
              errorMessage: errorDetail,
              usage: zeroUsage(),
            };
          }
          modelCalls++;
          const message = await baseProvider.stream(request, signal, emit);
          usage = addUsage(usage, message.usage);
          opts.onModelResult?.(message);
          return message;
        },
      };
      const session = createSession(join(temp, 'home'), temp);
      try {
        const run = await startRun({
          cwd: temp,
          home: join(temp, 'home'),
          session,
          config: {
            ...opts.config,
            promptsDir: defaultPromptsDir,
            hooks: { afterEdit: [], onStop: [], maxStopContinuations: 0 },
            compaction: { ...opts.config.compaction, enabled: false },
          },
          prompt: `Please analyze the dev evidence. Target: prompts/${targetFile}. Candidate ${opts.candidateIndex ?? 1}.\nWrite analysis.md and proposal.json; edit only the selected prompt if a repeated prompt cause is supported.\nAvailable inputs:\nresults.jsonl\nevidence/index.json\n${[...failures, ...controls].map(({ result }) => `traces/${result.taskId}-${result.attempt}.md`).join('\n')}\n${PROMPT_FILES.map((file) => `prompts/${file}`).join('\n')}`,
          systemOverride: optimizerPrompt,
          includeProjectInstructions: false,
          toolsFilter: ['read', 'write', 'edit'],
          strictReadRoots: [
            join(temp, 'evidence'),
            join(temp, 'traces'),
            join(temp, 'results.jsonl'),
            join(temp, 'prompts'),
            join(temp, 'analysis.md'),
            join(temp, 'proposal.json'),
          ],
          strictWritePaths: [join(temp, 'prompts', targetFile), join(temp, 'analysis.md'), join(temp, 'proposal.json')],
          writeRoots: [temp],
          maxTurns: opts.maxTurns ?? 40,
          provider,
          signal: opts.signal,
        });
        reason = budgetReached ? 'modelCallBudget' : run.reason;
        if (run.reason !== 'done') errorDetail ||= run.finalText || `Analyze ended: ${reason}.`;
      } catch (error) {
        reason = budgetReached ? 'modelCallBudget' : 'error';
        errorDetail = error instanceof Error ? error.message : String(error);
      }
      await mkdir(variantDir, { recursive: true });
      sessionPath = join(variantDir, 'optimizer');
      await cp(session.dir, sessionPath, { recursive: true });
      try {
        const raw = await readFile(join(temp, 'proposal.json'), 'utf8');
        await writeFile(join(sessionPath, 'proposal.raw.json'), raw);
        const value: unknown = JSON.parse(raw);
        proposalValidation = proposalErrors(value, targetFile, evidence);
        if (!proposalValidation.length) proposal = value as Proposal;
      } catch {
        proposalValidation = ['Missing or invalid proposal.json.'];
      }
    }
    if (!proposalValidation.length && proposal.category !== 'prompt') {
      await copyPrompts(sourcePrompts, join(temp, 'prompts'));
      if (reason === 'done') reason = 'noChange';
    }
    const validation = validateCandidate({ baseDir: sourcePrompts, candidateDir: join(temp, 'prompts'), targetFile });
    validation.errors.push(...proposalValidation);
    if (proposal.category !== 'prompt') validation.errors.push('The proposal does not identify a prompt cause.');
    if (!['done', 'noChange', 'insufficientEvidence'].includes(reason))
      validation.errors.push(`Analyze did not complete: ${reason}.`);
    validation.valid = validation.errors.length === 0;
    let analysis: string;
    try {
      analysis = await readFile(join(temp, 'analysis.md'), 'utf8');
    } catch {
      analysis = '# Analysis\n\nNo analysis report was produced.\n';
    }
    if (errorDetail) analysis += `\nOptimizer stopped: ${errorDetail}\n`;
    await copyPrompts(join(temp, 'prompts'), variantDir);
    await writeFile(join(variantDir, 'analysis.md'), analysis);
    await writeFile(join(variantDir, 'proposal.json'), JSON.stringify(proposal, null, 2));
    const inputsDir = join(variantDir, 'optimizer', 'inputs');
    await mkdir(inputsDir, { recursive: true });
    await cp(join(temp, 'evidence'), join(inputsDir, 'evidence'), { recursive: true });
    await cp(join(temp, 'traces'), join(inputsDir, 'traces'), { recursive: true });
    await cp(join(temp, 'results.jsonl'), join(inputsDir, 'results.jsonl'));
    await writeFile(
      join(variantDir, 'optimizer.json'),
      JSON.stringify(
        {
          reason,
          modelCalls,
          usage,
          error: errorDetail || undefined,
          optimizerPromptHash: createHash('sha256').update(optimizerPrompt).digest('hex'),
          validation,
        },
        null,
        2,
      ),
    );
    return {
      variantDir,
      analysis,
      taskIds: [...new Set(failures.map(({ result }) => result.taskId))],
      sourceVariant: manifest.variant,
      proposal,
      validation,
      usage,
      modelCalls,
      ...(sessionPath ? { sessionPath } : {}),
      reason,
    };
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
