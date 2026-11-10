import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ModelRequest } from '../../../src/ai/index.ts';
import { defaultConfig } from '../../../src/app/config.ts';
import { defaultPromptsDir } from '../../../src/app/prompts.ts';
import type { Proposal } from '../../../src/eval/analyze.ts';
import { promptHash } from '../../../src/eval/candidate.ts';
import { runEvolution, type EvolutionOptions, type EvolutionResult } from '../../../src/eval/evolve.ts';
import { readResults } from '../../../src/eval/runner.ts';
import { failingProvider, scripted, type FakeProvider } from '../../helpers/fake-provider.ts';
import { withTmpDir } from '../../helpers/tmp.ts';

const improvedPrompt = 'Read the relevant files and verify every requested change before finishing.';
const heldoutSecret = 'PRIVATE_HELDOUT_TASK_73591';
type Behavior = 'baselinePass' | 'improve' | 'heldoutRegression' | 'noImprovement';

async function fixture(dir: string, behavior: Behavior) {
  const tasksDir = join(dir, 'tasks'),
    promptsDir = join(dir, 'prompts'),
    outputDir = join(dir, 'experiment');
  await cp(defaultPromptsDir, promptsDir, { recursive: true });
  await writeFile(join(promptsDir, 'system.md'), 'Work on the requested task.');
  for (const [id, split] of [
    ['fix', 'dev'],
    ['audit', 'heldout'],
  ] as const) {
    const root = join(tasksDir, id);
    await mkdir(join(root, 'files'), { recursive: true });
    await writeFile(join(root, 'files', 'answer.txt'), 'broken');
    await writeFile(
      join(root, 'files', 'check.cjs'),
      "process.exit(require('node:fs').readFileSync('answer.txt', 'utf8') === 'fixed' ? 0 : 1);\n",
    );
    await writeFile(
      join(root, 'task.json'),
      JSON.stringify({
        id,
        split,
        prompt: split === 'heldout' ? heldoutSecret : 'Repair the answer and verify it.',
        check: { command: 'node check.cjs' },
        protectedFiles: ['check.cjs'],
        maxTurns: 2,
      }),
    );
  }
  const optimizerProviders: FakeProvider[] = [],
    actors: Array<{ split: string; candidate: boolean }> = [];
  const options: EvolutionOptions = {
    tasksDir,
    promptsDir,
    outputDir,
    config: defaultConfig(),
    repeat: 2,
    maxRounds: 1,
    candidatesPerRound: 1,
    targets: ['system.md'],
    providerFactory: (task) =>
      scripted(
        (request) => {
          const candidate = request.system.includes(improvedPrompt);
          actors.push({ split: task.split, candidate });
          const pass =
            task.split === 'dev'
              ? behavior === 'baselinePass' || (candidate && behavior !== 'noImprovement')
              : behavior !== 'heldoutRegression' || !candidate;
          return pass
            ? { toolCalls: [{ name: 'write', args: { path: 'answer.txt', content: 'fixed' } }] }
            : { text: 'I finished without verifying the answer.' };
        },
        { text: 'Verified the answer.' },
      ),
    optimizerProviderFactory: () => {
      const provider = scripted(proposalWrites(), { text: 'done' });
      optimizerProviders.push(provider);
      return provider;
    },
  };
  return { options, actors, optimizerProviders };
}

function proposalWrites() {
  const proposal: Proposal = {
    hypothesis: 'Repeated attempts finish without checking the requested result.',
    targetFile: 'system.md',
    category: 'prompt',
    evidenceRefs: ['fix#1:check', 'fix#2:check'],
    expectedImprovement: 'Verify the changed files before finishing.',
    regressionRisk: 'Verification can consume extra model calls.',
  };
  return {
    toolCalls: [
      { name: 'write', args: { path: 'proposal.json', content: JSON.stringify(proposal) } },
      { name: 'write', args: { path: 'analysis.md', content: 'Two dev attempts stopped before verification.' } },
      { name: 'write', args: { path: 'prompts/system.md', content: improvedPrompt } },
    ],
  };
}

async function assertSaved(result: EvolutionResult) {
  assert.deepEqual(
    JSON.parse(await readFile(join(result.outputDir, 'result.json'), 'utf8')),
    JSON.parse(JSON.stringify(result)),
  );
  assert.match(await readFile(join(result.outputDir, 'report.md'), 'utf8'), new RegExp(`Decision: ${result.decision}`));
  assert.equal(JSON.parse(await readFile(join(result.outputDir, 'experiment.json'), 'utf8')).status, 'completed');
}

