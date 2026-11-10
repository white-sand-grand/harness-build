import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgent } from '../../../src/agent/index.ts';
import type { AgentConfig, AgentEvent, Hooks, Tool } from '../../../src/agent/index.ts';
import { resolveModel, zeroUsage } from '../../../src/ai/index.ts';
import type { Message, ModelRequest, Provider } from '../../../src/ai/index.ts';
import { composeHooks, traceHooks } from '../../../src/hooks/compose.ts';
import { failingProvider, scripted } from '../../helpers/fake-provider.ts';

const user = (text: string): Message => ({ role: 'user', content: [{ type: 'text', text }] });
const tool: Tool = {
  name: 'lookup',
  description: 'Look up a fact',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  readOnly: true,
  async execute() {
    return { content: [{ type: 'text', text: 'tool fact' }] };
  },
};
const config = (provider: Provider, hooks: Hooks = {}): AgentConfig => ({
  provider,
  model: resolveModel('test', {}, 'anthropic'),
  system: 'stable system',
  systemCacheBoundary: 6,
  tools: [tool],
  hooks,
  maxTurns: 4,
});
async function run(cfg: AgentConfig, messages: Message[] = [user('task')], controller = new AbortController()) {
  const events: AgentEvent[] = [];
  const reason = await runAgent(cfg, messages, {
    signal: controller.signal,
    onEvent: (event) => events.push(event),
  });
  return { reason, messages, events };
}

test('temporary model context refreshes after tools without entering messages or changing the cached system prefix', async () => {
  const provider = scripted({ toolCalls: [{ name: tool.name, args: {} }] }, { text: 'done' });
  const seen: Message[][] = [];
  const cfg = config(provider, {
    async modelContext(messages) {
      seen.push(structuredClone([...messages]));
      return messages.some((message) => message.role === 'toolResult') ? 'private recall two' : 'private recall one';
    },
  });
  const result = await run(cfg);
  assert.equal(result.reason, 'done');
  assert.deepEqual(
    provider.requests.map((request) => request.system),
    ['stable system\n\nprivate recall one', 'stable system\n\nprivate recall two'],
  );
  assert.ok(provider.requests.every((request) => request.systemCacheBoundary === 6));
  assert.equal(cfg.system, 'stable system');
  assert.equal(seen.length, 2);
  assert.equal(seen[1]?.at(-1)?.role, 'toolResult');
  assert.doesNotMatch(JSON.stringify(result.messages), /private recall/);
  assert.doesNotMatch(JSON.stringify(result.events), /private recall/);
  assert.equal(result.events.filter((event) => event.type === 'message').length, 3);
  assert.equal(result.events.filter((event) => event.type === 'contextReplaced').length, 0);
});

test('overflow retry rebuilds temporary context from the compacted messages', async () => {
  const requests: ModelRequest[] = [];
  const success = scripted({ text: 'done' });
  const provider: Provider = {
    id: 'anthropic',
    async stream(request, signal, emit) {
      requests.push(structuredClone(request));
      if (requests.length === 1)
        return {
          role: 'assistant',
          content: [],
          model: request.model.id,
          provider: 'anthropic',
          usage: zeroUsage(),
          stopReason: 'error',
          errorMessage: 'prompt is too long',
        };
      return success.stream(request, signal, emit);
    },
  };
  const cfg = config(provider, {
    async beforeModel(_, info) {
      return info.force ? { messages: [user('summary')], kind: 'compaction', summary: 'summary', meta: {} } : undefined;
    },
    async modelContext(messages) {
      return `recall for ${messages[0]?.content[0]?.type === 'text' ? messages[0].content[0].text : ''}`;
    },
  });
  const result = await run(cfg);
  assert.equal(result.reason, 'done');
  assert.deepEqual(
    requests.map((request) => request.system),
    ['stable system\n\nrecall for task', 'stable system\n\nrecall for summary'],
  );
  assert.deepEqual(result.messages[0], user('summary'));
  assert.equal(result.events.filter((event) => event.type === 'contextReplaced').length, 1);
  assert.doesNotMatch(JSON.stringify(result.messages), /recall for/);
});

