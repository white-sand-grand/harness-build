import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultConfig } from '../../../src/app/config.ts';
import { createRuntime, type RuntimeSnapshot } from '../../../src/app/runtime.ts';
import { defaultPromptsDir } from '../../../src/app/prompts.ts';
import { analyzeRun } from '../../../src/eval/analyze.ts';
import { compareRuns } from '../../../src/eval/compare.ts';
import { runEvolution } from '../../../src/eval/evolve.ts';
import { readManifest, runEval, type EvalOptions } from '../../../src/eval/runner.ts';
import type { EvalTask } from '../../../src/eval/task.ts';
import { scripted } from '../../helpers/fake-provider.ts';
import { withTmpDir } from '../../helpers/tmp.ts';

const baseSystem = 'RUNTIME_BASE_SYSTEM_8761';
const candidateSystem = 'RUNTIME_CANDIDATE_SYSTEM_4782';
const originalInstruction = 'ORIGINAL_PROJECT_INSTRUCTION_7244';
const taskInstruction = 'TASK_FIXTURE_INSTRUCTION_1653';

async function fixture(root: string) {
  const cwd = join(root, 'project'),
    home = join(root, 'home'),
    directory = join(root, 'plugin'),
    promptsDir = join(root, 'source-prompts'),
    tasksDir = join(root, 'tasks'),
    events = join(root, 'worker-events.txt');
  await Promise.all([
    mkdir(cwd, { recursive: true }),
    mkdir(home, { recursive: true }),
    mkdir(join(directory, 'lib'), { recursive: true }),
    mkdir(join(tasksDir, 'probe', 'files'), { recursive: true }),
    cp(defaultPromptsDir, promptsDir, { recursive: true }),
  ]);
  await writeFile(join(cwd, 'AGENTS.md'), originalInstruction);
  await writeFile(join(promptsDir, 'system.md'), baseSystem);
  await writeFile(join(tasksDir, 'probe', 'files', 'AGENTS.md'), taskInstruction);
  await writeFile(
    join(tasksDir, 'probe', 'task.json'),
    JSON.stringify({
      id: 'probe',
      split: 'dev',
      prompt: 'Explain the provided fixture without changing it.',
      check: { command: 'node -e "process.exit(0)"' },
      maxTurns: 2,
    } satisfies EvalTask),
  );
  await writeFile(
    join(directory, 'mh-plugin.json'),
    JSON.stringify({ id: 'counter', version: '1', module: 'plugin.mjs', files: ['plugin.mjs', 'lib/build.mjs'] }),
  );
  await writeFile(join(directory, 'lib', 'build.mjs'), `export const build = 'original';`);
  await writeFile(
    join(directory, 'plugin.mjs'),
    `import { appendFileSync } from 'node:fs';
import { build } from './lib/build.mjs';
const events = ${JSON.stringify(events)};
appendFileSync(events, 'load\\n');
let count = 0;
export default {
  id: 'counter', version: '1',
  context: [{ id: 'state', async provide() { return 'PLUGIN_COUNTER=' + (++count) + ';BUILD=' + build; } }],
  async dispose() { appendFileSync(events, 'dispose\\n'); }
};`,
  );
  const config = defaultConfig();
  config.promptsDir = promptsDir;
  config.runtime = {
    plugins: [directory],
    watch: false,
    profiles: {
      default: { tools: [], context: ['counter/state'], memory: [], reducer: 'none', hooks: [], prompts: [] },
    },
  };
  return { cwd, home, directory, promptsDir, tasksDir, events, config };
}

function options(f: Awaited<ReturnType<typeof fixture>>, snapshot: RuntimeSnapshot, runDir: string): EvalOptions {
  return {
    config: f.config,
    runtimeSnapshot: snapshot,
    tasksDir: f.tasksDir,
    runDir,
    providerFactory: () => scripted({ text: 'done' }),
  };
}