test('evolution keeps a passing baseline without optimizer calls and audits heldout once', async () =>
  withTmpDir(async (dir) => {
    const { options, actors, optimizerProviders } = await fixture(dir, 'baselinePass');
    const result = await runEvolution(options);
    assert.equal(result.decision, 'unchanged');
    assert.equal(result.audit.status, 'unchanged');
    assert.equal(result.bestRun, result.baselineRun);
    assert.equal(result.resources.calls.optimizer, 0);
    assert.equal(
      optimizerProviders.reduce((sum, provider) => sum + provider.requests.length, 0),
      0,
    );
    assert.equal(actors.filter((actor) => actor.split === 'heldout').length, 2);
    assert.ok(readResults(result.audit.baselineRun!).every((row) => row.taskId === 'audit' && row.status === 'pass'));
    await assertSaved(result);
  }));

test('evolution refuses to optimize from an unreliable baseline', async () =>
  withTmpDir(async (dir) => {
    const { options, optimizerProviders } = await fixture(dir, 'improve');
    const result = await runEvolution({ ...options, providerFactory: () => failingProvider('ECONNRESET') });
    assert.equal(result.decision, 'inconclusive');
    assert.equal(result.resources.calls.optimizer, 0);
    assert.equal(optimizerProviders.length, 0);
    assert.ok(readResults(result.baselineRun).every((row) => row.endReason === 'error'));
    await assertSaved(result);
  }));

test('evolution applies the candidate prompt and keeps heldout evidence outside the optimizer', async () =>
  withTmpDir(async (dir) => {
    const { options, actors } = await fixture(dir, 'improve');
    const defaultHash = promptHash(defaultPromptsDir),
      sourceHash = promptHash(options.promptsDir!);
    const requests: ModelRequest[] = [];
    options.optimizerProviderFactory = () =>
      scripted(
        (request) => {
          requests.push(request);
          assert.ok(!JSON.stringify(request).includes(heldoutSecret));
          return {
            toolCalls: [{ name: 'read', args: { path: join(options.outputDir, 'tasks', 'audit', 'task.json') } }],
          };
        },
        (request) => {
          requests.push(request);
          const response = request.messages.find((message) => message.role === 'toolResult');
          assert.equal(response?.role === 'toolResult' && response.isError, true);
          assert.ok(!JSON.stringify(request).includes(heldoutSecret));
          return proposalWrites();
        },
        { text: 'done' },
      );
    const result = await runEvolution(options);
    assert.equal(result.decision, 'recommend');
    assert.equal(result.audit.status, 'passed');
    assert.equal(result.candidates[0]?.decision, 'recommend');
    assert.notEqual(result.bestRun, result.baselineRun);
    assert.ok(actors.some((actor) => actor.split === 'dev' && actor.candidate));
    assert.ok(actors.some((actor) => actor.split === 'heldout' && actor.candidate));
    assert.equal(await readFile(join(result.bestPrompts, 'system.md'), 'utf8'), improvedPrompt);
    assert.equal(requests.length, 2);
    assert.equal(promptHash(defaultPromptsDir), defaultHash);
    assert.equal(promptHash(options.promptsDir!), sourceHash);
    await assertSaved(result);
  }));

test('evolution rejects a dev improvement that regresses on the final heldout audit', async () =>
  withTmpDir(async (dir) => {
    const { options, optimizerProviders } = await fixture(dir, 'heldoutRegression');
    const result = await runEvolution(options);
    assert.equal(result.candidates[0]?.decision, 'recommend');
    assert.equal(result.decision, 'reject');
    assert.equal(result.audit.status, 'rejected');
    assert.match(result.audit.reasons.join('\n'), /Heldout regression/);
    assert.ok(optimizerProviders.every((provider) => !JSON.stringify(provider.requests).includes(heldoutSecret)));
    assert.ok(readResults(result.audit.baselineRun!).every((row) => row.status === 'pass'));
    assert.ok(readResults(result.audit.candidateRun!).every((row) => row.status === 'fail'));
    await assertSaved(result);
  }));

test('evolution requires the apparent improvement to survive fresh dev confirmation', async () =>
  withTmpDir(async (dir) => {
    const { options } = await fixture(dir, 'improve'),
      actorFactory = options.providerFactory!;
    let baselineAttempts = 0,
      heldoutAttempts = 0;
    options.providerFactory = (task, attempt) => {
      if (task.split === 'heldout') {
        heldoutAttempts++;
        return actorFactory(task, attempt);
      }
      return scripted(
        (request) => {
          const candidate = request.system.includes(improvedPrompt);
          if (!candidate && ++baselineAttempts <= 2) return { text: 'An unlucky baseline attempt.' };
          return { toolCalls: [{ name: 'write', args: { path: 'answer.txt', content: 'fixed' } }] };
        },
        { text: 'Verified the answer.' },
      );
    };
    const result = await runEvolution(options);
    assert.equal(result.candidates[0]?.decision, 'recommend');
    assert.equal(result.confirmation?.gate.decision, 'reject');
    assert.equal(result.decision, 'reject');
    assert.equal(result.audit.status, 'notRun');
    assert.equal(heldoutAttempts, 0);
    assert.ok(readResults(result.confirmation!.baselineRun).every((row) => row.status === 'pass'));
    assert.ok(readResults(result.confirmation!.candidateRun).every((row) => row.status === 'pass'));
    await assertSaved(result);
  }));

