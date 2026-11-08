import test from 'node:test';
import assert from 'node:assert/strict';
import { checkFile } from '../../scripts/check-layers.ts';
test('rejects agent importing tools', () =>
  assert.equal(checkFile('src/agent/loop.ts', "import x from '../tools/bash.ts';").length, 1));
test('rejects same-rank cross import (tools → context)', () =>
  assert.equal(checkFile('src/tools/read.ts', "import x from '../context/offload.ts';").length, 1));
test('allows importing lower rank', () =>
  assert.deepEqual(checkFile('src/tools/read.ts', "import type {X} from '../agent/types.ts';"), []));
test('rejects node:fs in agent/', () =>
  assert.equal(checkFile('src/agent/loop.ts', "import fs from 'node:fs/promises';").length, 1));
test('rejects process.chdir anywhere', () =>
  assert.equal(checkFile('src/cli/main.ts', "process.chdir('/tmp');").length, 1));
test('rejects console.log outside cli/', () =>
  assert.equal(checkFile('src/app/run.ts', "console.log('hello');").length, 1));
test('allows same-directory import', () =>
  assert.deepEqual(checkFile('src/tools/read.ts', "export * from './shared.ts';"), []));
