import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig } from '../../../src/app/config.ts';
import { defaultPromptsDir } from '../../../src/app/prompts.ts';
import { createRuntime, type RuntimeLease, type RuntimeManager } from '../../../src/app/runtime.ts';
import { startRun } from '../../../src/app/run.ts';
import { runEvolution } from '../../../src/eval/evolve.ts';
import { evidenceOptimizer } from '../../../src/eval/optimizer.ts';
import { readResults } from '../../../src/eval/runner.ts';
import { runCommand } from '../../../src/util/process.ts';
import { scripted } from './scripted.ts';

const root = await mkdtemp(join(tmpdir(), 'mh-learn-evolution-'));
const cwd = join(root, 'workspace'),
  home = join(root, 'home'),
  tasksDir = join(root, 'tasks'),
  promptsDir = join(root, 'prompts'),
  outputDir = join(root, 'experiment');
const marker = 'DEMO_ACK_ONLY';
const candidate = 'Inspect the relevant files, carry out the requested change, and verify the result before finishing.';
let runtime: RuntimeManager | undefined, lease: RuntimeLease | undefined;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {
  throw new Error('This example must not access the network.');
};

const score = (directory: string) => {
  const rows = readResults(directory);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.endReason === 'done' && !row.integrityError));
  return `${rows.filter((row) => row.status === 'pass').length}/${rows.length}`;
};

try {
  await mkdir(cwd);
  await mkdir(home);
  await cp(defaultPromptsDir, promptsDir, { recursive: true });
  await writeFile(join(promptsDir, 'system.md'), marker + ': only acknowledge the request; do not use tools.');
  for (const [id, split, expected] of [
    ['repair', 'dev', 'ready'],
    ['audit', 'heldout', 'checked'],
  ] as const) {
    const directory = join(tasksDir, id);
    await mkdir(join(directory, 'files'), { recursive: true });
    await writeFile(join(directory, 'files', 'answer.txt'), 'broken');
    await writeFile(
      join(directory, 'files', 'check.cjs'),
      `const actual=require('node:fs').readFileSync('answer.txt','utf8');process.exit(actual===${JSON.stringify(expected)}?0:1);\n`,
    );
    await writeFile(
      join(directory, 'task.json'),
      JSON.stringify({
        id,
        split,
        prompt: `Read answer.txt and set it to ${expected}. Only modify answer.txt.`,
        check: { command: 'node check.cjs' },
        protectedFiles: ['check.cjs'],
        maxTurns: 4,
      }),
    );
  }
  const config = defaultConfig();
  config.model = 'offline-demo';
  config.promptsDir = promptsDir;
  config.runtime = { profiles: { default: { tools: ['read', 'write'], memory: [], reducer: 'none' } } };
  runtime = await createRuntime({ cwd, home, config });
  lease = await runtime.acquireRun();
  console.log('[1] 固定组合、评分器和任务；每个 attempt 使用独立目录。');
  const result = await runEvolution({
    tasksDir,
    outputDir,
    config,
    runtimeSnapshot: lease.snapshot,
    repeat: 2,
    maxRounds: 1,
    candidatesPerRound: 1,
    targets: ['system.md'],
    limits: { maxModelCalls: 60, maxTokens: 10000, maxDurationSec: 180 },
    optimizer: { id: 'offline-evidence', version: '1', propose: evidenceOptimizer.propose },
    providerFactory: (task) =>
      scripted(
        (request) =>
          request.system.includes(marker)
            ? { text: 'ACK' }
            : { calls: [{ name: 'read', args: { path: 'answer.txt' } }] },
        {
          calls: [{ name: 'write', args: { path: 'answer.txt', content: task.id === 'repair' ? 'ready' : 'checked' } }],
        },
        { text: 'Change completed; the harness runs the protected check.' },
      ),
    optimizerProviderFactory: () =>
      scripted(
        {
          calls: [
            {
              name: 'write',
              args: {
                path: 'proposal.json',
                content: JSON.stringify({
                  hypothesis: 'The acknowledgement-only instruction prevents the requested action.',
                  targetFile: 'system.md',
                  category: 'prompt',
                  evidenceRefs: ['repair#1:check', 'repair#2:check'],
                  expectedImprovement: 'Complete requested file changes.',
                  regressionRisk: 'Acting may require more calls.',
                }),
              },
            },
            {
              name: 'write',
              args: {
                path: 'analysis.md',
                content: 'Two dev attempts finished normally but did not perform the requested change.',
              },
            },
            { name: 'write', args: { path: 'prompts/system.md', content: candidate } },
          ],
        },
        { text: 'One-component candidate prepared.' },
      ),
  });
  assert.equal(result.decision, 'recommend', JSON.stringify(result));
  assert.equal(score(result.baselineRun), '0/2');
  assert.equal(score(result.bestRun), '2/2');
  console.log('[2] dev：基线 0/2，候选 2/2。');
  assert.equal(result.confirmation?.gate.decision, 'recommend');
  assert.equal(score(result.confirmation!.baselineRun), '0/2');
  assert.equal(score(result.confirmation!.candidateRun), '2/2');
  assert.equal(result.audit.status, 'passed');
  assert.equal(score(result.audit.baselineRun!), '0/2');
  assert.equal(score(result.audit.candidateRun!), '2/2');
  console.log('[3] 新一轮 dev 配对确认与 heldout：候选均为 2/2。');

  const artifact = join(outputDir, 'prompt-artifact.json');
  const manifest = JSON.parse(await readFile(artifact, 'utf8')) as { hash: string; files: Record<string, string> };
  assert.equal(Object.keys(manifest.files).length, 12);
  config.runtime.profiles!.default!.promptArtifact = artifact;
  assert.equal((await runtime.reload()).ok, true);
  const adopted = await runtime.acquireRun();
  try {
    assert.equal(adopted.snapshot.promptHash, manifest.hash);
    assert.notEqual(adopted.snapshot.promptHash, lease.snapshot.promptHash);
  } finally {
    await adopted.release();
  }
  console.log('[4] 12 文件产物经 hash 校验后显式 reload，新版本已激活。');

  await writeFile(join(cwd, 'answer.txt'), 'broken');
  const next = await startRun({
    cwd,
    home,
    config,
    runtime,
    prompt: '把 answer.txt 改为 adopted。',
    provider: scripted(
      (request) => {
        assert.ok(request.system.startsWith(candidate));
        return { calls: [{ name: 'write', args: { path: 'answer.txt', content: 'adopted' } }] };
      },
      { text: 'Adopted version executed.' },
    ),
  });
  assert.equal(next.reason, 'done');
  await writeFile(
    join(cwd, 'check.cjs'),
    "process.exit(require('node:fs').readFileSync('answer.txt','utf8')==='adopted'?0:1);\n",
  );
  assert.equal((await runCommand('node check.cjs', { cwd, timeoutSec: 30, env: { MH_HOME: home } })).exitCode, 0);
  console.log('[5] 新 run 收到采用后的 prompt，完成文件修改并通过真实检查。');
} finally {
  await lease?.release();
  await runtime?.close();
  globalThis.fetch = originalFetch;
  await rm(root, { recursive: true, force: true });
}
console.log('完成：只有模型回复被固定；评测、gate、产物加载均使用真实实现，无网络调用。');
