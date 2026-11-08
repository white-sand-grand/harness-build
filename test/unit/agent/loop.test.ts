import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgent, ToolError } from '../../../src/agent/index.ts';
import type { AgentConfig, AgentEvent, Tool } from '../../../src/agent/index.ts';
import type { Message, Provider } from '../../../src/ai/index.ts';
import { resolveModel, zeroUsage } from '../../../src/ai/index.ts';
import { scripted, failingProvider } from '../../helpers/fake-provider.ts';
test('steering queued during a final text response starts another turn', async () => {
  const p = scripted({ text: 'first' }, { text: 'second' });
  let queued = true;
  const r = await run(cfg(p), new AbortController(), () =>
    queued ? ((queued = false), [{ role: 'user', content: [{ type: 'text', text: 'one more thing' }] }]) : [],
  );
  assert.equal(r.reason, 'done');
  assert.equal(p.requests.length, 2);
  assert.equal(p.requests[1]?.messages.at(-1)?.role, 'user');
});
const tool: Tool = {
  name: 'read',
  description: 'read',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
    additionalProperties: false,
  },
  readOnly: true,
  async execute() {
    return { content: [{ type: 'text', text: 'file' }] };
  },
};
const cfg = (provider: Provider): AgentConfig => ({
  provider,
  model: resolveModel('test', {}, 'anthropic'),
  system: 'sys',
  tools: [tool],
  hooks: {},
  maxTurns: 5,
});
async function run(c: AgentConfig, controller = new AbortController(), getSteering?: () => Message[]) {
  const messages: Message[] = [];
  const events: AgentEvent[] = [];
  const reason = await runAgent(c, messages, {
    signal: controller.signal,
    onEvent: (e) => events.push(e),
    getSteering,
  });
  return { messages, events, reason };
}
const call = { name: 'read', args: { path: 'a' } };
test('returns done when model replies without tool calls', async () =>
  assert.equal((await run(cfg(scripted({ text: 'done' })))).reason, 'done'));
