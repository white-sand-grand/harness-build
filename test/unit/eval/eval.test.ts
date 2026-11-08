import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, cp } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runEval, readResults } from '../../../src/eval/runner.ts';
import { parseJudge } from '../../../src/eval/judge.ts';
import { compareRuns } from '../../../src/eval/compare.ts';
import { analyzeRun } from '../../../src/eval/analyze.ts';
import { summarizeTrace } from '../../../src/eval/report.ts';
import { createSession } from '../../../src/session/index.ts';
import { defaultConfig } from '../../../src/app/config.ts';
import { defaultPromptsDir } from '../../../src/app/prompts.ts';
import { memoryDir } from '../../../src/memory/memory-dir.ts';
import { withTmpDir } from '../../helpers/tmp.ts';
import { scripted } from '../../helpers/fake-provider.ts';
import type { EvalTask } from '../../../src/eval/task.ts';
async function task(dir: string, id = 'a', override: Partial<EvalTask> = {}) {
  const root = join(dir, 'tasks', id);
  await mkdir(join(root, 'files'), { recursive: true });
  await writeFile(
    join(root, 'task.json'),
    JSON.stringify({
      id,
      split: 'dev',
      prompt: 'task ' + id,
      check: { command: 'node -e "process.exit(0)"' },
      ...override,
    }),
  );
  return root;
}
const options = (d: string) => ({
  tasksDir: join(d, 'tasks'),
  runDir: join(d, 'run'),
  config: defaultConfig(),
  providerFactory: () => scripted({ text: 'done' }),
});
test('summarizes turns, usage, tool errors, truncations, compactions from a session file', async () =>
  withTmpDir(async (d) => {
    const s = createSession(d, d);
    s.append({
      type: 'trace',
      name: 'turn',
      data: { turn: 1, usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 0 } },
    });
    s.append({ type: 'trace', name: 'tool', data: { name: 'read', durationMs: 20, isError: true, truncated: true } });
    s.append({ type: 'compaction', summary: 's', firstKeptEntryId: '', tokensBefore: 100 });
    s.append({ type: 'trace', name: 'agentEnd', data: { reason: 'done', cost: 0.1 } });
    const r = summarizeTrace(s.entries());
    assert.equal(r.turns, 1);
    assert.equal(r.usage.input, 10);
    assert.equal(r.toolErrors, 1);
    assert.equal(r.truncations, 1);
    assert.equal(r.compactions, 1);
    assert.equal(r.cost, 0.1);
  }));
test('pass when check exits 0', async () =>
  withTmpDir(async (d) => {
    await task(d);
    const r = await runEval(options(d));
    assert.equal(r[0]?.status, 'pass');
  }));
test('fail when check exits non-zero', async () =>
  withTmpDir(async (d) => {
    await task(d, 'a', { check: { command: 'node -e "process.exit(1)"' } });
    assert.equal((await runEval(options(d)))[0]?.status, 'fail');
  }));
test('setupError', async () =>
  withTmpDir(async (d) => {
    await task(d, 'a', { setup: 'node -e "process.exit(2)"' });
    assert.equal((await runEval(options(d)))[0]?.status, 'setupError');
  }));
test('harnessError when agent throws', async () =>
  withTmpDir(async (d) => {
    await task(d);
    assert.equal(
      (
        await runEval({
          ...options(d),
          providerFactory: () => {
            throw new Error('bug');
          },
        })
      )[0]?.status,
      'harnessError',
    );
  }));
test('isolated MH_HOME per run', async () =>
  withTmpDir(async (d) => {
    await task(d);
    const before = process.env.MH_HOME,
      r = await runEval(options(d));
    assert.ok(r[0]?.sessionPath.startsWith(join(d, 'run', 'homes')));
    assert.equal(process.env.MH_HOME, before);
  }));
test('concurrent attempts isolate MH_HOME in setup, tools, hooks, checks and nested CLI', async () =>
  withTmpDir(async (d) => {
    const root = await task(d, 'home-probe', {
      setup: 'node probe.cjs setup',
      check: { command: 'node probe.cjs check' },
    });
    const cli = fileURLToPath(new URL('../../../src/cli/main.ts', import.meta.url));
    await writeFile(
      join(root, 'files/probe.cjs'),
      `const fs = require('node:fs');
const stage = process.argv[2];
const observation = { home: process.env.MH_HOME };
if (stage === 'tool') observation.memory = require('node:child_process').execFileSync(
  process.execPath, [${JSON.stringify(cli)}, 'memory', 'path'], { encoding: 'utf8', windowsHide: true }
).trim();
fs.writeFileSync(stage + '.json', JSON.stringify(observation));
`,
    );
    const config = defaultConfig();
    config.hooks.afterEdit = [{ match: '*.txt', command: 'node probe.cjs after-edit' }];
    config.hooks.onStop = [{ command: 'node probe.cjs stop' }];
    const before = process.env.MH_HOME;
    const results = await runEval({
      ...options(d),
      config,
      repeat: 2,
      concurrency: 2,
      providerFactory: () =>
        scripted(
          {
            toolCalls: [
              { name: 'bash', args: { command: 'node probe.cjs tool' } },
              { name: 'write', args: { path: 'marker.txt', content: 'probe' } },
            ],
          },
          { text: 'done' },
        ),
    });
    assert.deepEqual(
      results.map((r) => r.status),
      ['pass', 'pass'],
    );
    for (const result of results) {
      const home = join(d, 'run', 'homes', 'home-probe', String(result.attempt));
      const workspace = join(d, 'run', 'workspaces', 'home-probe', String(result.attempt));
      for (const stage of ['setup', 'tool', 'after-edit', 'stop', 'check']) {
        const observed = JSON.parse(await readFile(join(workspace, stage + '.json'), 'utf8'));
        assert.equal(observed.home, home, `${stage} home for attempt ${result.attempt}`);
        if (stage === 'tool') assert.equal(observed.memory, memoryDir(home, workspace));
      }
    }
    assert.equal(process.env.MH_HOME, before);
  }));
