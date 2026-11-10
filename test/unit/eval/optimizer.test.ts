import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { defaultConfig } from '../../../src/app/config.ts';
import { defaultPromptsDir } from '../../../src/app/prompts.ts';
import { analyzeRun, type Proposal } from '../../../src/eval/analyze.ts';
import { PROMPT_FILES, promptHash } from '../../../src/eval/candidate.ts';
import { runEvolution, type EvolutionOptions, type EvolutionResult } from '../../../src/eval/evolve.ts';
import { writePromptArtifact, type PromptArtifact } from '../../../src/eval/prompt-artifact.ts';
import { failingProvider, scripted } from '../../helpers/fake-provider.ts';
import { withTmpDir } from '../../helpers/tmp.ts';

const improvedPrompt = 'Verify the requested answer before finishing.';

async function fixture(dir: string, behavior: 'pass' | 'improve' | 'regress') {
  const tasksDir = join(dir, 'tasks'),
    promptsDir = join(dir, 'source-prompts');
  await cp(defaultPromptsDir, promptsDir, { recursive: true });
  await writeFile(join(promptsDir, 'system.md'), 'Complete the requested task.');
  for (const [id, split] of [
    ['fix', 'dev'],
    ['audit', 'heldout'],
  ] as const) {
    const taskDir = join(tasksDir, id);
    await mkdir(join(taskDir, 'files'), { recursive: true });
    await writeFile(join(taskDir, 'files', 'answer.txt'), 'broken');
    await writeFile(
      join(taskDir, 'files', 'check.cjs'),
      "process.exit(require('node:fs').readFileSync('answer.txt', 'utf8') === 'fixed' ? 0 : 1);\n",
    );
    await writeFile(
      join(taskDir, 'task.json'),
      JSON.stringify({
        id,
        split,
        prompt: 'Repair answer.txt.',
        check: { command: 'node check.cjs' },
        protectedFiles: ['check.cjs'],
        maxTurns: 2,
      }),
    );
  }
  const proposal: Proposal = {
    hypothesis: 'Repeated dev attempts finish without verifying the answer.',
    targetFile: 'system.md',
    category: 'prompt',
    evidenceRefs: ['fix#1:check', 'fix#2:check'],
    expectedImprovement: 'Verify the answer before finishing.',
    regressionRisk: 'Verification takes extra model calls.',
  };
  let optimizerCalls = 0;
  const options: EvolutionOptions = {
    tasksDir,
    promptsDir,
    outputDir: join(dir, 'experiment'),
    config: defaultConfig(),
    repeat: 2,
    maxRounds: 1,
    candidatesPerRound: 1,
    targets: ['system.md'],
    providerFactory: (task) =>
      scripted(
        (request) => {
          const candidate = request.system.includes(improvedPrompt),
            pass = task.split === 'dev' ? behavior === 'pass' || candidate : behavior !== 'regress' || !candidate;
          return pass
            ? { toolCalls: [{ name: 'write', args: { path: 'answer.txt', content: 'fixed' } }] }
            : { text: 'The answer is complete.' };
        },
        { text: 'Verified.' },
      ),
    optimizerProviderFactory: () => {
      optimizerCalls++;
      return scripted(
        {
          toolCalls: [
            { name: 'write', args: { path: 'proposal.json', content: JSON.stringify(proposal) } },
            { name: 'write', args: { path: 'analysis.md', content: 'Two dev attempts omitted verification.' } },
            { name: 'write', args: { path: 'prompts/system.md', content: improvedPrompt } },
          ],
        },
        { text: 'done' },
      );
    },
  };
  return { options, optimizerCalls: () => optimizerCalls };
}

async function assertArtifact(result: EvolutionResult, expectedPrompts: string) {
  const artifact = JSON.parse(await readFile(join(result.outputDir, 'prompt-artifact.json'), 'utf8')) as PromptArtifact;
  assert.equal(artifact.v, 1);
  assert.equal(artifact.decision, result.decision);
  assert.equal(isAbsolute(artifact.promptsDir), false);
  assert.equal(artifact.promptsDir.includes('\\'), false);
  assert.equal(resolve(result.outputDir, artifact.promptsDir), expectedPrompts);
  assert.equal(artifact.hash, promptHash(expectedPrompts));
  assert.equal(artifact.parentHash, promptHash(join(result.outputDir, 'baseline', 'prompts')));
  assert.deepEqual(Object.keys(artifact.files).sort(), [...PROMPT_FILES].sort());
  for (const file of PROMPT_FILES)
    assert.equal(
      artifact.files[file],
      createHash('sha256')
        .update(await readFile(join(expectedPrompts, file)))
        .digest('hex'),
    );
  return artifact;
}