test('executes tool call and feeds result back', async () => {
  const p = scripted({ toolCalls: [call] }, { text: 'done' });
  await run(cfg(p));
  assert.equal(p.requests[1]?.messages.at(-1)?.role, 'toolResult');
});
test('executes multiple tool calls in order', async () => {
  const seen: string[] = [];
  const c = cfg(scripted({ toolCalls: [call, { ...call, args: { path: 'b' } }] }, { text: 'done' }));
  c.tools = [
    {
      ...tool,
      async execute(a) {
        seen.push(String(a.path));
        return { content: [] };
      },
    },
  ];
  await run(c);
  assert.deepEqual(seen, ['a', 'b']);
});
test('unknown tool → error result listing available tools, loop continues', async () => {
  const r = await run(cfg(scripted({ toolCalls: [{ name: 'missing', args: {} }] }, { text: 'ok' })));
  assert.match(JSON.stringify(r.messages), /Available tools: read/);
  assert.equal(r.reason, 'done');
});
test('invalid args → error result with each problem listed', async () => {
  const r = await run(cfg(scripted({ toolCalls: [{ name: 'read', args: { x: 1 } }] }, { text: 'ok' })));
  assert.match(JSON.stringify(r.messages), /missing required property/);
  assert.match(JSON.stringify(r.messages), /unknown property/);
});
test('invalid json args → error result', async () => {
  const r = await run(cfg(scripted({ toolCalls: [{ name: 'read', args: { __invalidJson: '{' } }] }, { text: 'ok' })));
  assert.match(JSON.stringify(r.messages), /valid JSON object/);
});
test('ToolError message reaches model verbatim', async () => {
  const c = cfg(scripted({ toolCalls: [call] }, { text: 'ok' }));
  c.tools = [
    {
      ...tool,
      async execute() {
        throw new ToolError('reread now');
      },
    },
  ];
  const r = await run(c);
  assert.equal(
    r.messages[1]?.role === 'toolResult' && r.messages[1].content[0]?.type === 'text' && r.messages[1].content[0].text,
    'reread now',
  );
});
test('unexpected exception → "Internal tool error:" prefix', async () => {
  const c = cfg(scripted({ toolCalls: [call] }, { text: 'ok' }));
  c.tools = [
    {
      ...tool,
      async execute() {
        throw new Error('oops');
      },
    },
  ];
  assert.match(JSON.stringify((await run(c)).messages), /Internal tool error: oops/);
});
test('beforeTool deny → error result with reason, tool not executed', async () => {
  let executed = false;
  const c = cfg(scripted({ toolCalls: [call] }, { text: 'ok' }));
  c.tools = [
    {
      ...tool,
      async execute() {
        executed = true;
        return { content: [] };
      },
    },
  ];
  c.hooks.beforeTool = async () => ({ action: 'deny', reason: 'denied' });
  const r = await run(c);
  assert.equal(executed, false);
  assert.match(JSON.stringify(r.messages), /denied/);
});
test('afterTool can append to result', async () => {
  const c = cfg(scripted({ toolCalls: [call] }, { text: 'ok' }));
  c.hooks.afterTool = async (_, __, r) => ({ ...r, content: [...r.content, { type: 'text', text: 'lint failed' }] });
  assert.match(JSON.stringify((await run(c)).messages), /lint failed/);
});
test('onStop continue injects user message and loops; stop ends', async () => {
  let n = 0;
  const c = cfg(scripted({ text: 'first' }, { text: 'second' }));
  c.hooks.onStop = async () => (n++ ? { action: 'stop' } : { action: 'continue', message: 'try again' });
  const r = await run(c);
  assert.equal(r.messages[1]?.role, 'user');
  assert.equal(r.reason, 'done');
});
test('maxTurns ends with reason maxTurns and no dangling tool calls', async () => {
  const c = cfg(scripted({ toolCalls: [call] }));
  c.maxTurns = 1;
  const r = await run(c);
  assert.equal(r.reason, 'maxTurns');
  assert.equal(r.messages.at(-1)?.role, 'toolResult');
});
test('abort during stream → aborted, synthesized results for completed tool calls', async () => {
  const c = cfg(scripted({ toolCalls: [call], stopReason: 'aborted' }));
  const r = await run(c);
  assert.equal(r.reason, 'aborted');
  assert.equal(r.messages.at(-1)?.role, 'toolResult');
});
test('abort during tool execution → tool receives aborted signal, run ends aborted', async () => {
  const controller = new AbortController();
  const c = cfg(scripted({ toolCalls: [call] }));
  c.tools = [
    {
      ...tool,
      async execute(_, ctx) {
        controller.abort();
        assert.equal(ctx.signal.aborted, true);
        return { content: [] };
      },
    },
  ];
  assert.equal((await run(c, controller)).reason, 'aborted');
});
test('maxTokens without tool calls → continuation message', async () => {
  const r = await run(cfg(scripted({ text: 'cut', stopReason: 'maxTokens' }, { text: 'rest' })));
  assert.match(JSON.stringify(r.messages), /Continue from where/);
  assert.equal(r.reason, 'done');
});
test('provider error → agentEnd error with message', async () => {
  const r = await run(cfg(failingProvider('no key')));
  assert.deepEqual(r.events.at(-1), { type: 'agentEnd', reason: 'error', error: 'no key' });
});
test('context overflow → beforeModel called with force, retried once', async () => {
  let n = 0;
  const p: Provider = {
    id: 'anthropic',
    async stream(req) {
      return {
        role: 'assistant',
        content: [],
        usage: zeroUsage(),
        model: req.model.id,
        provider: 'anthropic',
        stopReason: n++ ? 'end' : 'error',
        errorMessage: 'prompt is too long',
      };
    },
  };
  const c = cfg(p);
  const forces: boolean[] = [];
  c.hooks.beforeModel = async (_, i) => {
    forces.push(!!i.force);
    return {
      messages: [{ role: 'user', content: [{ type: 'text', text: 'summary' }] }],
      kind: 'compaction',
      summary: 'summary',
      meta: {},
    };
  };
  assert.equal((await run(c)).reason, 'done');
  assert.ok(forces.includes(true));
  assert.equal(n, 2);
});
test('steering messages appended after tool batch', async () => {
  let once = true;
  const p = scripted({ toolCalls: [call] }, { text: 'done' });
  await run(cfg(p), new AbortController(), () =>
    once ? ((once = false), [{ role: 'user', content: [{ type: 'text', text: 'steer' }] }]) : [],
  );
  assert.equal(p.requests[1]?.messages.at(-1)?.role, 'user');
});
test('emits message event for every message added to context', async () => {
  const r = await run(cfg(scripted({ toolCalls: [call] }, { text: 'done' })));
  assert.equal(r.messages.length, r.events.filter((e) => e.type === 'message').length);
});
test('beforeModel replacement replaces messages in place and emits contextReplaced', async () => {
  let n = 0;
  const c = cfg(scripted({ text: 'done' }));
  c.hooks.beforeModel = async () =>
    n++
      ? undefined
      : { messages: [{ role: 'user', content: [{ type: 'text', text: 'summary' }] }], kind: 'clearing', meta: {} };
  const r = await run(c);
  assert.equal(r.messages.length, 2);
  assert.ok(r.events.some((e) => e.type === 'contextReplaced'));
});
