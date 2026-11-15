import test from 'node:test';
import assert from 'node:assert/strict';
import {
  runAgent,
  type AgentConfig,
  type AgentEvent,
  type DeferredBatch,
  type Tool,
} from '../../../src/agent/index.ts';
import { resolveModel, type Message } from '../../../src/ai/index.ts';
import { composeHooks } from '../../../src/hooks/compose.ts';
import { scripted } from '../../helpers/fake-provider.ts';

test('deferred A/B/C batches save before suspension and resume only the pending suffix', async () => {
  const order: string[] = [],
    events: AgentEvent[] = [],
    messages: Message[] = [];
  const tools: Tool[] = ['A', 'B', 'C'].map((name) => ({
    name,
    description: name,
    parameters: { type: 'object' },
    readOnly: false,
    async execute() {
      order.push(name);
      return { content: [{ type: 'text', text: name + ' completed' }] };
    },
  }));
  const provider = scripted({ toolCalls: tools.map((tool) => ({ name: tool.name, args: {} })) }, (request) => {
    assert.deepEqual(order, ['A', 'B', 'C']);
    assert.equal(request.messages.filter((message) => message.role === 'toolResult').length, 3);
    return { text: 'done' };
  });
  let allowed = false,
    saved: DeferredBatch | undefined;
  const config: AgentConfig = {
    provider,
    model: resolveModel('test', {}, 'anthropic'),
    system: 'test',
    tools,
    hooks: {
      beforeTool: async (call) =>
        call.name === 'B' && !allowed ? { action: 'defer', reason: 'needs approval' } : { action: 'allow' },
    },
  };
  const options = {
    signal: new AbortController().signal,
    onEvent: (event: AgentEvent) => events.push(event),
    onSuspend: async (batch: DeferredBatch) => {
      assert.deepEqual(order, ['A']);
      saved = batch;
      return { requestId: 'request-1' };
    },
  };
  assert.equal(await runAgent(config, messages, options), 'suspended');
  assert.equal(saved?.nextCallIndex, 1);
  assert.ok(!events.some((event) => event.type === 'toolEnd' && event.call.name === 'B'));
  allowed = true;
  assert.equal(await runAgent(config, messages, { ...options, resumeTools: saved }), 'done');
  assert.deepEqual(order, ['A', 'B', 'C']);
  assert.equal(provider.requests.length, 2);
});

test('a later denial takes precedence over deferral and no suspension is persisted', async () => {
  let executed = false,
    suspended = false;
  const tool: Tool = {
    name: 'write',
    description: 'write',
    parameters: { type: 'object' },
    readOnly: false,
    async execute() {
      executed = true;
      return { content: [] };
    },
  };
  const provider = scripted({ toolCalls: [{ name: 'write', args: {} }] }, (request) => {
    assert.ok(request.messages.some((message) => message.role === 'toolResult' && message.isError));
    return { text: 'denied' };
  });
  const result = await runAgent(
    {
      provider,
      model: resolveModel('test', {}, 'anthropic'),
      system: '',
      tools: [tool],
      hooks: composeHooks(
        { beforeTool: async () => ({ action: 'defer', reason: 'first' }) },
        { beforeTool: async () => ({ action: 'deny', reason: 'final deny' }) },
      ),
    },
    [],
    {
      signal: new AbortController().signal,
      onEvent() {},
      onSuspend: async () => {
        suspended = true;
        return { requestId: 'never' };
      },
    },
  );
  assert.equal(result, 'done');
  assert.equal(executed, false);
  assert.equal(suspended, false);
});

test('a caller without a durable suspension callback never executes a deferred tool', async () => {
  let executed = false;
  const provider = scripted({ toolCalls: [{ name: 'write', args: {} }] }, { text: 'blocked' });
  const result = await runAgent(
    {
      provider,
      model: resolveModel('test', {}, 'anthropic'),
      system: '',
      tools: [
        {
          name: 'write',
          description: '',
          parameters: { type: 'object' },
          readOnly: false,
          async execute() {
            executed = true;
            return { content: [] };
          },
        },
      ],
      hooks: { beforeTool: async () => ({ action: 'defer', reason: 'approval' }) },
    },
    [],
    { signal: new AbortController().signal, onEvent() {} },
  );
  assert.equal(result, 'done');
  assert.equal(executed, false);
});
