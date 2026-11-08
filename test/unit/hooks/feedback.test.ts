import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEditHook } from '../../../src/hooks/after-edit.ts';
import { stopCheckHook } from '../../../src/hooks/stop-check.ts';
import { runRalph } from '../../../src/app/ralph.ts';
import { defaultConfig } from '../../../src/app/config.ts';
import { createWriteTool } from '../../../src/tools/index.ts';
import { zeroUsage } from '../../../src/ai/index.ts';
import { scripted } from '../../helpers/fake-provider.ts';
import { withTmpDir } from '../../helpers/tmp.ts';
import { loadPrompts } from '../../../src/app/prompts.ts';
const tool = createWriteTool(''),
  result = { content: [{ type: 'text' as const, text: 'ok' }] };
const call = (path: string) => ({ type: 'toolCall' as const, id: 'a', name: 'write', args: { path, content: 'x' } });
const last = {
  role: 'assistant' as const,
  content: [],
  model: 'test',
  provider: 'anthropic' as const,
  stopReason: 'end' as const,
  usage: zeroUsage(),
};
const signal = () => new AbortController().signal;
test('runs only for matching glob', async () =>
  withTmpDir(async (d) => {
    const h = afterEditHook({
      cwd: d,
      commands: [{ match: '**/*.ts', command: 'node -e "process.exit(1)"' }],
      signal: signal(),
    });
    assert.equal(await h.afterTool!(call('a.js'), tool, result), result);
  }));
test('failure output appended with instruction', async () =>
  withTmpDir(async (d) => {
    const h = afterEditHook({
      cwd: d,
      commands: [{ command: 'node -e "console.log(\'bad\');process.exit(1)"' }],
      signal: signal(),
    });
    assert.match(JSON.stringify(await h.afterTool!(call('a.ts'), tool, result)), /bad.*Fix these problems/s);
  }));
test('success appends nothing', async () =>
  withTmpDir(async (d) => {
    const h = afterEditHook({
      cwd: d,
      commands: [{ command: 'node -e "console.log(\'success\')"' }],
      signal: signal(),
    });
    assert.equal(await h.afterTool!(call('a'), tool, result), result);
  }));
test('MH_FILE env set, no interpolation', async () =>
  withTmpDir(async (d) => {
    const name = '$(touch pwned).ts';
    const h = afterEditHook({
      cwd: d,
      commands: [{ command: "node -e \"require('fs').writeFileSync('env.txt',process.env.MH_FILE)\"" }],
      signal: signal(),
    });
    await h.afterTool!(call(name), tool, result);
    assert.equal(await readFile(join(d, 'env.txt'), 'utf8'), join(d, name));
    await assert.rejects(() => access(join(d, 'pwned')));
  }));
test('timeout reported', async () =>
  withTmpDir(async (d) => {
    const h = afterEditHook({
      cwd: d,
      commands: [{ command: 'node -e "setTimeout(()=>{},30000)"', timeoutSec: 1 }],
      signal: signal(),
    });
    assert.match(JSON.stringify(await h.afterTool!(call('a'), tool, result)), /timed out/);
  }));
test('passing checks stop', async () =>
  withTmpDir(async (d) => {
    const h = stopCheckHook({
      cwd: d,
      commands: [{ command: 'node -e "process.exit(0)"' }],
      maxContinuations: 2,
      template: loadPrompts().fragments.stopContinue,
      signal: signal(),
    });
    assert.equal((await h.onStop!(last)).action, 'stop');
  }));
test('failing check continues with output tail', async () =>
  withTmpDir(async (d) => {
    const h = stopCheckHook({
      cwd: d,
      commands: [{ command: 'node -e "console.log(\'fix me\');process.exit(1)"' }],
      maxContinuations: 2,
      template: loadPrompts().fragments.stopContinue,
      signal: signal(),
    });
    const r = await h.onStop!(last);
    assert.equal(r.action, 'continue');
    assert.match(r.action === 'continue' ? r.message : '', /fix me/);
  }));
