import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AnthropicProvider,
  buildAnthropicBody,
  OpenAIProvider,
  cost,
  resolveModel,
  zeroUsage,
} from '../../../src/ai/index.ts';
import type { ModelRequest, Message, AssistantMessage } from '../../../src/ai/index.ts';
import { withRetry } from '../../../src/ai/retry.ts';
import { HTTPError } from '../../../src/ai/errors.ts';
import { withSSEServer, sse, anthropicFixture } from '../../helpers/sse-server.ts';
process.env.MH_TEST_API_KEY = 'test-only';
const req = (provider: 'anthropic' | 'openai' = 'anthropic', messages: Message[] = []): ModelRequest => ({
  model: resolveModel('test-model', { 'test-model': { provider, apiKeyEnv: 'MH_TEST_API_KEY' } }, provider),
  system: 'system',
  messages,
  tools: [{ name: 'read', description: 'read', parameters: { type: 'object' } }],
});
const assistant = (content: AssistantMessage['content']): AssistantMessage => ({
  role: 'assistant',
  content,
  usage: zeroUsage(),
  model: 'test',
  provider: 'openai',
  stopReason: 'end',
});
const result = (id: string): Message => ({
  role: 'toolResult',
  toolCallId: id,
  toolName: 'read',
  content: [{ type: 'text', text: 'result' }],
  isError: false,
});
test('merges consecutive tool results into one user message', () =>
  assert.equal(buildAnthropicBody(req('anthropic', [result('a'), result('b')])).messages.length, 1));
test('places cache_control on system, last tool, last user block', () => {
  const b = buildAnthropicBody(req('anthropic', [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]));
  assert.ok(b.system[0]?.cache_control);
  assert.ok(b.tools?.[0]?.cache_control);
  assert.ok(b.messages[0]?.content[0]?.cache_control);
  assert.equal(JSON.stringify(b).match(/cache_control/g)?.length, 3);
});
test('converts unsigned thinking to text block', () =>
  assert.match(
    JSON.stringify(buildAnthropicBody(req('anthropic', [assistant([{ type: 'thinking', text: 'x' }])]))),
    /<thinking>x/,
  ));
test('drops empty error assistant messages', () =>
  assert.equal(buildAnthropicBody(req('anthropic', [{ ...assistant([]), stopReason: 'error' }])).messages.length, 0));
test('keeps tool order stable', () => {
  const r = req();
  r.tools.push({ ...r.tools[0]!, name: 'write' });
  assert.deepEqual(
    buildAnthropicBody(r).tools?.map((t) => t.name),
    ['read', 'write'],
  );
});
for (const [name, blocks, stop] of [
  ['text only', [{ type: 'text', text: '' }], 'end_turn'],
  ['tool call with streamed json', [{ type: 'tool_use', id: 'a', name: 'read' }], 'tool_use'],
  [
    'multiple tool calls',
    [
      { type: 'tool_use', id: 'a', name: 'read' },
      { type: 'tool_use', id: 'b', name: 'write' },
    ],
    'tool_use',
  ],
  ['thinking with signature preserved', [{ type: 'thinking', thinking: '' }], 'end_turn'],
  ['invalid tool json → __invalidJson', [{ type: 'tool_use', id: 'a', name: 'read', raw: '{bad' }], 'tool_use'],
] as const)
  test(name, async () => {
    await withSSEServer(
      () => ({ chunks: anthropicFixture([...blocks], stop) }),
      async (url) => {
        const r = req();
        r.model.baseUrl = url;
        const out = await new AnthropicProvider().stream(r, new AbortController().signal, () => {});
        assert.notEqual(out.stopReason, 'error', out.errorMessage);
        if (name === 'text only') assert.equal(out.content[0]?.type === 'text' && out.content[0].text, 'hello');
        if (name === 'multiple tool calls') assert.equal(out.content.filter((b) => b.type === 'toolCall').length, 2);
        if (name === 'tool call with streamed json')
          assert.deepEqual(out.content[0]?.type === 'toolCall' && out.content[0].args, { path: 'a' });
        if (name === 'thinking with signature preserved')
          assert.equal(out.content[0]?.type === 'thinking' && out.content[0].signature, 'signed');
        if (name === 'invalid tool json → __invalidJson')
          assert.equal(out.content[0]?.type === 'toolCall' && out.content[0].args.__invalidJson, '{bad');
      },
    );
  });
test('maps usage incl. cache tokens', async () =>
  withSSEServer(
    () => ({ chunks: anthropicFixture([{ type: 'text' }]) }),
    async (url) => {
      const r = req();
      r.model.baseUrl = url;
      assert.deepEqual((await new AnthropicProvider().stream(r, new AbortController().signal, () => {})).usage, {
        input: 10,
        output: 7,
        cacheRead: 4,
        cacheWrite: 2,
      });
    },
  ));
