import assert from 'node:assert/strict';
import { runAgent } from '../../../src/agent/index.ts';
import type { Tool } from '../../../src/agent/index.ts';
import { resolveModel, zeroUsage } from '../../../src/ai/index.ts';
import type { Message, Provider } from '../../../src/ai/index.ts';

// 用内存文件突出工具契约；第二章再接入真实文件工具。
const read: Tool = {
  name: 'read',
  description: 'Read the in-memory answer.txt file.',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string', enum: ['answer.txt'] } },
    required: ['path'],
    additionalProperties: false,
  },
  readOnly: true,
  async execute() {
    return { content: [{ type: 'text', text: '42' }] };
  },
};

// 固定回复替代外部模型：先请求 read，收到实际结果后再回答。
let requests = 0;
const provider: Provider = {
  id: 'openai',
  async stream(req) {
    requests++;
    const base = { role: 'assistant' as const, provider: this.id, model: req.model.id, usage: zeroUsage() };
    if (requests === 1)
      return {
        ...base,
        stopReason: 'toolUse',
        content: [{ type: 'toolCall', id: 'read-1', name: 'read', args: { path: 'answer.txt' } }],
      };
    const result = req.messages.at(-1);
    assert.ok(result?.role === 'toolResult' && result.toolCallId === 'read-1' && !result.isError);
    const block = result.content[0];
    assert.ok(block?.type === 'text');
    return {
      ...base,
      stopReason: 'end',
      content: [{ type: 'text', text: `answer.txt 的内容是 ${block.text}。` }],
    };
  },
};

const messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: '读取 answer.txt 并告诉我内容。' }] }];
const reason = await runAgent(
  {
    provider,
    model: resolveModel('offline-demo', {}, provider.id),
    system: 'Read the file before answering.',
    tools: [read],
    hooks: {},
    maxTurns: 3,
  },
  messages,
  {
    signal: new AbortController().signal,
    onEvent(event) {
      if (event.type === 'turnStart') console.log(`[${event.turn}] 请求模型`);
      if (event.type === 'toolStart') console.log(`    调用 ${event.call.name} ${JSON.stringify(event.call.args)}`);
      if (event.type === 'toolEnd')
        for (const block of event.result.content) if (block.type === 'text') console.log(`    结果 ${block.text}`);
      if (event.type === 'message' && event.message.role === 'assistant')
        for (const block of event.message.content) if (block.type === 'text') console.log(`    回复 ${block.text}`);
      if (event.type === 'agentEnd') console.log(`结束：${event.reason}`);
    },
  },
);

assert.equal(reason, 'done');
assert.equal(requests, 2);
assert.deepEqual(
  messages.map((message) => message.role),
  ['user', 'assistant', 'toolResult', 'assistant'],
);
