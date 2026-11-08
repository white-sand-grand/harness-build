import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { OpenAIProvider, resolveModel } from '../../src/ai/index.ts';
import type { ModelRequest } from '../../src/ai/index.ts';

if (process.env.MH_LIVE !== '1' || process.env.MH_LIVE_CACHE !== '1')
  test.skip('MH_LIVE=1 and MH_LIVE_CACHE=1 required: gpt-6.1-sol prompt caching');
else
  test('live Sol gateway reuses a stable prefix across Responses calls', { timeout: 180000 }, async (t) => {
    assert.ok(process.env.OPENAI_API_KEY, 'Set OPENAI_API_KEY for the endpoint being tested.');
    const provider = new OpenAIProvider();
    const req: ModelRequest = {
      model: resolveModel('gpt-6.1-sol', { 'gpt-6.1-sol': { supportsThinking: true } }, 'openai'),
      system:
        'Use this project reference for both requests. Reply with OK only.\n\n' +
        (await readFile(new URL('../../README.md', import.meta.url), 'utf8')),
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Acknowledge the reference.' }] }],
      tools: [],
      thinking: 'low',
      maxOutputTokens: 1024,
    };
    const signal = AbortSignal.timeout(150000);
    const first = await provider.stream(req, signal, () => {});
    assert.equal(first.stopReason, 'end', first.errorMessage ?? 'First response did not complete.');
    req.messages.push(first, { role: 'user', content: [{ type: 'text', text: 'Acknowledge it once more.' }] });
    const second = await provider.stream(req, signal, () => {});
    t.diagnostic(
      JSON.stringify({
        first: { usage: first.usage, cache: first.cache },
        second: { usage: second.usage, cache: second.cache },
      }),
    );
    assert.equal(second.stopReason, 'end', second.errorMessage ?? 'Second response did not complete.');
    assert.equal(
      second.cache?.readReported,
      true,
      'The gateway did not report cached_tokens; cache reuse cannot be verified.',
    );
    assert.ok(
      second.usage.cacheRead > 0,
      'The endpoint reported zero cache reads. Check the cache diagnostics and gateway support.',
    );
  });
