import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { withTmpDir } from '../helpers/tmp.ts';
import { runCommand } from '../../src/util/process.ts';
if (process.env.MH_LIVE !== '1') test.skip('MH_LIVE not set');
else
  test('live model fixes a failing test through the built CLI', { timeout: 240000 }, async () =>
    withTmpDir(async (d) => {
      await writeFile(join(d, 'add.cjs'), 'exports.add=(a,b)=>a-b;\n');
      await writeFile(
        join(d, 'add.test.cjs'),
        "const{test}=require('node:test');const assert=require('node:assert/strict');test('add',()=>assert.equal(require('./add.cjs').add(2,3),5));\n",
      );
      const home = join(d, 'home');
      await mkdir(home);
      const args = [
        'dist/cli/main.js',
        '-p',
        'Fix the failing test in this directory. Run the test, fix add.cjs, and verify with node --test.',
        '--provider',
        process.env.MH_LIVE_PROVIDER ?? 'anthropic',
        '--model',
        process.env.MH_LIVE_MODEL ?? 'step-5-preview',
        '--yolo',
        '--max-turns',
        '20',
        '--cwd',
        d,
      ];
      const child = spawn(process.execPath, args, {
        env: { ...process.env, MH_HOME: home },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout.setEncoding('utf8').on('data', (s) => (output += s));
      child.stderr.setEncoding('utf8').on('data', (s) => (output += s));
      const timer = setTimeout(() => child.kill(), 210000);
      const status = await new Promise<number | null>((resolve, reject) => {
        child.on('error', reject);
        child.on('close', resolve);
      });
      clearTimeout(timer);
      assert.equal(status, 0, output);
      const check = await runCommand('node --test', { cwd: d });
      assert.equal(check.exitCode, 0, check.output);
      assert.match(check.output, /tests 1/, 'the child test runner must execute the test');
    }),
  );
