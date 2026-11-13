import test from 'node:test';
import assert from 'node:assert/strict';
import { AnthropicProvider, buildAnthropicBody, resolveModel, type ModelRequest } from '../../../src/ai/index.ts';
import { anthropicFixture } from '../../helpers/sse-server.ts';

const request = (baseUrl?: string): ModelRequest => ({
  model: {
    ...resolveModel('step-5-preview', {}, 'anthropic'),
    baseUrl,
    supportsThinking: true,
    maxOutputTokens: 4096,
  },
  system: 'A protocol mapping test.',
  messages: [],
  tools: [],
});

for (const thinking of ['low', 'medium', 'high'] as const)
  test(`Official Step Anthropic requests use ${thinking} output effort without a thinking budget`, () => {
    const body = buildAnthropicBody({ ...request('https://api.stepfun.com/step_plan'), thinking });
    assert.deepEqual(body.output_config, { effort: thinking });
    assert.equal(body.thinking, undefined);
    assert.equal(body.max_tokens, 4096);
  });

test('Official Step off and unsupported thinking omit all explicit thinking settings', () => {
  for (const enabled of [true, false]) {
    const req = request('https://api.stepfun.com/step_plan/v1/messages');
    req.model.supportsThinking = enabled;
    req.maxOutputTokens = 1500;
    req.thinking = enabled ? 'off' : 'high';
    const body = buildAnthropicBody(req);
    assert.equal(body.output_config, undefined);
    assert.equal(body.thinking, undefined);
    assert.equal(body.max_tokens, 1500);
  }
});

for (const baseUrl of ['https://api.anthropic.com', 'https://api.stepfun.com.evil.example', 'https://api-stepfun.com'])
  test(`Anthropic budget mapping stays unchanged for ${new URL(baseUrl).hostname}`, () => {
    const body = buildAnthropicBody({ ...request(baseUrl), thinking: 'high' });
    assert.deepEqual(body.thinking, { type: 'enabled', budget_tokens: 24576 });
    assert.equal(body.output_config, undefined);
    assert.equal(body.max_tokens, 25600);
  });

test('Resolved Anthropic endpoint controls Step effort mapping instead of a stale request URL', () => {
  const req = { ...request('https://api.anthropic.com'), thinking: 'medium' as const };
  assert.deepEqual(buildAnthropicBody(req, 'https://api.stepfun.com/step_plan').output_config, { effort: 'medium' });
  const step = { ...request('https://api.stepfun.com/step_plan'), thinking: 'low' as const };
  assert.deepEqual(buildAnthropicBody(step, 'http://127.0.0.1:12345').thinking, {
    type: 'enabled',
    budget_tokens: 2048,
  });
});

test('Anthropic stream passes its environment-resolved Step endpoint into body mapping without remote IO', async (t) => {
  const previous = process.env.ANTHROPIC_BASE_URL;
  process.env.ANTHROPIC_BASE_URL = 'https://api.stepfun.com/step_plan';
  let observed = false;
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(input), 'https://api.stepfun.com/step_plan/v1/messages');
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(body.output_config, { effort: 'low' });
    assert.equal(body.thinking, undefined);
    assert.equal(body.max_tokens, 4096);
    observed = true;
    return new Response(anthropicFixture([{ type: 'text' }]).join(''), {
      headers: { 'content-type': 'text/event-stream' },
    });
  });
  try {
    const result = await new AnthropicProvider({ apiKey: 'fixture-only-step-key' }).stream(
      { ...request(), thinking: 'low' },
      AbortSignal.timeout(5000),
      () => {},
    );
    assert.equal(result.stopReason, 'end', result.errorMessage);
    assert.equal(observed, true);
  } finally {
    if (previous === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = previous;
  }
});
