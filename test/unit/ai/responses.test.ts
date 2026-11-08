import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOpenAIBody, OpenAIProvider, resolveModel, zeroUsage } from '../../../src/ai/index.ts';
import type { Message, ModelRequest, AssistantMessage } from '../../../src/ai/index.ts';
import { withSSEServer, sse } from '../../helpers/sse-server.ts';
process.env.MH_TEST_API_KEY = 'test-only';
const req = (messages: Message[] = []): ModelRequest => ({
  model: resolveModel('test', { test: { provider: 'openai', apiKeyEnv: 'MH_TEST_API_KEY' } }, 'openai'),
  system: 'system',
  messages,
  tools: [
    {
      name: 'read',
      description: 'read a file',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
  ],
});
const call = {
  type: 'function_call',
  id: 'fc_a',
  call_id: 'call_a',
  name: 'read',
  arguments: '{"path":"a"}',
  status: 'completed',
};
const textItem = {
  type: 'message',
  id: 'msg_a',
  role: 'assistant',
  status: 'completed',
  content: [{ type: 'output_text', text: 'hello', annotations: [] }],
};
const usage = { input_tokens: 20, output_tokens: 5, input_tokens_details: { cached_tokens: 4 } };
const end = (output: unknown[], type = 'response.completed', extra = {}) =>
  sse({
    type,
    response: {
      id: 'resp_a',
      status: type === 'response.completed' ? 'completed' : 'incomplete',
      output,
      usage,
      ...extra,
    },
  });
const functionChunks = [
  sse({ type: 'response.output_item.added', output_index: 0, item: { ...call, arguments: '', status: 'in_progress' } }),
  sse({ type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_a', delta: '{"pa' }),
  sse({ type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_a', delta: 'th":"a"}' }),
  sse({ type: 'response.output_item.done', output_index: 0, item: call }),
  end([call]),
];
test('Responses body uses instructions, input and flat function tools', () => {
  const b = buildOpenAIBody(req([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]));
  assert.equal(b.instructions, 'system');
  assert.ok(Array.isArray(b.input));
  assert.deepEqual(b.tools?.[0], {
    type: 'function',
    name: 'read',
    description: 'read a file',
    parameters: req().tools[0]!.parameters,
    strict: false,
  });
  assert.ok(!('messages' in b));
  assert.equal(b.store, false);
});
test('tool result images become Responses function outputs', () => {
  const b = buildOpenAIBody(
    req([
      {
        role: 'toolResult',
        toolCallId: 'a',
        toolName: 'read',
        content: [{ type: 'image', mediaType: 'image/png', data: 'AA==' }],
        isError: false,
      },
    ]),
  );
  const input = b.input[0];
  assert.equal(input?.type, 'function_call_output');
  assert.match(JSON.stringify(input), /input_image/);
  assert.equal(b.input.length, 1);
});
test('uses max_output_tokens for Responses', () => {
  const b = buildOpenAIBody(req());
  assert.equal(b.max_output_tokens, 8192);
  assert.ok(!('max_tokens' in b));
  assert.ok(!('max_completion_tokens' in b));
});
test('Responses body omits Chat stream_options', () => assert.ok(!('stream_options' in buildOpenAIBody(req()))));
test('aggregates function argument deltas by output index', async () =>
  withSSEServer(
    (_, __, request) => {
      assert.equal(request.url, '/v1/responses');
      return { chunks: functionChunks };
    },
    async (url) => {
      const r = req();
      r.model.baseUrl = url;
      const o = await new OpenAIProvider().stream(r, new AbortController().signal, () => {});
      assert.equal(o.stopReason, 'toolUse');
      assert.deepEqual(o.content, [{ type: 'toolCall', id: 'call_a', name: 'read', args: { path: 'a' } }]);
    },
  ));
test('reads Responses reasoning summary into thinking', async () =>
  withSSEServer(
    () => ({
      chunks: [
        sse({
          type: 'response.output_item.added',
          output_index: 0,
          item: { type: 'reasoning', id: 'rs_a', summary: [] },
        }),
        sse({ type: 'response.reasoning_summary_text.delta', output_index: 0, delta: 'reason' }),
        sse({
          type: 'response.output_item.done',
          output_index: 0,
          item: {
            type: 'reasoning',
            id: 'rs_a',
            summary: [{ type: 'summary_text', text: 'reason' }],
            encrypted_content: 'opaque',
          },
        }),
        end([
          {
            type: 'reasoning',
            id: 'rs_a',
            summary: [{ type: 'summary_text', text: 'reason' }],
            encrypted_content: 'opaque',
          },
        ]),
      ],
    }),
    async (url) => {
      const r = req();
      r.model.baseUrl = url;
      const o = await new OpenAIProvider().stream(r, new AbortController().signal, () => {});
      assert.deepEqual(o.content, [{ type: 'thinking', text: 'reason' }]);
      assert.match(JSON.stringify(o.responsesOutput), /opaque/);
    },
  ));
test('maps Responses terminal status and max output tokens', async () => {
  for (const [type, output, extra, expected] of [
    ['response.completed', [textItem], {}, 'end'],
    ['response.completed', [call], {}, 'toolUse'],
    ['response.incomplete', [textItem], { incomplete_details: { reason: 'max_output_tokens' } }, 'maxTokens'],
  ] as const)
    await withSSEServer(
      () => ({ chunks: [end([...output], type, extra)] }),
      async (url) => {
        const r = req();
        r.model.baseUrl = url;
        assert.equal(
          (await new OpenAIProvider().stream(r, new AbortController().signal, () => {})).stopReason,
          expected,
        );
      },
    );
});
test('reads usage from response.completed', async () =>
  withSSEServer(
    () => ({ chunks: [end([textItem])] }),
    async (url) => {
      const r = req();
      r.model.baseUrl = url;
      assert.deepEqual((await new OpenAIProvider().stream(r, new AbortController().signal, () => {})).usage, {
        input: 16,
        output: 5,
        cacheRead: 4,
        cacheWrite: 0,
      });
    },
  ));
test('abort mid-stream returns aborted with partial text and no partial tool call', async () =>
  withSSEServer(
    () => ({
      chunks: [
        sse({
          type: 'response.output_item.added',
          output_index: 0,
          item: { ...textItem, content: [], status: 'in_progress' },
        }),
        sse({
          type: 'response.output_item.added',
          output_index: 1,
          item: { ...call, arguments: '{', status: 'in_progress' },
        }),
        sse({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'hi' }),
      ],
    }),
    async (url) => {
      const r = req();
      r.model.baseUrl = url;
      const controller = new AbortController();
      const o = await new OpenAIProvider().stream(r, controller.signal, (e) => {
        if (e.type === 'textDelta') controller.abort();
      });
      assert.equal(o.stopReason, 'aborted');
      assert.deepEqual(o.content, [{ type: 'text', text: 'hi' }]);
    },
  ));
test('replays opaque reasoning and call_id across Responses turns', () => {
  const reasoning = { type: 'reasoning', id: 'rs_a', summary: [], encrypted_content: 'opaque' };
  const m: AssistantMessage = {
    role: 'assistant',
    provider: 'openai',
    model: 'test',
    usage: zeroUsage(),
    stopReason: 'toolUse',
    content: [{ type: 'toolCall', id: 'call_a', name: 'read', args: { path: 'a' } }],
    responsesOutput: [reasoning, call],
  };
  const b = buildOpenAIBody(
    req([
      m,
      {
        role: 'toolResult',
        toolCallId: 'call_a',
        toolName: 'read',
        content: [{ type: 'text', text: 'ok' }],
        isError: false,
      },
    ]),
  );
  assert.deepEqual(b.input.slice(0, 2), [reasoning, call]);
  assert.equal(b.input[2]?.call_id, 'call_a');
});
test('response.failed and error events become actionable errors', async () => {
  for (const event of [
    { type: 'response.failed', response: { error: { code: 'bad_model', message: 'unavailable' } } },
    { type: 'error', code: 'bad_model', message: 'unavailable' },
  ])
    await withSSEServer(
      () => ({ chunks: [sse(event)] }),
      async (url) => {
        const r = req();
        r.model.baseUrl = url;
        const o = await new OpenAIProvider().stream(r, new AbortController().signal, () => {});
        assert.equal(o.stopReason, 'error');
        assert.match(o.errorMessage!, /unavailable/);
      },
    );
});
test('Responses transport truncation does not return false success', async () =>
  withSSEServer(
    () => ({ chunks: [sse({ type: 'response.output_text.delta', output_index: 0, delta: 'partial' })] }),
    async (url) => {
      const r = req();
      r.model.baseUrl = url;
      const o = await new OpenAIProvider().stream(r, new AbortController().signal, () => {});
      assert.equal(o.stopReason, 'error');
      assert.match(o.errorMessage!, /terminal/);
    },
  ));
test('never sends a request to a Chat endpoint', async () =>
  withSSEServer(
    (body, _, request) => {
      assert.equal(request.url, '/v1/responses');
      assert.ok(!('messages' in (body as object)));
      return { chunks: [end([textItem])] };
    },
    async (url) => {
      const r = req();
      r.model.baseUrl = url + '/v1';
      assert.equal((await new OpenAIProvider().stream(r, new AbortController().signal, () => {})).stopReason, 'end');
    },
  ));