test('evolution cannot recommend when both heldout judge responses are invalid', async () =>
  withTmpDir(async (dir) => {
    const { options } = await fixture(dir, 'improve'),
      taskPath = join(options.tasksDir, 'audit', 'task.json'),
      task = JSON.parse(await readFile(taskPath, 'utf8')),
      actorFactory = options.providerFactory!;
    await writeFile(taskPath, JSON.stringify({ ...task, judge: { rubric: 'The answer must be fixed.' } }));
    options.providerFactory = (task, attempt) =>
      task.split === 'dev'
        ? actorFactory(task, attempt)
        : scripted(
            { toolCalls: [{ name: 'write', args: { path: 'answer.txt', content: 'fixed' } }] },
            { text: 'Verified the answer.' },
            { text: 'This response is not a JSON verdict.' },
          );
    const result = await runEvolution(options);
    assert.equal(result.candidates[0]?.decision, 'recommend');
    for (const run of [result.audit.baselineRun!, result.audit.candidateRun!])
      assert.ok(readResults(run).every((row) => row.checkExitCode === 0 && row.judge && 'error' in row.judge));
    assert.equal(result.audit.status, 'inconclusive');
    assert.equal(result.decision, 'inconclusive');
    await assertSaved(result);
  }));

for (const [limit, stopReason] of [
  ['maxModelCalls', 'modelCallBudget'],
  ['maxTokens', 'tokenBudget'],
] as const)
  test(`evolution saves an inconclusive report when ${limit} is exhausted`, async () =>
    withTmpDir(async (dir) => {
      const { options } = await fixture(dir, 'improve'),
        defaultHash = promptHash(defaultPromptsDir),
        sourceHash = promptHash(options.promptsDir!);
      const result = await runEvolution({ ...options, limits: { [limit]: 1 } });
      assert.equal(result.decision, 'inconclusive');
      assert.equal(result.stopReason, stopReason);
      assert.equal(result.resources.calls.actor, 1);
      assert.equal(result.resources.calls.optimizer, 0);
      assert.equal(promptHash(defaultPromptsDir), defaultHash);
      assert.equal(promptHash(options.promptsDir!), sourceHash);
      await assertSaved(result);
    }));

test('evolution preserves partial evidence and reports inconclusive after interruption', async () =>
  withTmpDir(async (dir) => {
    const { options } = await fixture(dir, 'improve'),
      controller = new AbortController(),
      defaultHash = promptHash(defaultPromptsDir);
    const provider = scripted(() => {
      controller.abort();
      return { text: 'Interrupted response.' };
    });
    const result = await runEvolution({ ...options, signal: controller.signal, providerFactory: () => provider });
    assert.equal(result.decision, 'inconclusive');
    assert.equal(result.stopReason, 'aborted');
    assert.equal(provider.requests.length, 1);
    assert.equal(result.resources.calls.optimizer, 0);
    assert.equal(readResults(result.baselineRun)[0]?.endReason, 'aborted');
    assert.equal(promptHash(defaultPromptsDir), defaultHash);
    await assertSaved(result);
  }));

test('evolution does not reevaluate a duplicate candidate', async () =>
  withTmpDir(async (dir) => {
    const { options, actors, optimizerProviders } = await fixture(dir, 'noImprovement');
    const result = await runEvolution({ ...options, candidatesPerRound: 2 });
    assert.equal(result.candidates.length, 2);
    assert.equal(result.candidates[0]?.decision, 'reject');
    assert.equal(result.candidates[1]?.decision, 'invalid');
    assert.match(result.candidates[1]?.reasons.join('\n') ?? '', /Duplicate prompt content/);
    assert.equal(result.candidates[1]?.runDir, undefined);
    assert.equal(actors.filter((actor) => actor.split === 'dev' && actor.candidate).length, 2);
    assert.equal(optimizerProviders.length, 2);
    assert.ok(optimizerProviders.every((provider) => provider.requests.length > 0));
    await assertSaved(result);
  }));

test('evolution refuses to overwrite an existing experiment', async () =>
  withTmpDir(async (dir) => {
    const { options, actors } = await fixture(dir, 'baselinePass');
    await runEvolution(options);
    const resultPath = join(options.outputDir, 'result.json'),
      original = await readFile(resultPath, 'utf8'),
      actorAttempts = actors.length;
    await assert.rejects(runEvolution(options), /EEXIST|already exists/);
    assert.equal(await readFile(resultPath, 'utf8'), original);
    assert.equal(actors.length, actorAttempts);
  }));