test('runtime evaluation isolates every worker, freezes authorized sources and uses task instructions', async () => {
  await withTmpDir(async (root) => {
    const f = await fixture(root);
    const manager = await createRuntime({ cwd: f.cwd, home: f.home, config: f.config, trustPlugins: true });
    const lease = await manager.acquireRun();
    try {
      assert.ok(lease.snapshot.instructions.some((entry) => entry.content.includes(originalInstruction)));
      let changed = false;
      const requests: string[] = [];
      const evaluate = async (runDir: string, promptsDir?: string) => {
        const rows = await runEval({
          ...options(f, lease.snapshot, runDir),
          promptsDir,
          repeat: 2,
          concurrency: 2,
          providerFactory: () => {
            if (!changed) {
              changed = true;
              writeFileSync(join(f.directory, 'lib', 'build.mjs'), `export const build = 'changed-development-file';`);
              writeFileSync(join(f.promptsDir, 'system.md'), 'CHANGED_SOURCE_SYSTEM');
            }
            return scripted((request) => {
              requests.push(request.system);
              assert.match(request.system, /PLUGIN_COUNTER=1;BUILD=original/);
              assert.ok(request.system.includes(taskInstruction));
              assert.ok(!request.system.includes(originalInstruction));
              assert.ok(!request.system.includes('CHANGED_SOURCE_SYSTEM'));
              assert.ok(request.system.includes(promptsDir ? candidateSystem : baseSystem));
              return { text: 'done' };
            });
          },
        });
        assert.deepEqual(
          rows.map((row) => [row.status, row.endReason]),
          [
            ['pass', 'done'],
            ['pass', 'done'],
          ],
        );
        for (const row of rows) {
          const pinned = join(
            runDir,
            'homes',
            'probe',
            String(row.attempt),
            'runtime',
            'plugins',
            lease.snapshot.plugins[0]!.fingerprint,
          );
          assert.equal(await readFile(join(pinned, 'lib', 'build.mjs'), 'utf8'), `export const build = 'original';`);
        }
      };
      const baseline = join(root, 'baseline');
      await evaluate(baseline);
      const variant = join(root, 'candidate-prompts');
      await cp(defaultPromptsDir, variant, { recursive: true });
      await writeFile(join(variant, 'system.md'), candidateSystem);
      const candidate = join(root, 'candidate');
      await evaluate(candidate, variant);
      assert.equal(requests.length, 4);
      const events = (await readFile(f.events, 'utf8')).trim().split('\n');
      assert.equal(events.filter((event) => event === 'load').length, 5);
      assert.equal(events.filter((event) => event === 'dispose').length, 4);
      assert.equal(readManifest(baseline).provenance!.contractHash, readManifest(candidate).provenance!.contractHash);
      assert.equal(compareRuns(baseline, candidate).comparable, true);
      assert.notEqual(
        await readFile(join(baseline, 'prompts', 'system.md'), 'utf8'),
        await readFile(join(candidate, 'prompts', 'system.md'), 'utf8'),
      );
    } finally {
      await lease.release();
      await manager.close();
    }
  });
});

