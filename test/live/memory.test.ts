import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { startRun } from '../../src/app/run.ts';
import { runDream } from '../../src/app/dream.ts';
import { defaultConfig } from '../../src/app/config.ts';
import { withTmpDir } from '../helpers/tmp.ts';
if (process.env.MH_LIVE !== '1') test.skip('MH_LIVE not set: memory dreaming');
else
  test('live dream preserves a project fact for a fresh session', { timeout: 300000 }, async () =>
    withTmpDir(async (d) => {
      const config = defaultConfig();
      config.provider = process.env.MH_LIVE_PROVIDER === 'openai' ? 'openai' : 'anthropic';
      config.model = process.env.MH_LIVE_MODEL ?? 'step-5-preview';
      const home = join(d, 'home'),
        signal = AbortSignal.timeout(270000);
      const first = await startRun({
        cwd: d,
        home,
        config,
        prompt:
          'Remember this verified user preference for this project: the project codename is cobalt-731. Save it in persistent project memory and add it to the MEMORY.md index. Do not write project source files.',
        maxTurns: 10,
        signal,
      });
      assert.equal(first.reason, 'done');
      const dream = await runDream({ cwd: d, home, config, maxTurns: 15, signal });
      assert.equal(dream.reason, 'done');
      console.log('Dream changes: ' + (dream.diffStat || '(no changes needed)'));
      const next = await startRun({
        cwd: d,
        home,
        config,
        prompt:
          'What project codename did I previously ask you to remember? Consult your persistent project memory if needed.',
        maxTurns: 8,
        signal,
      });
      assert.equal(next.reason, 'done');
      assert.match(next.finalText, /cobalt-731/i);
    }),
  );