test('context providers compose in order and skip blank contributions without tracing their text', async () => {
  const order: number[] = [];
  const records: Record<string, unknown>[] = [];
  const provider = scripted({ text: 'done' });
  const hooks = composeHooks(
    {
      async modelContext() {
        order.push(1);
        await Promise.resolve();
        return ' first recall ';
      },
    },
    {
      async modelContext() {
        order.push(2);
        return ' \n\t';
      },
    },
    {
      async modelContext() {
        order.push(3);
        return 'second recall';
      },
    },
  );
  await run(
    config(
      provider,
      traceHooks(hooks, (record) => records.push(record)),
    ),
  );
  assert.deepEqual(order, [1, 2, 3]);
  assert.equal(provider.requests[0]?.system, 'stable system\n\nfirst recall\n\nsecond recall');
  assert.ok(records.some((record) => record.hook === 'modelContext' && record.decision === 'provided'));
  assert.doesNotMatch(JSON.stringify(records), /first recall|second recall/);
});

test('missing or blank model context sends the original system unchanged', async () => {
  for (const hooks of [
    {},
    { modelContext: async () => ' \n\t' },
    composeHooks({ modelContext: async () => undefined }),
  ]) {
    const provider = scripted({ text: 'done' });
    await run(config(provider, hooks));
    assert.equal(provider.requests[0]?.system, 'stable system');
  }
});

test('model context failure propagates and prevents later providers and the model request', async () => {
  const provider = scripted({ text: 'unused' });
  const records: Record<string, unknown>[] = [];
  const messages = [user('task')];
  let laterCalled = false;
  const hooks = composeHooks(
    {
      async modelContext() {
        throw new Error('recall unavailable');
      },
    },
    {
      async modelContext() {
        laterCalled = true;
        return 'unused';
      },
    },
  );
  const cfg = config(
    provider,
    traceHooks(hooks, (record) => records.push(record)),
  );
  await assert.rejects(() => run(cfg, messages), /recall unavailable/);
  assert.equal(provider.requests.length, 0);
  assert.equal(laterCalled, false);
  assert.deepEqual(messages, [user('task')]);
  assert.equal(cfg.system, 'stable system');
  assert.ok(records.some((record) => record.hook === 'modelContext' && record.decision === 'error'));
});

test('abort before or during model context prevents a model request', async () => {
  for (const abortBefore of [true, false]) {
    const controller = new AbortController();
    const provider = scripted({ text: 'unused' });
    let called = false;
    if (abortBefore) controller.abort();
    const result = await run(
      config(provider, {
        async modelContext() {
          called = true;
          await Promise.resolve();
          controller.abort();
          return 'unused';
        },
      }),
      [user('task')],
      controller,
    );
    assert.equal(result.reason, 'aborted');
    assert.equal(called, !abortBefore);
    assert.equal(provider.requests.length, 0);
    assert.deepEqual(result.messages, [user('task')]);
    assert.deepEqual(result.events.at(-1), { type: 'agentEnd', reason: 'aborted' });
  }
});

test('model errors keep temporary context out of the interrupted conversation', async () => {
  const result = await run(
    config(failingProvider('connection failed'), { modelContext: async () => 'private recall' }),
  );
  assert.equal(result.reason, 'error');
  assert.deepEqual(result.events.at(-1), { type: 'agentEnd', reason: 'error', error: 'connection failed' });
  assert.doesNotMatch(JSON.stringify(result.messages), /private recall/);
});

test('a cancelled context request ends as aborted when its pending work rejects', async () => {
  const controller = new AbortController();
  const provider = scripted({ text: 'unused' });
  const result = await run(
    config(provider, {
      async modelContext() {
        await Promise.resolve();
        controller.abort();
        throw new DOMException('Context request cancelled', 'AbortError');
      },
    }),
    [user('task')],
    controller,
  );
  assert.equal(result.reason, 'aborted');
  assert.equal(provider.requests.length, 0);
  assert.deepEqual(result.messages, [user('task')]);
  assert.deepEqual(result.events.at(-1), { type: 'agentEnd', reason: 'aborted' });
});