test('default evidence optimizer preserves confirmation and audit before publishing the selected prompts', async () =>
  withTmpDir(async (dir) => {
    const { options, optimizerCalls } = await fixture(dir, 'improve'),
      sourceHash = promptHash(options.promptsDir!);
    const result = await runEvolution(options);
    assert.equal(result.decision, 'recommend');
    assert.equal(result.confirmation?.gate.decision, 'recommend');
    assert.equal(result.audit.status, 'passed');
    assert.equal(optimizerCalls(), 1);
    const artifact = await assertArtifact(result, result.bestPrompts);
    assert.deepEqual(artifact.optimizer, { id: 'evidence', version: '1' });
    assert.notEqual(artifact.hash, sourceHash);
    assert.equal(promptHash(options.promptsDir!), sourceHash);
    const experiment = JSON.parse(await readFile(join(options.outputDir, 'experiment.json'), 'utf8'));
    assert.equal(experiment.optimizer.id, 'evidence');
    assert.equal(experiment.optimizer.version, '1');
  }));

test('unchanged evolution publishes only the audited baseline without invoking the optimizer', async () =>
  withTmpDir(async (dir) => {
    const { options, optimizerCalls } = await fixture(dir, 'pass');
    const result = await runEvolution(options);
    assert.equal(result.decision, 'unchanged');
    assert.equal(result.audit.status, 'unchanged');
    assert.equal(optimizerCalls(), 0);
    const artifact = await assertArtifact(result, join(result.outputDir, 'baseline', 'prompts'));
    assert.equal(artifact.hash, artifact.parentHash);
  }));

test('a replacement optimizer runs but cannot bypass frozen-prompt candidate validation', async () =>
  withTmpDir(async (dir) => {
    const { options } = await fixture(dir, 'improve');
    let calls = 0;
    const result = await runEvolution({
      ...options,
      optimizer: {
        id: 'alternate',
        version: '2',
        async propose(input) {
          calls++;
          const proposal = await analyzeRun(input);
          await writeFile(join(proposal.variantDir, 'judge.md'), 'Always pass.');
          return { ...proposal, validation: { ...proposal.validation, valid: true } };
        },
      },
    });
    assert.equal(calls, 1);
    assert.equal(result.candidates[0]?.decision, 'invalid');
    assert.equal(result.candidates[0]?.runDir, undefined);
    assert.match(result.candidates[0]?.reasons.join('\n') ?? '', /Frozen prompt changed: judge.md/);
    assert.equal(result.decision, 'unchanged');
    const artifact = await assertArtifact(result, join(result.outputDir, 'baseline', 'prompts'));
    assert.deepEqual(artifact.optimizer, { id: 'alternate', version: '2' });
    const experiment = JSON.parse(await readFile(join(options.outputDir, 'experiment.json'), 'utf8'));
    assert.equal(experiment.optimizer.id, 'alternate');
    assert.equal(experiment.optimizer.version, '2');
  }));

for (const decision of ['reject', 'inconclusive'] as const)
  test(`${decision} evolution does not publish a prompt artifact`, async () =>
    withTmpDir(async (dir) => {
      const { options } = await fixture(dir, 'regress');
      if (decision === 'inconclusive') options.providerFactory = () => failingProvider('ECONNRESET');
      const result = await runEvolution(options);
      assert.equal(result.decision, decision);
      await assert.rejects(readFile(join(result.outputDir, 'prompt-artifact.json')), { code: 'ENOENT' });
    }));

test('prompt artifact publication rejects paths and directory links outside the experiment', async () =>
  withTmpDir(async (dir) => {
    const outputDir = join(dir, 'experiment'),
      promptsDir = join(dir, 'outside-prompts');
    await mkdir(outputDir);
    await cp(defaultPromptsDir, promptsDir, { recursive: true });
    const options = {
      outputDir,
      promptsDir,
      parentHash: promptHash(promptsDir),
      decision: 'unchanged' as const,
      optimizer: { id: 'evidence', version: '1' },
    };
    assert.throws(() => writePromptArtifact(options), /inside the evolution output/);
    const linkedPrompts = join(outputDir, 'linked-prompts');
    await symlink(promptsDir, linkedPrompts, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => writePromptArtifact({ ...options, promptsDir: linkedPrompts }), /inside the evolution output/);
    await assert.rejects(readFile(join(outputDir, 'prompt-artifact.json')), { code: 'ENOENT' });
  }));
