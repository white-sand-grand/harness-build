import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { evaluateCandidate } from '../../../src/eval/gate.ts';
import { runEval, readResults, type EvalOptions } from '../../../src/eval/runner.ts';
import { defaultConfig } from '../../../src/app/config.ts';
import type { EvalTask } from '../../../src/eval/task.ts';
import { scripted } from '../../helpers/fake-provider.ts';
import { withTmpDir } from '../../helpers/tmp.ts';

type Behavior = 'pass' | 'fail' | 'error' | 'aborted' | 'maxTurns' | 'harnessError' | 'tamper';

async function task(dir: string, id = 'a', overrides: Partial<EvalTask> = {}) {
  const root = join(dir, 'tasks', id);
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
      split: 'dev',
      prompt: 'Fix answer.txt.',
      check: { command: 'node check.cjs' },
      protectedFiles: ['check.cjs'],
      maxTurns: 2,
      ...overrides,
    }),
  );
}

async function run(
  dir: string,
  name: string,
  behaviors: Record<string, Behavior | Behavior[]>,
  overrides: Partial<EvalOptions> = {},
) {
  const runDir = join(dir, name);
  await runEval({
    tasksDir: join(dir, 'tasks'),
    runDir,
    config: defaultConfig(),
    providerFactory: (task, attempt) => {
      const selected = behaviors[task.id] ?? 'fail',
        behavior = Array.isArray(selected) ? selected[attempt - 1] : selected;
      if (behavior === 'harnessError') throw new Error('provider setup failed');
      if (behavior === 'fail') return scripted({ text: 'done' });
      return scripted(
        {
          toolCalls: [
            { name: 'write', args: { path: 'answer.txt', content: 'fixed' } },
            ...(behavior === 'tamper'
              ? [{ name: 'write', args: { path: 'check.cjs', content: 'process.exit(0);\n' } }]
              : []),
          ],
        },
        behavior === 'maxTurns'
          ? { toolCalls: [{ name: 'read', args: { path: 'answer.txt' } }] }
          : { text: 'done', stopReason: behavior === 'error' || behavior === 'aborted' ? behavior : 'end' },
      );
    },
    ...overrides,
  });
  return runDir;
}

test('candidate gate pairs reordered attempts and recommends a verified dev improvement', async () =>
  withTmpDir(async (dir) => {
    await task(dir);
    const parent = await run(dir, 'parent', { a: ['fail', 'pass'] }, { repeat: 2 }),
      candidate = await run(dir, 'candidate', { a: 'pass' }, { repeat: 2 });
    await writeFile(
      join(candidate, 'results.jsonl'),
      readResults(candidate)
        .reverse()
        .map((row) => JSON.stringify(row))
        .join('\n') + '\n',
    );
    const result = evaluateCandidate(parent, candidate);
    assert.equal(result.decision, 'recommend');
    assert.deepEqual(result.improvements, ['a #1']);
    assert.deepEqual(result.regressions, []);
    assert.equal(result.comparison.heldout.a.attempts, 0);
  }));

test('candidate gate rejects a regression even when other dev attempts improve', async () =>
  withTmpDir(async (dir) => {
    await task(dir, 'a');
    await task(dir, 'b');
    const parent = await run(dir, 'parent', { a: 'pass', b: 'fail' }),
      candidate = await run(dir, 'candidate', { a: 'fail', b: 'pass' });
    const result = evaluateCandidate(parent, candidate);
    assert.equal(result.decision, 'reject');
    assert.deepEqual(result.improvements, ['b #1']);
    assert.deepEqual(result.regressions, ['a #1']);
  }));

test('candidate gate rejects unchanged quality', async () =>
  withTmpDir(async (dir) => {
    await task(dir);
    const parent = await run(dir, 'parent', { a: 'pass' }),
      candidate = await run(dir, 'candidate', { a: 'pass' });
    const result = evaluateCandidate(parent, candidate);
    assert.equal(result.decision, 'reject');
    assert.deepEqual(result.improvements, []);
    assert.match(result.reasons.join('\n'), /No paired dev attempt improved/);
  }));

