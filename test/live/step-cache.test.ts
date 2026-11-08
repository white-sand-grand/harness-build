import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { AnthropicProvider, resolveModel } from '../../src/ai/index.ts';
import { buildAnthropicBody } from '../../src/ai/anthropic.ts';
import type { ModelRequest, AssistantMessage } from '../../src/ai/index.ts';

if (process.env.MH_LIVE !== '1' || process.env.MH_LIVE_STEP_CACHE !== '1')
  test.skip('MH_LIVE=1 and MH_LIVE_STEP_CACHE=1 required: StepFun prompt caching');
else
  test('live StepFun reuses identical and growing conversation prefixes', { timeout: 180000 }, async (t) => {
    const provider = new AnthropicProvider();
    const req: ModelRequest = {
      model: resolveModel(
        'step-5-preview',
        {
          'step-5-preview': { baseUrl: 'https://api.stepfun.com/step_plan/v1/messages' },
        },
        'anthropic',
      ),
      system:
        `Cache experiment ${randomUUID()}; this ID is unchanged across all three requests.\n` +
        'Use this coding-project reference and reply OK only.\n\n' +
        (await readFile(new URL('../../README.md', import.meta.url), 'utf8')),
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Acknowledge the project reference.' }] }],
      tools: [],
      thinking: 'off',
      maxOutputTokens: 1024,
    };
    const responses: AssistantMessage[] = [];
    const hashes: string[] = [];
    const signal = AbortSignal.timeout(150000);
    for (let index = 0; index < 3; index++) {
      if (index === 2)
        req.messages.push(responses[1]!, { role: 'user', content: [{ type: 'text', text: 'Confirm it once more.' }] });
      hashes.push(
        createHash('sha256')
          .update(JSON.stringify(buildAnthropicBody(req)))
          .digest('hex'),
      );
      const response = await provider.stream(req, signal, () => {});
      responses.push(response);
      t.diagnostic(JSON.stringify({ request: index + 1, usage: response.usage, cache: response.cache }));
      assert.equal(response.stopReason, 'end', response.errorMessage ?? 'Response did not complete.');
      if (index > 0) {
        assert.equal(response.cache?.readReported, true, 'StepFun did not report cache reads.');
        assert.ok(response.usage.cacheRead > 0, 'StepFun reported zero final cache reads.');
      }
    }
    assert.equal(hashes[0], hashes[1], 'The first two requests must be identical.');
  });
