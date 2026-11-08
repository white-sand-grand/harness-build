import type { ModelRequest, Provider, StreamEvent, AssistantMessage, ThinkingBlock, ToolCallBlock } from './types.ts';
import { HTTPError, errorText } from './errors.ts';
import { withRetry, type Sleep } from './retry.ts';
import { parseSSE } from './sse.ts';
import { emptyAssistant, endpoint, parseArgs } from './shared.ts';
type WireBlock = Record<string, unknown>;
export function buildAnthropicBody(req: ModelRequest) {
  const image = (b: { mediaType: string; data: string }) => ({
    type: 'image',
    source: { type: 'base64', media_type: b.mediaType, data: b.data },
  });
  const messages: { role: string; content: WireBlock[] }[] = [];
  for (const m of req.messages) {
    if (m.role === 'assistant' && m.content.length === 0) continue;
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    let content: WireBlock[];
    if (m.role === 'toolResult')
      content = [
        {
          type: 'tool_result',
          tool_use_id: m.toolCallId,
          is_error: m.isError,
          content: m.content.map((b) => (b.type === 'image' ? image(b) : b)),
        },
      ];
    else
      content = m.content.map((b): WireBlock => {
        switch (b.type) {
          case 'image':
            return image(b);
          case 'toolCall':
            return { type: 'tool_use', id: b.id, name: b.name, input: b.args };
          case 'thinking':
            return b.signature && m.role === 'assistant' && m.provider === 'anthropic'
              ? { type: 'thinking', thinking: b.text, signature: b.signature }
              : { type: 'text', text: `<thinking>${b.text}</thinking>` };
          default:
            return { type: 'text', text: b.text };
        }
      });
    if (messages.at(-1)?.role === role) messages.at(-1)!.content.push(...content);
    else messages.push({ role, content });
  }
  const lastUser = messages.findLast((m) => m.role === 'user');
  if (lastUser?.content.length) lastUser.content.at(-1)!.cache_control = { type: 'ephemeral' };
  const tools = req.tools.map((t, i) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
    ...(i === req.tools.length - 1 ? { cache_control: { type: 'ephemeral' } } : {}),
  }));
  const budget = { off: 0, low: 2048, medium: 8192, high: 24576 }[req.thinking ?? 'off'];
  return {
    model: req.model.id,
    max_tokens: Math.max(req.maxOutputTokens ?? req.model.maxOutputTokens, budget ? budget + 1024 : 1),
    system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
    ...(tools.length ? { tools } : {}),
    messages,
    stream: true,
    ...(budget && req.model.supportsThinking ? { thinking: { type: 'enabled', budget_tokens: budget } } : {}),
  };
}
type AnthropicEvent = {
  type?: string;
  index?: number;
  message?: {
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
  usage?: { output_tokens?: number };
  content_block?: {
    type: string;
    text?: string;
    thinking?: string;
    signature?: string;
    id?: string;
    name?: string;
    input?: Record<string, unknown>;
  };
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    signature?: string;
    partial_json?: string;
    stop_reason?: string;
  };
  error?: { type?: string; message?: string };
};
export class AnthropicProvider implements Provider {
  readonly id = 'anthropic';
  private retrySleep?: Sleep;
  constructor(opts: { sleep?: Sleep } = {}) {
    this.retrySleep = opts.sleep;
  }
  async stream(req: ModelRequest, signal: AbortSignal, onEvent: (e: StreamEvent) => void): Promise<AssistantMessage> {
    const result = emptyAssistant(req, this.id);
    const blocks = new Map<number, AssistantMessage['content'][number]>();
    const calls = new Map<number, { call: ToolCallBlock; raw: string }>();
    let seen = false;
    let complete = false;
    try {
      const env = req.model.apiKeyEnv;
      const key = (env ? process.env[env] : undefined) || process.env.ANTHROPIC_API_KEY;
      const bearer = key ? undefined : process.env.ANTHROPIC_AUTH_TOKEN;
      if (!key && !bearer)
        throw new Error(`Missing API key. Set ${env ?? 'ANTHROPIC_API_KEY'} or ANTHROPIC_AUTH_TOKEN.`);
      await withRetry(
        async () => {
          const response = await fetch(
            endpoint(
              req.model.baseUrl ?? process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com',
              '/v1/messages',
            ),
            {
              method: 'POST',
              signal,
              headers: {
                'content-type': 'application/json',
                'anthropic-version': '2023-06-01',
                ...(key ? { 'x-api-key': key } : { authorization: `Bearer ${bearer}` }),
              },
              body: JSON.stringify(buildAnthropicBody(req)),
            },
          );
          if (!response.ok)
            throw new HTTPError(
              response.status,
              await response.text(),
              response.headers.get('retry-after') ?? undefined,
            );
          if (!response.body) throw new Error('API returned an empty response body.');
          for await (const event of parseSSE(response.body, signal)) {
            seen = true;
            const data = JSON.parse(event.data) as AnthropicEvent;
            const i = data.index ?? 0;
            if (data.type === 'message_start') {
              const u = data.message?.usage;
              result.usage = {
                input: u?.input_tokens ?? 0,
                output: u?.output_tokens ?? 0,
                cacheRead: u?.cache_read_input_tokens ?? 0,
                cacheWrite: u?.cache_creation_input_tokens ?? 0,
              };
            } else if (data.type === 'content_block_start') {
              const b = data.content_block!;
              if (b.type === 'text') blocks.set(i, { type: 'text', text: b.text ?? '' });
              if (b.type === 'thinking')
                blocks.set(i, { type: 'thinking', text: b.thinking ?? '', signature: b.signature });
              if (b.type === 'tool_use') {
                const call: ToolCallBlock = { type: 'toolCall', id: b.id!, name: b.name!, args: b.input ?? {} };
                calls.set(i, { call, raw: '' });
                onEvent({ type: 'toolCallStart', id: call.id, name: call.name });
              }
            } else if (data.type === 'content_block_delta') {
              const d = data.delta!;
              const b = blocks.get(i);
              if (d.type === 'text_delta' && b?.type === 'text') {
                b.text += d.text ?? '';
                onEvent({ type: 'textDelta', text: d.text ?? '' });
              }
              if (d.type === 'thinking_delta' && b?.type === 'thinking') {
                b.text += d.thinking ?? '';
                onEvent({ type: 'thinkingDelta', text: d.thinking ?? '' });
              }
              if (d.type === 'signature_delta' && b?.type === 'thinking')
                (b as ThinkingBlock).signature = (b.signature ?? '') + (d.signature ?? '');
              if (d.type === 'input_json_delta' && calls.has(i)) {
                const c = calls.get(i)!;
                c.raw += d.partial_json ?? '';
                onEvent({ type: 'toolCallDelta', id: c.call.id, argsText: d.partial_json ?? '' });
              }
            } else if (data.type === 'content_block_stop' && calls.has(i)) {
              const c = calls.get(i)!;
              if (c.raw) c.call.args = parseArgs(c.raw);
              blocks.set(i, c.call);
            } else if (data.type === 'message_delta') {
              result.usage.output = data.usage?.output_tokens ?? result.usage.output;
              const stop = data.delta?.stop_reason;
              result.stopReason = stop === 'tool_use' ? 'toolUse' : stop === 'max_tokens' ? 'maxTokens' : 'end';
            } else if (data.type === 'message_stop') complete = true;
            else if (data.type === 'error')
              throw new Error(`${data.error?.type ?? 'API error'}: ${data.error?.message ?? 'Unknown error'}`);
          }
          if (!complete) throw new Error('Stream ended before message_stop. Retry the request.');
        },
        { signal, sleep: this.retrySleep, started: () => seen },
      );
    } catch (error) {
      result.stopReason = signal.aborted ? 'aborted' : 'error';
      if (!signal.aborted) result.errorMessage = errorText(error);
    }
    result.content = [...blocks.entries()].sort(([a], [b]) => a - b).map(([, b]) => b);
    return result;
  }
}
