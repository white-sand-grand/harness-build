import assert from 'node:assert/strict';
import type { AssistantMessage, ModelRequest, Provider } from '../../../src/ai/index.ts';
import { zeroUsage } from '../../../src/ai/index.ts';

type Reply = { text?: string; calls?: Array<{ name: string; args: Record<string, unknown> }> };
type Step = Reply | ((request: ModelRequest) => Reply);
let nextCall = 0;

/** Only the model is scripted. The application, tools, session and checks remain real. */
export function scripted(...steps: Step[]): Provider {
  return {
    id: 'anthropic',
    async stream(request, signal, emit): Promise<AssistantMessage> {
      signal.throwIfAborted();
      const step = steps.shift();
      assert.ok(step, 'The offline example exhausted its scripted replies.');
      const reply = typeof step === 'function' ? step(request) : step;
      const content: AssistantMessage['content'] = [];
      if (reply.text) {
        content.push({ type: 'text', text: reply.text });
        emit({ type: 'textDelta', text: reply.text });
      }
      for (const call of reply.calls ?? []) content.push({ type: 'toolCall', id: `offline-${++nextCall}`, ...call });
      return {
        role: 'assistant',
        provider: this.id,
        model: request.model.id,
        content,
        stopReason: reply.calls?.length ? 'toolUse' : 'end',
        usage: zeroUsage(),
      };
    },
  };
}