test('variant prompts dir is used', async () =>
  withTmpDir(async (d) => {
    await task(d);
    const variant = join(d, 'variant');
    await cp(defaultPromptsDir, variant, { recursive: true });
    await writeFile(join(variant, 'system.md'), 'CUSTOM VARIANT');
    await runEval({
      ...options(d),
      promptsDir: variant,
      providerFactory: () =>
        scripted((req) => {
          assert.match(req.system, /CUSTOM VARIANT/);
          return { text: 'done' };
        }),
    });
  }));
test('concurrency 2 does not cross workspaces', async () =>
  withTmpDir(async (d) => {
    for (const id of ['a', 'b']) {
      const root = await task(d, id, { check: { command: 'node check.cjs' } });
      await writeFile(
        join(root, 'files/check.cjs'),
        `const assert=require('node:assert/strict');assert.equal(require('node:fs').readFileSync('marker','utf8'),${JSON.stringify(id)});`,
      );
    }
    const r = await runEval({
      ...options(d),
      concurrency: 2,
      providerFactory: (t) =>
        scripted({ toolCalls: [{ name: 'write', args: { path: 'marker', content: t.id } }] }, { text: 'done' }),
    });
    assert.deepEqual(
      r.map((r) => r.status),
      ['pass', 'pass'],
    );
    assert.notEqual(r[0]?.sessionPath, r[1]?.sessionPath);
  }));
test('results.jsonl schema matches AttemptResult', async () =>
  withTmpDir(async (d) => {
    await task(d);
    const r = await runEval(options(d));
    assert.deepEqual(readResults(join(d, 'run')), r);
    const a = r[0]!;
    for (const key of [
      'taskId',
      'attempt',
      'variant',
      'model',
      'status',
      'turns',
      'usage',
      'durationMs',
      'toolCalls',
      'toolErrors',
      'endReason',
      'sessionPath',
    ])
      assert.ok(Object.hasOwn(a, key), key);
  }));
test('parses first JSON object', () =>
  assert.deepEqual(parseJudge('Here: {"score":0.8,"pass":true,"reason":"brace } inside string"} trailing'), {
    score: 0.8,
    pass: true,
    reason: 'brace } inside string',
  }));
test('malformed judge reply → judge.error', () => assert.ok('error' in parseJudge('not JSON')));
test('reports per-split pass rate deltas', async () =>
  withTmpDir(async (d) => {
    await task(d, 'a');
    await task(d, 'b', { split: 'heldout' });
    await runEval(options(d));
    await runEval({ ...options(d), runDir: join(d, 'run2') });
    const r = compareRuns(join(d, 'run'), join(d, 'run2'));
    assert.equal(r.dev.a.passRate, 1);
    assert.equal(r.heldout.b.passRate, 1);
    assert.equal(r.dev.delta, 0);
  }));
test('only dev failures are included', async () =>
  withTmpDir(async (d) => {
    await task(d, 'a', { check: { command: 'node -e "process.exit(1)"' } });
    await task(d, 'b', { split: 'heldout', check: { command: 'node -e "process.exit(1)"' } });
    await runEval(options(d));
    const p = scripted(
      (req) => {
        const text = req.messages[0]!.content.find((b) => b.type === 'text');
        assert.match(text?.type === 'text' ? text.text : '', /analyze/);
        return { toolCalls: [{ name: 'read', args: { path: 'results.jsonl' } }] };
      },
      (req) => {
        const m = req.messages.at(-1);
        assert.equal(m?.role, 'toolResult');
        assert.match(JSON.stringify(m), /taskId.*a/);
        assert.ok(!JSON.stringify(m).includes('taskId\\\":\\\"b'));
        return { toolCalls: [{ name: 'write', args: { path: 'analysis.md', content: 'dev only' } }] };
      },
      { text: 'done' },
    );
    const r = await analyzeRun({
      runDir: join(d, 'run'),
      variantsDir: join(d, 'variants'),
      config: defaultConfig(),
      provider: p,
    });
    assert.deepEqual(r.taskIds, ['a']);
  }));
test('output written to variants dir, default prompts untouched', async () =>
  withTmpDir(async (d) => {
    await task(d, 'a', { check: { command: 'node -e "process.exit(1)"' } });
    await runEval(options(d));
    const before = await readFile(join(defaultPromptsDir, 'system.md'), 'utf8');
    const p = scripted(
      {
        toolCalls: [
          { name: 'write', args: { path: 'analysis.md', content: 'proposal' } },
          { name: 'write', args: { path: 'prompts/system.md', content: 'improved' } },
        ],
      },
      { text: 'done' },
    );
    const r = await analyzeRun({
      runDir: join(d, 'run'),
      variantsDir: join(d, 'variants'),
      config: defaultConfig(),
      provider: p,
    });
    assert.equal(await readFile(join(r.variantDir, 'system.md'), 'utf8'), 'improved');
    assert.equal(await readFile(join(defaultPromptsDir, 'system.md'), 'utf8'), before);
  }));