test('exhausted after maxStopContinuations', async () =>
  withTmpDir(async (d) => {
    let exhausted = false;
    const h = stopCheckHook({
      cwd: d,
      commands: [{ command: 'node -e "process.exit(1)"' }],
      maxContinuations: 1,
      template: loadPrompts().fragments.stopContinue,
      signal: signal(),
      onExhausted: () => {
        exhausted = true;
      },
    });
    assert.equal((await h.onStop!(last)).action, 'continue');
    assert.equal((await h.onStop!(last)).action, 'stop');
    assert.ok(exhausted);
  }));
test('counter resets per run', async () =>
  withTmpDir(async (d) => {
    for (let i = 0; i < 2; i++) {
      const h = stopCheckHook({
        cwd: d,
        commands: [{ command: 'node -e "process.exit(1)"' }],
        maxContinuations: 1,
        template: loadPrompts().fragments.stopContinue,
        signal: signal(),
      });
      assert.equal((await h.onStop!(last)).action, 'continue');
    }
  }));
test('stops on success', async () =>
  withTmpDir(async (d) => {
    const r = await runRalph({
      cwd: d,
      home: join(d, 'home'),
      config: defaultConfig(),
      prompt: 'task',
      provider: scripted({ text: 'done' }),
      checkCommand: 'node -e "process.exit(0)"',
      maxIterations: 3,
    });
    assert.equal(r.reason, 'passed');
    assert.equal(r.iterations, 1);
  }));
test('stops at max-iter', async () =>
  withTmpDir(async (d) => {
    await writeFile(join(d, 'n'), '0');
    const check =
      "node -e \"const fs=require('fs');const n=Number(fs.readFileSync('n','utf8'))+1;fs.writeFileSync('n',String(n));console.log(n);process.exit(1)\"";
    const r = await runRalph({
      cwd: d,
      home: join(d, 'home'),
      config: defaultConfig(),
      prompt: 'task',
      provider: scripted({ text: 'a' }, { text: 'b' }),
      checkCommand: check,
      maxIterations: 2,
    });
    assert.equal(r.reason, 'maxIterations');
  }));
test('stops when same failure twice in a row', async () =>
  withTmpDir(async (d) => {
    const r = await runRalph({
      cwd: d,
      home: join(d, 'home'),
      config: defaultConfig(),
      prompt: 'task',
      provider: scripted({ text: 'a' }, { text: 'b' }),
      checkCommand: 'node -e "console.log(\'same\');process.exit(1)"',
      maxIterations: 5,
    });
    assert.equal(r.reason, 'stuck');
    assert.equal(r.iterations, 2);
  }));
test('each iteration starts a fresh context', async () =>
  withTmpDir(async (d) => {
    const p = scripted({ text: 'a' }, { text: 'b' });
    const r = await runRalph({
      cwd: d,
      home: join(d, 'home'),
      config: defaultConfig(),
      prompt: 'task',
      provider: p,
      checkCommand: 'node -e "process.exit(1)"',
      maxIterations: 2,
    });
    assert.equal(r.sessionIds.length, 2);
    assert.notEqual(r.sessionIds[0], r.sessionIds[1]);
    assert.ok(p.requests.every((r) => !r.messages.some((m) => m.role === 'assistant')));
  }));
test('progress file path is writable without ask', async () =>
  withTmpDir(async (d) => {
    const p = scripted(
      (req) => {
        const text = req.messages[0]!.content.find((b) => b.type === 'text');
        const path = (text?.type === 'text' ? text.text : '').match(/Read (.+) first/)?.[1];
        assert.ok(path);
        return { toolCalls: [{ name: 'write', args: { path, content: 'progress' } }] };
      },
      { text: 'done' },
    );
    const r = await runRalph({
      cwd: d,
      home: join(d, 'home'),
      config: defaultConfig(),
      prompt: 'task',
      provider: p,
      checkCommand: 'node -e "process.exit(0)"',
      maxIterations: 1,
    });
    assert.equal(await readFile(r.progressFile, 'utf8'), 'progress');
  }));
