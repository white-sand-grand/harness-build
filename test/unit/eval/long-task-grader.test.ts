import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withTmpDir } from '../../helpers/tmp.ts';

test('the public Forth evaluateBoth case checks two independent instances rather than one shared dictionary', async () =>
  withTmpDir(async (d) => {
    const moduleUrl = new URL('../../live/long-task-grader.mjs', import.meta.url).href;
    const { grade } = await import(moduleUrl);
    const canonical = join(d, 'canonical');
    for (const name of ['forth', 'react', 'sgf-parsing']) {
      await mkdir(join(canonical, name), { recursive: true });
      await writeFile(
        join(canonical, name, 'canonical-data.json'),
        JSON.stringify({
          cases:
            name === 'forth'
              ? [
                  {
                    uuid: 'local-dictionary',
                    description: 'dictionary isolation',
                    property: 'evaluateBoth',
                    input: { instructionsFirst: [': + - ;', '1 1 +'], instructionsSecond: ['1 1 +'] },
                    expected: [[0], [2]],
                  },
                ]
              : [],
        }),
      );
    }
    for (const shared of [false, true]) {
      const candidate = join(d, shared ? 'shared' : 'local');
      await mkdir(candidate);
      await writeFile(
        join(candidate, 'forth.mjs'),
        `let globalMinus=false; export class Forth { constructor(){this.minus=false;this.stack=[]} evaluate(source){if(source===': + - ;'){${shared ? 'globalMinus' : 'this.minus'}=true;}else{this.stack.push(${shared ? 'globalMinus' : 'this.minus'}?0:2)}}}`,
      );
      const result = await grade(candidate, canonical);
      assert.equal(result.total, 1);
      assert.equal(result.passed, shared ? 0 : 1);
    }
  }));