for (const behavior of ['error', 'aborted', 'maxTurns', 'harnessError', 'tamper'] as const)
  test(`candidate gate treats ${behavior} in either run as inconclusive`, async () =>
    withTmpDir(async (dir) => {
      await task(dir);
      const parent = await run(dir, 'parent', { a: 'fail' }),
        candidate = await run(dir, 'candidate', { a: behavior });
      if (behavior === 'error' || behavior === 'aborted' || behavior === 'maxTurns') {
        assert.equal(readResults(candidate)[0]?.status, 'pass');
        assert.equal(readResults(candidate)[0]?.endReason, behavior);
      }
      assert.equal(evaluateCandidate(parent, candidate).decision, 'inconclusive');
      assert.equal(evaluateCandidate(candidate, parent).decision, 'inconclusive');
    }));

test('candidate gate treats setup failures as inconclusive', async () =>
  withTmpDir(async (dir) => {
    await task(dir, 'a', { setup: 'node -e "process.exit(1)"' });
    const runDir = await run(dir, 'setup-failure', { a: 'pass' });
    assert.equal(readResults(runDir)[0]?.status, 'setupError');
    assert.equal(evaluateCandidate(runDir, runDir).decision, 'inconclusive');
  }));

test('candidate gate treats an invalid judge verdict as inconclusive', async () =>
  withTmpDir(async (dir) => {
    await task(dir, 'a', { judge: { rubric: 'The answer must be fixed.' } });
    const runDir = await run(
      dir,
      'judge-failure',
      {},
      {
        providerFactory: () => scripted({ text: 'done' }, { text: 'invalid verdict' }),
      },
    );
    assert.ok('error' in readResults(runDir)[0]!.judge!);
    const result = evaluateCandidate(runDir, runDir);
    assert.equal(result.decision, 'inconclusive');
    assert.match(result.reasons.join('\n'), /judge did not return a valid verdict/);
  }));

test('candidate gate refuses comparisons with changed execution conditions', async () =>
  withTmpDir(async (dir) => {
    await task(dir);
    const parent = await run(dir, 'parent', { a: 'fail' }),
      candidate = await run(dir, 'candidate', { a: 'pass' }, { config: { ...defaultConfig(), thinking: 'low' } });
    const result = evaluateCandidate(parent, candidate);
    assert.equal(result.decision, 'inconclusive');
    assert.equal(result.comparison.comparable, false);
    assert.ok(result.reasons.length > 0);
  }));

test('candidate gate treats incomplete duplicate and unreadable results as inconclusive', async () =>
  withTmpDir(async (dir) => {
    await task(dir);
    const parent = await run(dir, 'parent', { a: 'fail' }),
      candidate = await run(dir, 'candidate', { a: 'pass' });
    const path = join(candidate, 'results.jsonl'),
      original = await readFile(path, 'utf8');
    for (const text of ['', original + original, '{invalid json}\n']) {
      await writeFile(path, text);
      assert.equal(evaluateCandidate(parent, candidate).decision, 'inconclusive');
    }
    await rm(path);
    assert.equal(evaluateCandidate(parent, candidate).decision, 'inconclusive');
  }));

test('candidate gate excludes heldout successes and regressions from selection', async () =>
  withTmpDir(async (dir) => {
    await task(dir, 'a');
    await task(dir, 'b', { split: 'heldout' });
    const parent = await run(dir, 'parent', { a: 'fail', b: 'pass' }),
      candidate = await run(dir, 'candidate', { a: 'pass', b: 'fail' });
    assert.equal(evaluateCandidate(parent, candidate).decision, 'recommend');
    assert.deepEqual(evaluateCandidate(parent, candidate).regressions, []);
    const unchanged = await run(dir, 'unchanged', { a: 'fail', b: 'fail' });
    assert.equal(evaluateCandidate(unchanged, parent).decision, 'reject');
  }));

test('candidate gate needs dev evidence even when heldout passes', async () =>
  withTmpDir(async (dir) => {
    await task(dir, 'a', { split: 'heldout' });
    const runDir = await run(dir, 'heldout-only', { a: 'pass' });
    assert.equal(evaluateCandidate(runDir, runDir).decision, 'inconclusive');
  }));
