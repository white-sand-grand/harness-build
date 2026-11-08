import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { startRun } from '../../src/app/run.ts';
import { defaultConfig } from '../../src/app/config.ts';
import { scripted } from '../helpers/fake-provider.ts';
import { withTmpDir } from '../helpers/tmp.ts';
import { renderJSON } from '../../src/cli/render.ts';
test('print mode outputs final text', async () =>
  withTmpDir(async (d) => {
    const r = await startRun({
      cwd: d,
      home: d,
      config: defaultConfig(),
      prompt: 'hi',
      provider: scripted({ text: 'final' }),
    });
    assert.equal(r.finalText, 'final');
    assert.equal(r.reason, 'done');
  }));
test('json mode emits one event per line', async () =>
  withTmpDir(async (d) => {
    const lines: string[] = [];
    await startRun({
      cwd: d,
      home: d,
      config: defaultConfig(),
      prompt: 'hi',
      provider: scripted({ text: 'hello' }),
      onEvent: (e) => lines.push(renderJSON(e)),
    });
    assert.ok(lines.length > 3);
    for (const line of lines) assert.equal(typeof JSON.parse(line).type, 'string');
  }));
test('resume continues with previous messages', async () =>
  withTmpDir(async (d) => {
    const first = await startRun({
      cwd: d,
      home: d,
      config: defaultConfig(),
      prompt: 'first',
      provider: scripted({ text: 'one' }),
    });
    const p = scripted({ text: 'two' });
    await startRun({ cwd: d, home: d, config: defaultConfig(), prompt: 'second', provider: p, session: first.session });
    assert.equal(p.requests[0]?.messages.length, 3);
  }));
test('--help exits 0', () => {
  const r = spawnSync(process.execPath, ['src/cli/main.ts', '--help'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /mini-harness/);
});
test('unknown flag → usage error exit 2', () => {
  const r = spawnSync(process.execPath, ['src/cli/main.ts', '--nonexistent'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Unknown|unknown/);
});
