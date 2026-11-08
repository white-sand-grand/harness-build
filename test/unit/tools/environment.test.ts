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
