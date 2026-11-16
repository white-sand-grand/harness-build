import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runRalph } from '../../src/app/ralph.ts';
import { defaultConfig } from '../../src/app/config.ts';
import { listSessions } from '../../src/session/index.ts';
import { scripted } from '../helpers/fake-provider.ts';
import { withTmpDir } from '../helpers/tmp.ts';

test('Ralph resumes a persisted checkpoint and verifies manual fixes before calling the model', async () =>
  withTmpDir(async (d) => {
    const home = join(d, 'home'),
      config = defaultConfig();
    await writeFile(join(d, 'answer.txt'), 'no');
    await writeFile(join(d, 'check.cjs'), "process.exit(require('fs').readFileSync('answer.txt','utf8')==='yes'?0:1)");
    const first = await runRalph({
      cwd: d,
      home,
      config,
      prompt: 'Make the answer yes',
      checkCommand: 'node check.cjs',
      provider: scripted({ text: 'not yet' }),
      maxIterations: 1,
    });
    assert.equal(first.reason, 'maxIterations');
    assert.equal(first.verification, 'failed');
    await writeFile(join(d, 'answer.txt'), 'yes');
    const provider = scripted();
    const resumed = await runRalph({
      cwd: d,
      home,
      config,
      prompt: '',
      checkCommand: 'node check.cjs',
      checkpointSessionId: first.checkpointSessionId,
      provider,
    });
    assert.equal(resumed.reason, 'passed');
    assert.equal(resumed.verification, 'passed');
    assert.equal(provider.requests.length, 0);
    const value = JSON.parse(await readFile(resumed.checkpointFile!, 'utf8'));
    assert.equal(value.items[0].state, 'verified');
  }));

test('changed Ralph contracts and corrupted checkpoints cannot trigger commands or model calls', async () =>
  withTmpDir(async (d) => {
    const home = join(d, 'home'),
      config = defaultConfig();
    const first = await runRalph({
      cwd: d,
      home,
      config,
      prompt: 'task',
      checkCommand: 'node -e "process.exit(1)"',
      provider: scripted({ text: 'pending' }),
      maxIterations: 1,
    });
    const provider = scripted();
    const options = {
      cwd: d,
      home,
      config,
      prompt: '',
      checkCommand: 'node -e "process.exit(1)"',
      checkpointSessionId: first.checkpointSessionId,
      provider,
    };
    await assert.rejects(runRalph({ ...options, checkCommand: 'node -e "process.exit(0)"' }), /changed/);
    const raw = JSON.parse(await readFile(first.checkpointFile!, 'utf8'));
    raw.items[0].state = 'verified';
    await writeFile(first.checkpointFile!, JSON.stringify(raw));
    await assert.rejects(runRalph(options), /hash mismatch/);
    assert.equal(provider.requests.length, 0);
  }));

test('a passing Ralph check that keeps changing the workspace is not verified', async () =>
  withTmpDir(async (d) => {
    await writeFile(
      join(d, 'check.cjs'),
      "const fs=require('fs');const n=fs.existsSync('n')?+fs.readFileSync('n','utf8'):0;fs.writeFileSync('n',String(n+1));",
    );
    const result = await runRalph({
      cwd: d,
      home: join(d, 'home'),
      config: defaultConfig(),
      prompt: 'task',
      checkCommand: 'node check.cjs',
      provider: scripted({ text: 'done' }),
      maxIterations: 1,
    });
    assert.equal(result.verification, 'unknown');
    assert.equal(result.reason, 'maxIterations');
  }));

test('Ralph never replays a mutation whose result was lost before the checkpoint', async () =>
  withTmpDir(async (d) => {
    const home = join(d, 'home'),
      config = defaultConfig();
    const options = {
      cwd: d,
      home,
      config,
      prompt: 'write the answer',
      checkCommand: 'node -e "process.exit(0)"',
      maxIterations: 1,
    };
    await assert.rejects(
      runRalph({
        ...options,
        provider: scripted({ toolCalls: [{ name: 'write', args: { path: 'answer.txt', content: 'one write' } }] }),
        onEvent(event) {
          if (event.type === 'toolEnd' && event.call.name === 'write') throw new Error('lost result');
        },
      }),
      /lost result/,
    );
    const checkpointSessionId = listSessions(home, d)[0]!.id;
    const provider = scripted();
    await assert.rejects(runRalph({ ...options, prompt: '', checkpointSessionId, provider }), /needs_reconciliation/);
    assert.equal(provider.requests.length, 0);
    assert.equal(await readFile(join(d, 'answer.txt'), 'utf8'), 'one write');
  }));

test('Ralph carries actual user steering into its next fresh session and persisted goal', async () =>
  withTmpDir(async (d) => {
    let queued = true;
    const first = await runRalph({
      cwd: d,
      home: join(d, 'home'),
      config: defaultConfig(),
      prompt: 'Fix the module',
      checkCommand: 'node -e "process.exit(1)"',
      provider: scripted({ text: 'first' }, { text: 'updated' }),
      maxIterations: 1,
      getSteering: () =>
        queued
          ? ((queued = false), [{ role: 'user', content: [{ type: 'text', text: 'Keep the CommonJS interface' }] }])
          : [],
    });
    const provider = scripted({ text: 'continue' });
    await runRalph({
      cwd: d,
      home: join(d, 'home'),
      config: defaultConfig(),
      prompt: '',
      checkCommand: 'node -e "process.exit(1)"',
      checkpointSessionId: first.checkpointSessionId,
      provider,
      maxIterations: 1,
    });
    assert.match(JSON.stringify(provider.requests[0]?.messages), /Keep the CommonJS interface/);
  }));
