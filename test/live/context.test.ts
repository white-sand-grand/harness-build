import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startRun } from '../../src/app/run.ts';
import { defaultConfig } from '../../src/app/config.ts';
import { withTmpDir } from '../helpers/tmp.ts';
if (process.env.MH_LIVE !== '1') test.skip('MH_LIVE not set: context compaction');
else
  test('live model continues after automatic context compaction', { timeout: 240000 }, async () =>
    withTmpDir(async (d) => {
      await writeFile(
        join(d, 'context.txt'),
        Array.from({ length: 1500 }, (_, i) => `line ${i}: background context for this test`).join('\n'),
      );
      const config = defaultConfig();
      config.provider = process.env.MH_LIVE_PROVIDER === 'openai' ? 'openai' : 'anthropic';
      config.model = process.env.MH_LIVE_MODEL ?? 'step-5-preview';
      config.models[config.model] = { provider: config.provider, contextWindow: 64000 };
      config.compaction = { enabled: true, clearAtRatio: 0.04, compactAtRatio: 0.05, keepRecentTokens: 500 };
      const r = await startRun({
        cwd: d,
        home: join(d, 'home'),
        config,
        prompt:
          'Use the read tool to read context.txt (not bash). After reading it, write done.txt with exactly "ok". Then verify it and finish.',
        maxTurns: 10,
        signal: AbortSignal.timeout(210000),
      });
      assert.equal(r.reason, 'done', r.finalText);
      assert.equal((await readFile(join(d, 'done.txt'), 'utf8')).trim(), 'ok');
      assert.ok(
        r.session.entries().some((e) => e.type === 'compaction'),
        'must have compacted automatically',
      );
    }),
  );
