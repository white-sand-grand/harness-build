import type { ModelRequest, Provider, StreamEvent, AssistantMessage, ThinkingBlock, ToolCallBlock } from './types.ts';
import { HTTPError, errorText } from './errors.ts';
import { withRetry, type Sleep } from './retry.ts';
import { parseSSE } from './sse.ts';
import { emptyAssistant, endpoint, parseArgs } from './shared.ts';
type WireBlock = Record<string, unknown>;
export function buildAnthropicBody(req: ModelRequest, resolvedBaseUrl?: string) {
  let stepEndpoint = false;
  try {
    stepEndpoint =
      new URL(resolvedBaseUrl ?? req.model.baseUrl ?? 'https://api.anthropic.com').hostname === 'api.stepfun.com';
  } catch {
    // Invalid addresses retain the ordinary mapping and fail when the request is sent.
  }
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
  const level = req.thinking ?? 'off';
  const budget = stepEndpoint ? 0 : { off: 0, low: 2048, medium: 8192, high: 24576 }[level];
  return {
    model: req.model.id,
    max_tokens: Math.max(req.maxOutputTokens ?? req.model.maxOutputTokens, budget ? budget + 1024 : 1),
    system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
    ...(tools.length ? { tools } : {}),
    messages,
    stream: true,
    ...(budget && req.model.supportsThinking ? { thinking: { type: 'enabled', budget_tokens: budget } } : {}),
    ...(stepEndpoint && level !== 'off' && req.model.supportsThinking ? { output_config: { effort: level } } : {}),
  };
}
type WireUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
};
type AnthropicEvent = {
  type?: string;
  index?: number;
  message?: { usage?: WireUsage };
  usage?: WireUsage;
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
  #apiKey?: string;
  #authToken?: string;
  constructor(opts: { sleep?: Sleep; apiKey?: string; authToken?: string } = {}) {
    this.retrySleep = opts.sleep;
    this.#apiKey = opts.apiKey;
    this.#authToken = opts.authToken;
  }
  async stream(req: ModelRequest, signal: AbortSignal, onEvent: (e: StreamEvent) => void): Promise<AssistantMessage> {
    const result = emptyAssistant(req, this.id);
    const blocks = new Map<number, AssistantMessage['content'][number]>();
    const calls = new Map<number, { call: ToolCallBlock; raw: string }>();
    function updateUsage(usage?: WireUsage) {
      if (!usage) return;
      result.usage = {
        input: usage.input_tokens ?? result.usage.input,
        output: usage.output_tokens ?? result.usage.output,
        cacheRead: usage.cache_read_input_tokens ?? result.usage.cacheRead,
        cacheWrite: usage.cache_creation_input_tokens ?? result.usage.cacheWrite,
      };
      result.cache = {
        readReported: !!result.cache?.readReported || typeof usage.cache_read_input_tokens === 'number',
        writeReported: !!result.cache?.writeReported || typeof usage.cache_creation_input_tokens === 'number',
      };
    }
    let seen = false;
    let complete = false;
    const env = req.model.apiKeyEnv;
    const key =
      this.#apiKey ||
      (this.#authToken ? undefined : (env ? process.env[env] : undefined) || process.env.ANTHROPIC_API_KEY);
    const bearer = key ? undefined : this.#authToken || process.env.ANTHROPIC_AUTH_TOKEN;
    // Environment-resolved credentials leak into error bodies too (e.g. an echo proxy), so they
    // participate in redaction alongside the instance-injected ones.
    const credentials = [this.#apiKey, this.#authToken, key, bearer]
      .filter((value): value is string => !!value)
      .sort((left, right) => right.length - left.length);
    const redact = (text: string) => {
      for (const credential of credentials) text = text.replaceAll(credential, '[redacted]');
      return text;
    };
    try {
      if (!key && !bearer)
        throw new Error(`Missing API key. Set ${env ?? 'ANTHROPIC_API_KEY'} or ANTHROPIC_AUTH_TOKEN.`);
      const baseUrl = req.model.baseUrl ?? process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com';
      await withRetry(
        async () => {
          const response = await fetch(endpoint(baseUrl, '/v1/messages'), {
            method: 'POST',
            signal,
            headers: {
              'content-type': 'application/json',
              'anthropic-version': '2023-06-01',
              ...(key ? { 'x-api-key': key } : { authorization: `Bearer ${bearer}` }),
            },
            body: JSON.stringify(buildAnthropicBody(req, baseUrl)),
          });
          if (!response.ok)
            throw new HTTPError(
              response.status,
              redact(await response.text()),
              response.headers.get('retry-after') ?? undefined,
            );
          if (!response.body) throw new Error('API returned an empty response body.');
          for await (const event of parseSSE(response.body, signal)) {
            seen = true;
            const data = JSON.parse(event.data) as AnthropicEvent;
            const i = data.index ?? 0;
            if (data.type === 'message_start') {
              updateUsage(data.message?.usage);
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
              updateUsage(data.usage);
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
      if (!signal.aborted) result.errorMessage = redact(errorText(error));
    }
    result.content = [...blocks.entries()].sort(([a], [b]) => a - b).map(([, b]) => b);
    return result;
  }
}
