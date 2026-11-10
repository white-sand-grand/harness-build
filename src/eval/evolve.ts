import { mkdirSync, writeFileSync, appendFileSync, readFileSync, renameSync } from 'node:fs';
import { cp, mkdir, copyFile } from 'node:fs/promises';
import { join, resolve, basename } from 'node:path';
import type { Provider } from '../ai/index.ts';
import type { Config } from '../app/config.ts';
import type { RuntimeSnapshot } from '../app/runtime.ts';
import { writePromptSelection } from '../app/prompt-selection.ts';
import { defaultPromptsDir } from '../app/prompts.ts';
import { detectShell } from '../util/process.ts';
import { isWithin, realPath } from '../util/paths.ts';
import { runEval, readManifest, readResults, type EvalOptions } from './runner.ts';
import { loadTasks } from './task.ts';
import { evidenceOptimizer, type PromptOptimizer } from './optimizer.ts';
import { writePromptArtifact } from './prompt-artifact.ts';
import { PROMPT_FILES, PROMPT_TARGETS, promptHash, validateCandidate, type PromptTarget } from './candidate.ts';
import { redactText } from './provenance.ts';
import { evaluateCandidate, type GateDecision } from './gate.ts';
import { compareRuns, renderComparison } from './compare.ts';
import { evolutionBudget, type EvolutionLimits } from './evolution-budget.ts';