test('complete runtime evaluations reject comparisons after plugin code or composition changes', async () => {
  await withTmpDir(async (root) => {
    const f = await fixture(root);
    const snapshots: Array<{ runDir: string; actorHash: string; fingerprint: string }> = [];
    for (const stage of ['original', 'changed-code', 'changed-composition'] as const) {
      if (stage === 'changed-code')
        await writeFile(join(f.directory, 'lib', 'build.mjs'), `export const build = 'changed';`);
      if (stage === 'changed-composition') f.config.runtime!.profiles!.default!.context = [];
      const manager = await createRuntime({ cwd: f.cwd, home: f.home, config: f.config, trustPlugins: true });
      const lease = await manager.acquireRun();
      try {
        const runDir = join(root, stage);
        const rows = await runEval(options(f, lease.snapshot, runDir));
        assert.equal(rows[0]!.status, 'pass');
        snapshots.push({
          runDir,
          actorHash: lease.snapshot.actorHash,
          fingerprint: lease.snapshot.plugins[0]!.fingerprint,
        });
      } finally {
        await lease.release();
        await manager.close();
      }
    }
    assert.notEqual(snapshots[0]!.fingerprint, snapshots[1]!.fingerprint);
    assert.equal(snapshots[1]!.fingerprint, snapshots[2]!.fingerprint);
    assert.notEqual(snapshots[0]!.actorHash, snapshots[1]!.actorHash);
    assert.notEqual(snapshots[1]!.actorHash, snapshots[2]!.actorHash);
    for (const [left, right] of [
      [snapshots[0]!, snapshots[1]!],
      [snapshots[1]!, snapshots[2]!],
    ] as const) {
      const comparison = compareRuns(left.runDir, right.runDir);
      assert.equal(comparison.comparable, false);
      assert.ok(comparison.incompatibilities.some((reason) => reason.includes('Experiment conditions differ')));
    }
  });
});

test('the restricted evidence optimizer never initializes configured external plugins', async () => {
  await withTmpDir(async (root) => {
    const f = await fixture(root);
    const taskFile = join(f.tasksDir, 'probe', 'task.json');
    const task = JSON.parse(await readFile(taskFile, 'utf8')) as EvalTask;
    await writeFile(taskFile, JSON.stringify({ ...task, check: { command: 'node -e "process.exit(1)"' } }));
    const config = defaultConfig();
    const baseline = join(root, 'evidence');
    const rows = await runEval({
      tasksDir: f.tasksDir,
      runDir: baseline,
      config,
      repeat: 2,
      providerFactory: () => scripted({ text: 'The answer is incomplete.' }),
    });
    assert.deepEqual(
      rows.map((row) => row.status),
      ['fail', 'fail'],
    );
    assert.equal(existsSync(f.events), false);
    const provider = scripted((request) => {
      assert.deepEqual(request.tools.map((tool) => tool.name).sort(), ['edit', 'read', 'write']);
      assert.ok(!request.system.includes('PLUGIN_COUNTER'));
      return { text: 'No candidate change is justified.' };
    });
    const result = await analyzeRun({
      runDir: baseline,
      variantsDir: join(root, 'variants'),
      config: f.config,
      provider,
    });
    assert.equal(provider.requests.length, 1);
    assert.notEqual(result.reason, 'error');
    assert.equal(existsSync(f.events), false);
  });
});

test('runtime evolution rejects explicit targets for tools omitted from the profile', async () => {
  await withTmpDir(async (root) => {
    const f = await fixture(root);
    const manager = await createRuntime({ cwd: f.cwd, home: f.home, config: f.config, trustPlugins: true });
    const lease = await manager.acquireRun();
    try {
      await assert.rejects(
        runEvolution({
          tasksDir: f.tasksDir,
          outputDir: join(root, 'evolution'),
          config: f.config,
          runtimeSnapshot: lease.snapshot,
          targets: ['tools/read.md'],
          providerFactory: () => {
            throw new Error('Actor must not run for an inactive target.');
          },
        }),
        /Invalid prompt targets|inactive|not enabled|not selected|not available|omitted/i,
      );
      const outputDir = join(root, 'default-targets');
      await runEvolution({
        tasksDir: f.tasksDir,
        outputDir,
        config: f.config,
        runtimeSnapshot: lease.snapshot,
        repeat: 1,
        maxRounds: 1,
        candidatesPerRound: 1,
        providerFactory: () => scripted({ text: 'done' }),
      });
      const experiment = JSON.parse(await readFile(join(outputDir, 'experiment.json'), 'utf8')) as {
        targets: string[];
      };
      assert.deepEqual(experiment.targets, ['system.md']);
    } finally {
      await lease.release();
      await manager.close();
    }
  });
});
