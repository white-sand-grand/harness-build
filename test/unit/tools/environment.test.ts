import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runCommand } from '../../../src/util/process.ts';
import { withTmpDir } from '../../helpers/tmp.ts';
test('shell children do not inherit Node test-runner control variables', async () =>
  withTmpDir(async (d) => {
    const r = await runCommand(
      'node -e "console.log(JSON.stringify(Object.keys(process.env).filter(k=>k.startsWith(\'NODE_TEST_\'))))"',
      { cwd: d },
    );
    assert.equal(r.exitCode, 0);
    assert.deepEqual(JSON.parse(r.output.trim()), []);
  }));
test('shell children do not inherit credential-looking variables but keep MH_HOME and PATH', async () =>
  withTmpDir(async (d) => {
    process.env.ADV_SECRETS_TOKEN = 'do-not-leak';
    process.env.ADV_API_KEY = 'do-not-leak-key';
    process.env.AWS_SECRET_ACCESS_KEY = 'do-not-leak-aws';
    const originalHome = process.env.MH_HOME;
    process.env.MH_HOME = d;
    try {
      const r = await runCommand(
        'node -e "const e=process.env;console.log(JSON.stringify({t:e.ADV_SECRETS_TOKEN,k:e.ADV_API_KEY,a:e.AWS_SECRET_ACCESS_KEY,h:e.MH_HOME,p:e.PATH!==undefined}))"',
        { cwd: d },
      );
      assert.equal(r.exitCode, 0);
      const seen = JSON.parse(r.output.trim()) as Record<string, unknown>;
      assert.equal(seen.t ?? null, null);
      assert.equal(seen.k ?? null, null);
      assert.equal(seen.a ?? null, null);
      assert.equal(seen.h, d);
      assert.equal(seen.p, true);
    } finally {
      delete process.env.ADV_SECRETS_TOKEN;
      delete process.env.ADV_API_KEY;
      delete process.env.AWS_SECRET_ACCESS_KEY;
      if (originalHome === undefined) delete process.env.MH_HOME;
      else process.env.MH_HOME = originalHome;
    }
  }));
test('node --test in a tool actually executes the child tests', async () =>
  withTmpDir(async (d) => {
    await writeFile(
      join(d, 'proof.test.cjs'),
      "require('node:test').test('child proof',()=>require('node:assert/strict').equal(2+3,5));\n",
    );
    const r = await runCommand('node --test', { cwd: d });
    assert.equal(r.exitCode, 0);
    assert.match(r.output, /child proof/);
    assert.match(r.output, /tests 1/);
  }));