export type EvolutionOptions = {
  tasksDir: string;
  outputDir: string;
  config: Config;
  runtimeSnapshot?: RuntimeSnapshot;
  optimizerConfig?: Config;
  optimizer?: PromptOptimizer;
  promptsDir?: string;
  pattern?: string;
  repeat?: number;
  concurrency?: number;
  maxRounds?: number;
  candidatesPerRound?: number;
  targets?: PromptTarget[];
  limits?: Partial<EvolutionLimits>;
  optimizerMaxTurns?: number;
  providerFactory?: EvalOptions['providerFactory'];
  optimizerProviderFactory?: (round: number, candidate: number) => Provider;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
};
type CandidateRecord = {
  id: string;
  parentId: string;
  round: number;
  targetFile: PromptTarget;
  proposalDir: string;
  hash?: string;
  promptsDir?: string;
  runDir?: string;
  decision: 'invalid' | GateDecision['decision'];
  reasons: string[];
};
type Audit = {
  status: 'passed' | 'rejected' | 'inconclusive' | 'unchanged' | 'notRun';
  baselineRun?: string;
  candidateRun?: string;
  reasons: string[];
};
export type EvolutionResult = {
  outputDir: string;
  decision: 'recommend' | 'unchanged' | 'reject' | 'inconclusive';
  stopReason: string;
  baselineRun: string;
  bestRun: string;
  bestPrompts: string;
  candidates: CandidateRecord[];
  confirmation?: { baselineRun: string; candidateRun: string; gate: GateDecision };
  audit: Audit;
  resources: ReturnType<ReturnType<typeof evolutionBudget>['snapshot']>;
  error?: string;
};
function json(path: string, value: unknown) {
  writeFileSync(path + '.tmp', JSON.stringify(value, null, 2) + '\n');
  renameSync(path + '.tmp', path);
}
async function copyPrompts(source: string, destination: string) {
  for (const file of PROMPT_FILES) {
    await mkdir(join(destination, file, '..'), { recursive: true });
    await copyFile(join(source, file), join(destination, file));
  }
}
export async function runEvolution(opts: EvolutionOptions): Promise<EvolutionResult> {
  if (opts.config.runtime && !opts.runtimeSnapshot)
    throw new Error('Runtime evolution requires a frozen runtimeSnapshot.');
  if (opts.runtimeSnapshot)
    opts = {
      ...opts,
      config: {
        ...opts.runtimeSnapshot.config,
        model: opts.config.model,
        provider: opts.config.provider,
        models: opts.config.models,
        thinking: opts.config.thinking,
      },
    };
  const output = resolve(opts.outputDir),
    repeat = opts.repeat ?? 2;
  const maxRounds = opts.maxRounds ?? 3,
    count = opts.candidatesPerRound ?? 2;
  const limits = { maxModelCalls: 200, maxTokens: 1000000, maxDurationSec: 1800, ...opts.limits };
  for (const [name, value] of Object.entries({
    repeat,
    maxRounds,
    candidatesPerRound: count,
    concurrency: opts.concurrency ?? 1,
    ...limits,
  }))
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer.`);
  if (limits.maxDurationSec > 2147483) throw new Error('maxDurationSec exceeds the timer limit.');
  const shell = detectShell();
  const activeTargets = PROMPT_TARGETS.filter(
    (file) =>
      file === 'system.md' ||
      !opts.runtimeSnapshot ||
      opts.runtimeSnapshot.profile.tools.includes(file.slice('tools/'.length, -'.md'.length)),
  );
  const targets =
    opts.targets ?? activeTargets.filter((file) => file !== 'tools/bash.md' || shell.kind !== 'powershell');
  if (!targets.length || targets.some((file) => !activeTargets.includes(file)))
    throw new Error('Invalid prompt targets.');
  if (shell.kind === 'powershell' && targets.includes('tools/bash.md'))
    throw new Error('The PowerShell fallback overrides tools/bash.md; choose another target.');
  const tasks = loadTasks(opts.tasksDir, { pattern: opts.pattern });
  if (!tasks.some((task) => task.split === 'dev')) throw new Error('Evolution requires development tasks.');
  const sourcePrompts = resolve(opts.promptsDir ?? opts.config.promptsDir ?? defaultPromptsDir);
  if (!opts.runtimeSnapshot || opts.promptsDir) promptHash(sourcePrompts);
  if ([resolve(opts.tasksDir), sourcePrompts].some((dir) => isWithin(realPath(dir), realPath(output))))
    throw new Error('Evolution output must be outside the task and source prompt directories.');
  mkdirSync(output, { recursive: true });
  const optimizerConfig = opts.optimizerConfig ?? opts.config,
    optimizer = opts.optimizer ?? evidenceOptimizer;
  writeFileSync(
    join(output, 'experiment.json'),
    JSON.stringify(
      {
        v: 1,
        createdAt: new Date().toISOString(),
        status: 'running',
        actor: { model: opts.config.model, provider: opts.config.provider },
        optimizer: {
          id: optimizer.id,
          version: optimizer.version,
          model: optimizerConfig.model,
          provider: optimizerConfig.provider,
        },
        repeat,
        maxRounds,
        candidatesPerRound: count,
        targets,
        limits,
        datasetRoles: { search: 'dev', selection: 'dev (reused)', audit: 'heldout (final only)' },
      },
      null,
      2,
    ) + '\n',
    { flag: 'wx' },
  );
  for (const file of ['resources.jsonl', 'candidates.jsonl', 'rounds.jsonl'])
    writeFileSync(join(output, file), '', { flag: 'wx' });
  const budget = evolutionBudget({
    limits,
    config: opts.config,
    optimizerConfig,
    signal: opts.signal,
    onRecord: (record) => appendFileSync(join(output, 'resources.jsonl'), JSON.stringify(record) + '\n'),
  });
  const baselinePrompts = join(output, 'baseline', 'prompts');
  const frozenTasks = join(output, 'tasks');
  const baselineRun = join(output, 'baseline', 'dev');
  let bestId = 'baseline',
    bestPrompts = baselinePrompts,
    bestRun = baselineRun,
    stopReason = 'maxRounds';
  let audit: Audit = { status: 'notRun', reasons: ['Search has not completed.'] };
  let confirmation: EvolutionResult['confirmation'];
  let error: string | undefined,
    bestParentHash: string | undefined,
    stagnant = 0;
  const candidates: CandidateRecord[] = [],
    hashes = new Set<string>();
  function record(candidate: CandidateRecord) {
    candidates.push(candidate);
    appendFileSync(join(output, 'candidates.jsonl'), JSON.stringify(candidate) + '\n');
  }
  async function evaluate(runDir: string, promptsDir: string, split: 'dev' | 'heldout') {
    opts.onProgress?.(`Evaluating ${split}: ${runDir}`);
    return runEval({
      tasksDir: frozenTasks,
      runDir,
      config: opts.config,
      runtimeSnapshot: opts.runtimeSnapshot,
      promptsDir,
      evaluatorPromptsDir: baselinePrompts,
      split,
      pattern: opts.pattern,
      repeat,
      concurrency: opts.concurrency ?? 1,
      providerFactory: opts.providerFactory,
      signal: budget.signal,
      onModelCall: (kind) => budget.before(kind),
      onModelResult: (kind, _task, _attempt, message) => budget.after(kind, message),
      onAttempt: (row) => opts.onProgress?.(`${row.taskId} #${row.attempt}: ${row.status} (${row.endReason})`),
    });
  }
  try {
    if (opts.runtimeSnapshot && !opts.promptsDir) writePromptSelection(opts.runtimeSnapshot.prompts, baselinePrompts);
    else await copyPrompts(sourcePrompts, baselinePrompts);
    await cp(resolve(opts.tasksDir), frozenTasks, { recursive: true });
    hashes.add(promptHash(baselinePrompts));
    const baseline = await evaluate(baselineRun, baselinePrompts, 'dev');
    if (
      baseline.length !== tasks.filter((task) => task.split === 'dev').length * repeat ||
      baseline.some(
        (row) =>
          row.endReason !== 'done' ||
          row.integrityError ||
          row.status === 'harnessError' ||
          row.status === 'setupError' ||
          (row.judge && 'error' in row.judge),
      )
    )
      throw new Error('Baseline execution was incomplete or unreliable; inspect the saved attempts.');
    const noFailures = baseline.every((row) => row.status === 'pass');
    if (noFailures) stopReason = 'noDevFailures';
    let exhaustedEvidence = false;
    for (let round = 1; round <= maxRounds && !budget.signal.aborted && !noFailures; round++) {
      const before = bestId;
      for (let index = 1; index <= count && !budget.signal.aborted; index++) {
        const targetFile = targets[((round - 1) * count + index - 1) % targets.length]!;
        opts.onProgress?.(`Proposing round ${round}, candidate ${index}: ${targetFile}`);
        const proposal = await optimizer.propose({
          runDir: bestRun,
          variantsDir: join(output, 'proposals', String(round)),
          config: optimizerConfig,
          provider: opts.optimizerProviderFactory?.(round, index),
          signal: budget.signal,
          targetFile,
          candidateIndex: index,
          maxTurns: opts.optimizerMaxTurns ?? 30,
          onModelCall: () => budget.before('optimizer'),
          onModelResult: (message) => budget.after('optimizer', message),
        });
        const candidate: CandidateRecord = {
          id: basename(proposal.variantDir),
          parentId: bestId,
          round,
          targetFile,
          proposalDir: proposal.variantDir,
          decision: 'invalid',
          reasons: [],
        };
        if (proposal.reason === 'insufficientEvidence' || proposal.reason === 'noChange') {
          candidate.reasons = [proposal.reason, ...proposal.validation.errors];
          record(candidate);
          if (proposal.reason === 'insufficientEvidence' || !proposal.taskIds.length) {
            exhaustedEvidence = true;
            break;
          }
          continue;
        }
        const validation = validateCandidate({
          baseDir: bestPrompts,
          candidateDir: proposal.variantDir,
          targetFile,
          seenHashes: hashes,
        });
        candidate.hash = validation.hash;
        if (proposal.reason !== 'done' || !proposal.validation.valid || !validation.valid) {
          candidate.reasons = [proposal.reason, ...proposal.validation.errors, ...validation.errors];
          record(candidate);
          if (proposal.reason !== 'done') throw new Error('Optimizer did not complete; inspect ' + proposal.variantDir);
          continue;
        }
        hashes.add(validation.hash);
        candidate.promptsDir = join(output, 'candidates', candidate.id, 'prompts');
        candidate.runDir = join(output, 'candidates', candidate.id, 'dev');
        await copyPrompts(proposal.variantDir, candidate.promptsDir);
        await evaluate(candidate.runDir, candidate.promptsDir, 'dev');
        const gate = evaluateCandidate(bestRun, candidate.runDir);
        candidate.decision = gate.decision;
        candidate.reasons = gate.reasons;
        record(candidate);
        json(join(output, 'candidates', candidate.id, 'gate.json'), gate);
        if (gate.decision === 'recommend') {
          bestParentHash = promptHash(bestPrompts);
          bestId = candidate.id;
          bestRun = candidate.runDir;
          bestPrompts = candidate.promptsDir;
        }
      }
      appendFileSync(join(output, 'rounds.jsonl'), JSON.stringify({ round, previousBest: before, bestId }) + '\n');
      if (exhaustedEvidence) {
        stopReason = 'insufficientEvidence';
        break;
      }
      stagnant = before === bestId ? stagnant + 1 : 0;
      if (stagnant >= 2) {
        stopReason = 'noImprovement';
        break;
      }
    }
    if (bestId !== 'baseline' && !budget.signal.aborted) {
      const confirmationBaseline = join(output, 'confirmation', 'baseline');
      const confirmationCandidate = join(output, 'confirmation', 'candidate');
      await evaluate(confirmationBaseline, baselinePrompts, 'dev');
      if (!budget.signal.aborted) {
        await evaluate(confirmationCandidate, bestPrompts, 'dev');
        confirmation = {
          baselineRun: confirmationBaseline,
          candidateRun: confirmationCandidate,
          gate: evaluateCandidate(confirmationBaseline, confirmationCandidate),
        };
        json(join(output, 'confirmation', 'gate.json'), confirmation.gate);
        if (confirmation.gate.decision !== 'recommend')
          audit = {
            status: 'notRun',
            reasons: ['Fresh paired dev confirmation did not establish improvement.', ...confirmation.gate.reasons],
          };
      }
    }
    if (!budget.signal.aborted && (!confirmation || confirmation.gate.decision === 'recommend')) {
      if (!tasks.some((task) => task.split === 'heldout')) {
        audit = {
          status: 'notRun',
          reasons: ['No heldout tasks matched; a final recommendation requires independent audit.'],
        };
      } else {
        const auditBaseline = join(output, 'audit', 'baseline');
        await evaluate(auditBaseline, baselinePrompts, 'heldout');
        audit = { status: 'unchanged', baselineRun: auditBaseline, reasons: ['The baseline remains selected.'] };
        if (bestId !== 'baseline' && !budget.signal.aborted) {
          const auditCandidate = join(output, 'audit', 'candidate');
          await evaluate(auditCandidate, bestPrompts, 'heldout');
          const comparison = compareRuns(auditBaseline, auditCandidate);
          const before = readResults(auditBaseline),
            after = readResults(auditCandidate);
          const regressions = before.filter(
            (row) =>
              row.status === 'pass' &&
              after.find((next) => next.taskId === row.taskId && next.attempt === row.attempt)?.status !== 'pass',
          );
          const unreliable = [...before, ...after].some(
            (row) =>
              row.endReason !== 'done' ||
              row.integrityError ||
              row.status === 'harnessError' ||
              row.status === 'setupError' ||
              (row.judge && 'error' in row.judge),
          );
          audit = {
            status: !comparison.comparable || unreliable ? 'inconclusive' : regressions.length ? 'rejected' : 'passed',
            baselineRun: auditBaseline,
            candidateRun: auditCandidate,
            reasons: [
              ...comparison.incompatibilities,
              ...(unreliable ? ['Audit execution was incomplete or unreliable.'] : []),
              ...regressions.map((row) => `Heldout regression: ${row.taskId} #${row.attempt}`),
            ],
          };
          json(join(output, 'audit', 'comparison.json'), comparison);
        } else if (readResults(auditBaseline).some((row) => row.endReason !== 'done' || row.status !== 'pass')) {
          audit.status = 'inconclusive';
          audit.reasons = ['The unchanged baseline has unresolved heldout failures.'];
        }
      }
    }
  } catch (caught) {
    error = redactText(caught instanceof Error ? caught.message : String(caught));
    stopReason = 'error';
  } finally {
    budget.close();
  }
  const resources = budget.snapshot();
  stopReason = resources.stopReason ?? stopReason;
  const decision =
    error || resources.stopReason || confirmation?.gate.decision === 'inconclusive' || audit.status === 'inconclusive'
      ? 'inconclusive'
      : audit.status === 'rejected' || confirmation?.gate.decision === 'reject'
        ? 'reject'
        : audit.status === 'notRun'
          ? 'inconclusive'
          : bestId === 'baseline'
            ? 'unchanged'
            : 'recommend';
  const result: EvolutionResult = {
    outputDir: output,
    decision,
    stopReason,
    baselineRun,
    bestRun,
    bestPrompts,
    candidates,
    ...(confirmation ? { confirmation } : {}),
    audit,
    resources,
    ...(error ? { error } : {}),
  };
  json(join(output, 'result.json'), result);
  let comparison = '';
  try {
    comparison = renderComparison(confirmation?.gate.comparison ?? compareRuns(baselineRun, bestRun));
    json(join(output, 'baseline-contract.json'), readManifest(baselineRun));
  } catch {
    /* Interrupted before a complete baseline was recorded. */
  }
  writeFileSync(join(output, 'report.md'), renderEvolution(result) + (comparison ? '\n\n' + comparison + '\n' : ''));
  const manifest = JSON.parse(readFileSync(join(output, 'experiment.json'), 'utf8')) as Record<string, unknown>;
  json(join(output, 'experiment.json'), { ...manifest, status: 'completed', decision, stopReason });
  if (decision === 'recommend' || decision === 'unchanged')
    writePromptArtifact({
      outputDir: output,
      promptsDir: decision === 'recommend' ? bestPrompts : baselinePrompts,
      decision,
      optimizer,
      parentHash: bestParentHash ?? promptHash(baselinePrompts),
    });
  opts.onProgress?.(`Evolution: ${decision}; ${stopReason}`);
  return result;
}
export function renderEvolution(result: EvolutionResult) {
  return `# Prompt evolution\n\nDecision: ${result.decision}\nStop: ${result.stopReason}\nSearch best prompts: ${result.bestPrompts}\nFresh dev confirmation: ${result.confirmation?.gate.decision ?? 'not needed'}\nAudit: ${result.audit.status}\n\nModel calls: ${JSON.stringify(result.resources.calls)}\nReported tokens: ${result.resources.totalTokens} (${result.resources.usageComplete ? 'complete' : 'incomplete'})\nCost: ${result.resources.cost === null ? 'unknown' : result.resources.cost}\n\n| Candidate | Parent | Target | Decision | Reasons |\n|---|---|---|---|---|\n${result.candidates.map((row) => `| ${row.id} | ${row.parentId} | ${row.targetFile} | ${row.decision} | ${row.reasons.join('; ').replaceAll('|', '/').replaceAll('\n', ' ')} |`).join('\n')}\n\n${result.audit.reasons.join('\n')}\n${result.error ?? ''}\n\nDevelopment data was reused for search and selection. Heldout was reserved for the final audit; do not reuse its failures for another independent claim. Model-call counts are provider invocations, not HTTP retries. Already running requests may exceed the reported-token stop threshold.\n`;
}