for (const [name, start, final, expected] of [
  [
    'final Anthropic usage corrects a provisional cache hit to zero',
    { input_tokens: 1, output_tokens: 0, cache_read_input_tokens: 6812, cache_creation_input_tokens: 0 },
    { input_tokens: 6813, output_tokens: 394, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    { input: 6813, output: 394, cacheRead: 0, cacheWrite: 0 },
  ],
  [
    'final Anthropic usage supplies cache counters omitted at message start',
    { input_tokens: 6813, output_tokens: 0 },
    { input_tokens: 413, output_tokens: 209, cache_read_input_tokens: 6400, cache_creation_input_tokens: 0 },
    { input: 413, output: 209, cacheRead: 6400, cacheWrite: 0 },
  ],
] as const)
  test(name, async () =>
    withSSEServer(
      () => {
        const chunks = anthropicFixture([{ type: 'text' }]);
        chunks[0] = sse({ type: 'message_start', message: { usage: start } });
        chunks[chunks.length - 2] = sse({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: final });
        return { chunks };
      },
      async (url) => {
        const r = req();
        r.model.baseUrl = url;
        const result = await new AnthropicProvider().stream(r, new AbortController().signal, () => {});
        assert.deepEqual(result.usage, expected);
        assert.deepEqual(result.cache, { readReported: true, writeReported: true });
      },
    ),
  );
test('error event → stopReason error', async () =>
  withSSEServer(
    () => ({ chunks: [sse({ type: 'error', error: { message: 'bad model' } })] }),
    async (url) => {
      const r = req();
      r.model.baseUrl = url;
      assert.equal(
        (await new AnthropicProvider().stream(r, new AbortController().signal, () => {})).stopReason,
        'error',
      );
    },
  ));
test('HTTP 400 → error with body excerpt', async () =>
  withSSEServer(
    () => ({ status: 400, chunks: ['bad request'] }),
    async (url) => {
      const r = req();
      r.model.baseUrl = url;
      assert.match(
        (await new AnthropicProvider().stream(r, new AbortController().signal, () => {})).errorMessage!,
        /HTTP 400: bad request/,
      );
    },
  ));
test('retries 529 before first event then succeeds', async () => {
  let attempts = 0;
  await withSSEServer(
    (_, n) => {
      attempts = n;
      return n === 1 ? { status: 529, chunks: ['overloaded'] } : { chunks: anthropicFixture([{ type: 'text' }]) };
    },
    async (url) => {
      const r = req();
      r.model.baseUrl = url;
      assert.equal(
        (await new AnthropicProvider({ sleep: async () => {} }).stream(r, new AbortController().signal, () => {}))
          .stopReason,
        'end',
      );
    },
  );
  assert.equal(attempts, 2);
});
test('does not retry after first event', async () => {
  let attempts = 0;
  await withSSEServer(
    (_, n) => {
      attempts = n;
      return {
        chunks: [
          sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
          sse({ type: 'error', error: { message: 'broken' } }),
        ],
      };
    },
    async (url) => {
      const r = req();
      r.model.baseUrl = url;
      assert.equal(
        (await new AnthropicProvider({ sleep: async () => {} }).stream(r, new AbortController().signal, () => {}))
          .stopReason,
        'error',
      );
    },
  );
  assert.equal(attempts, 1);
});
test('honors retry-after', async () => {
  const waits: number[] = [];
  let i = 0;
  await withRetry(
    async () => {
      if (i++ === 0) throw new HTTPError(429, 'wait', '2');
      return 1;
    },
    {
      signal: new AbortController().signal,
      sleep: async (ms) => {
        waits.push(ms);
      },
    },
  );
  assert.deepEqual(waits, [2000]);
});
test('missing api key → actionable error', async () => {
  const r = req('openai');
  r.model.apiKeyEnv = 'MH_MISSING_TEST_KEY';
  assert.match(
    (await new OpenAIProvider().stream(r, new AbortController().signal, () => {})).errorMessage!,
    /Set MH_MISSING_TEST_KEY/,
  );
});
test('context overflow error is tagged', async () =>
  withSSEServer(
    () => ({ status: 400, chunks: ['context_length_exceeded'] }),
    async (url) => {
      const r = req('openai');
      r.model.baseUrl = url;
      assert.match(
        (await new OpenAIProvider().stream(r, new AbortController().signal, () => {})).errorMessage!,
        /^\[context_overflow\]/,
      );
    },
  ));
test('cost undefined without pricing', () => assert.equal(cost(zeroUsage(), req().model), undefined));
