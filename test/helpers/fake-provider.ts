import type { Provider, ModelRequest, AssistantMessage, StopReason, Usage, StreamEvent } from '../../src/ai/index.ts';
import { zeroUsage } from '../../src/ai/index.ts';
export type StepData = {
  text?: string;
  thinking?: string;
  toolCalls?: { name: string; args: Record<string, unknown> }[];
  stopReason?: StopReason;
  usage?: Partial<Usage>;
};
export type Step = StepData | ((req: ModelRequest) => StepData);
export class FakeProvider implements Provider {
  readonly id = 'anthropic';
  requests: ModelRequest[] = [];
  private steps: Step[];
  private call = 0;
  constructor(steps: Step[]) {
    this.steps = [...steps];
  }
  async stream(req: ModelRequest, signal: AbortSignal, emit: (e: StreamEvent) => void): Promise<AssistantMessage> {
    this.requests.push(structuredClone(req));
    const step = this.steps.shift();
    if (!step) throw new Error('FakeProvider: no more steps');
    const data = typeof step === 'function' ? step(req) : step;
    const out: AssistantMessage = {
      role: 'assistant',
      content: [],
      model: req.model.id,
      provider: this.id,
      stopReason: data.stopReason ?? (data.toolCalls?.length ? 'toolUse' : 'end'),
      usage: { ...zeroUsage(), input: Math.ceil(JSON.stringify(req.messages).length / 4), output: 10, ...data.usage },
    };
    for (const [kind, text] of [
      ['thinking', data.thinking],
      ['text', data.text],
    ] as const)
      if (text) {
        const block = { type: kind, text: '' };
        out.content.push(block);
        for (let i = 0; i < text.length; i += 5) {
          await Promise.resolve();
          if (signal.aborted) {
            out.stopReason = 'aborted';
            return out;
          }
          block.text += text.slice(i, i + 5);
          emit({ type: kind === 'text' ? 'textDelta' : 'thinkingDelta', text: text.slice(i, i + 5) });
        }
      }
    for (const call of data.toolCalls ?? []) {
      const id = `call_${++this.call}`;
      emit({ type: 'toolCallStart', id, name: call.name });
      await Promise.resolve();
      if (signal.aborted) {
        out.stopReason = 'aborted';
        return out;
      }
      emit({ type: 'toolCallDelta', id, argsText: JSON.stringify(call.args) });
      out.content.push({ type: 'toolCall', id, name: call.name, args: call.args });
    }
    return out;
  }
}
export const scripted = (...steps: Step[]) => new FakeProvider(steps);
export function failingProvider(errorMessage: string): Provider {
  return {
    id: 'anthropic',
    async stream(req) {
      return {
        role: 'assistant',
        content: [],
        stopReason: 'error',
        errorMessage,
        model: req.model.id,
        provider: 'anthropic',
        usage: zeroUsage(),
      };
    },
  };
}
