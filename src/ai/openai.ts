import type {
  ModelRequest,
  Provider,
  StreamEvent,
  AssistantMessage,
  ImageBlock,
  PromptCacheDiagnostics,
} from './types.ts';
import { HTTPError, errorText } from './errors.ts';
import { withRetry, type Sleep } from './retry.ts';
import { parseSSE } from './sse.ts';
import { emptyAssistant, endpoint, parseArgs } from './shared.ts';
type ResponseItem = Record<string, unknown> & {
  type: string;
  id?: string;
  status?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  content?: { type?: string; text?: string }[];
  summary?: { type?: string; text?: string }[];
};
type ResponseData = {
  id?: string;
  status?: string;
  output?: ResponseItem[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  };
  prompt_cache_diagnostics?: PromptCacheDiagnostics;
  incomplete_details?: { reason?: string };
  error?: { code?: string; message?: string };
};
type ResponseEvent = {
  type: string;
  output_index?: number;
  content_index?: number;
  item_id?: string;
  delta?: string;
  arguments?: string;
  item?: ResponseItem;
  response?: ResponseData;
  code?: string;
  message?: string;
};
const isSol = (id: string) => /^gpt-6\.1-sol(?:-|$)/.test(id);
const nativeCache = (req: ModelRequest) => req.model.compat?.promptCache ?? isSol(req.model.id);
export function buildOpenAIBody(req: ModelRequest, useNativeCache = nativeCache(req)) {
  const input: Record<string, unknown>[] = [];
  if (useNativeCache && req.system) {
    const cut = Math.max(0, Math.min(req.system.length, req.systemCacheBoundary ?? req.system.length));
    input.push({
      role: 'developer',
      content: [
        ...(cut > 0
          ? [{ type: 'input_text', text: req.system.slice(0, cut), prompt_cache_breakpoint: { mode: 'explicit' } }]
          : []),
        ...(cut < req.system.length ? [{ type: 'input_text', text: req.system.slice(cut) }] : []),
      ],
    });
  }
  const image = (b: ImageBlock) => ({ type: 'input_image', image_url: `data:${b.mediaType};base64,${b.data}` });
  for (const m of req.messages) {
    if (m.role === 'user')
      input.push({
        role: 'user',
        content: m.content.map((b) => (b.type === 'image' ? image(b) : { type: 'input_text', text: b.text })),
      });
    else if (m.role === 'toolResult')
      input.push({
        type: 'function_call_output',
        call_id: m.toolCallId,
        output: m.content.some((b) => b.type === 'image')
          ? m.content.map((b) => (b.type === 'image' ? image(b) : { type: 'input_text', text: b.text }))
          : m.content
              .filter((b) => b.type === 'text')
              .map((b) => b.text)
              .join('\n'),
      });
    else if (m.provider === 'openai' && m.responsesOutput?.length) input.push(...structuredClone(m.responsesOutput));
    else
      for (const b of m.content) {
        if (b.type === 'text' && b.text) input.push({ role: 'assistant', content: b.text });
        if (b.type === 'toolCall')
          input.push({ type: 'function_call', call_id: b.id, name: b.name, arguments: JSON.stringify(b.args) });
      }
  }
  const previous = req.messages.findLast(
    (m) =>
      m.role === 'assistant' &&
      m.provider === 'openai' &&
      m.model === req.model.id &&
      ['end', 'toolUse'].includes(m.stopReason) &&
      !!m.responsesId,
  );
  const reasoning = {
    ...(req.thinking && req.thinking !== 'off' && req.model.supportsThinking
      ? { effort: req.thinking, summary: 'auto' }
      : {}),
    ...(useNativeCache && isSol(req.model.id) ? { context: 'all_turns' } : {}),
  };
  return {
    model: req.model.id,
    instructions: useNativeCache ? undefined : req.system,
    input,
    ...(useNativeCache
      ? {
          prompt_cache_options: {
            mode: 'implicit',
            ttl: '30m',
            ...(previous?.role === 'assistant' ? { comparison_response_id: previous.responsesId } : {}),
          },
        }
      : {}),
    ...(req.tools.length
      ? {
          tools: req.tools.map((t) => ({
            type: 'function',
            name: t.name,
            description: t.description,
            parameters: t.parameters,
            strict: false,
          })),
          parallel_tool_calls: false,
        }
      : {}),
    max_output_tokens: req.maxOutputTokens ?? req.model.maxOutputTokens,
    stream: true,
    store: false,
    ...(req.model.compat?.includeEncryptedReasoning === false ? {} : { include: ['reasoning.encrypted_content'] }),
    ...(Object.keys(reasoning).length ? { reasoning } : {}),
  };
}
export class OpenAIProvider implements Provider {
  readonly id = 'openai';
  private retrySleep?: Sleep;
  #apiKey?: string;
  private incompatibleCache = new Set<string>();
  constructor(opts: { sleep?: Sleep; apiKey?: string } = {}) {
    this.retrySleep = opts.sleep;
    this.#apiKey = opts.apiKey;
  }
  async stream(req: ModelRequest, signal: AbortSignal, onEvent: (e: StreamEvent) => void): Promise<AssistantMessage> {
    const result = emptyAssistant(req, this.id),
      items = new Map<number, ResponseItem>(),
      texts = new Map<number, string>(),
      thoughts = new Map<number, string>(),
      completeCalls = new Set<number>(),
      announced = new Set<string>();
    result.cache = { readReported: false, writeReported: false };
    let seen = false,
      terminal = false;
    const redact = (text: string) => (this.#apiKey ? text.replaceAll(this.#apiKey, '[redacted]') : text);
    const announce = (item: ResponseItem) => {
      if (item.type === 'function_call' && item.call_id && item.name && !announced.has(item.call_id)) {
        announced.add(item.call_id);
        onEvent({ type: 'toolCallStart', id: item.call_id, name: item.name });
      }
    };
    try {
      const env = req.model.apiKeyEnv ?? 'OPENAI_API_KEY',
        key = this.#apiKey || process.env[env];
      if (!key) throw new Error(`Missing API key. Set ${env} (for a local server, a placeholder value is sufficient).`);
      const url = endpoint(
        req.model.baseUrl ?? process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
        '/v1/responses',
      );
      const cacheKey = url + '\n' + req.model.id;
      await withRetry(
        async () => {
          let response: Response;
          while (true) {
            const useCache = nativeCache(req) && !this.incompatibleCache.has(cacheKey);
            if (nativeCache(req) && !useCache) result.cache!.compatibilityFallback = true;
            response = await fetch(url, {
              method: 'POST',
              signal,
              headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
              body: JSON.stringify(buildOpenAIBody(req, useCache)),
            });
            if (response.ok) break;
            const error = new HTTPError(
              response.status,
              redact(await response.text()),
              response.headers.get('retry-after') ?? undefined,
            );
            if (
              useCache &&
              error.status === 400 &&
              /unknown|unrecognized|unsupported|not supported|not permitted|unexpected/i.test(error.message) &&
              /prompt_cache_options|prompt_cache_breakpoint|reasoning[.\s'\"]+context|all_turns/i.test(error.message)
            ) {
              this.incompatibleCache.add(cacheKey);
              continue;
            }
            throw error;
          }
          if (!response.body) throw new Error('API returned an empty response body.');
          for await (const event of parseSSE(response.body, signal)) {
            seen = true;
            if (event.data === '[DONE]') continue;
            const data = JSON.parse(event.data) as ResponseEvent,
              index = data.output_index ?? 0;
            if (data.type === 'error')
              throw new Error(`${data.code ?? 'Responses error'}: ${data.message ?? 'Unknown error'}`);
            if (data.type === 'response.failed')
              throw new Error(
                `${data.response?.error?.code ?? 'Responses failed'}: ${data.response?.error?.message ?? 'Unknown error'}`,
              );
            if (data.type === 'response.output_item.added' && data.item) {
              items.set(index, data.item);
              announce(data.item);
            }
            if (data.type === 'response.output_text.delta' && typeof data.delta === 'string') {
              if (!items.has(index)) items.set(index, { type: 'message' });
              texts.set(index, (texts.get(index) ?? '') + data.delta);
              onEvent({ type: 'textDelta', text: data.delta });
            }
            if (data.type === 'response.reasoning_summary_text.delta' && typeof data.delta === 'string') {
              if (!items.has(index)) items.set(index, { type: 'reasoning' });
              thoughts.set(index, (thoughts.get(index) ?? '') + data.delta);
              onEvent({ type: 'thinkingDelta', text: data.delta });
            }
            if (data.type === 'response.function_call_arguments.delta') {
              const item = items.get(index);
              if (item?.type === 'function_call') {
                item.arguments = (item.arguments ?? '') + (data.delta ?? '');
                if (item.call_id) onEvent({ type: 'toolCallDelta', id: item.call_id, argsText: data.delta ?? '' });
              }
            }
            if (data.type === 'response.function_call_arguments.done' && items.has(index))
              items.get(index)!.arguments = data.arguments ?? items.get(index)!.arguments;
            if (data.type === 'response.output_item.done' && data.item) {
              items.set(index, data.item);
              announce(data.item);
              if (data.item.type === 'function_call') completeCalls.add(index);
            }
            if (data.type === 'response.completed' || data.type === 'response.incomplete') {
              terminal = true;
              const native = data.response;
              for (const [i, item] of (native?.output ?? []).entries()) {
                items.set(i, item);
                announce(item);
                if (
                  item.type === 'function_call' &&
                  (data.type === 'response.completed' || item.status === 'completed')
                )
                  completeCalls.add(i);
              }
              const u = native?.usage,
                details = u?.input_tokens_details,
                cached = details?.cached_tokens ?? 0,
                written = details?.cache_write_tokens ?? 0;
              result.usage = {
                input: Math.max(0, (u?.input_tokens ?? 0) - cached - written),
                output: u?.output_tokens ?? 0,
                cacheRead: cached,
                cacheWrite: written,
              };
              result.responsesId = native?.id;
              result.cache!.readReported = typeof details?.cached_tokens === 'number';
              result.cache!.writeReported = typeof details?.cache_write_tokens === 'number';
              if (native?.prompt_cache_diagnostics) result.cache!.diagnostics = native.prompt_cache_diagnostics;
              if (data.type === 'response.incomplete') {
                if (native?.incomplete_details?.reason === 'max_output_tokens') result.stopReason = 'maxTokens';
                else throw new Error(`Responses incomplete: ${native?.incomplete_details?.reason ?? 'unknown reason'}`);
              } else result.stopReason = 'end';
              break;
            }
          }
          if (!terminal) throw new Error('Responses stream ended before a terminal response event. Retry the request.');
        },
        { signal, sleep: this.retrySleep, started: () => seen },
      );
    } catch (error) {
      result.stopReason = signal.aborted ? 'aborted' : 'error';
      if (!signal.aborted) result.errorMessage = redact(errorText(error));
    }
    for (const [index, item] of [...items].sort(([a], [b]) => a - b)) {
      if (item.type === 'message') {
        const text = item.content?.map((b) => b.text ?? '').join('') || texts.get(index) || '';
        if (text) {
          result.content.push({ type: 'text', text });
          if (!texts.has(index)) onEvent({ type: 'textDelta', text });
        }
      } else if (item.type === 'reasoning') {
        const text = item.summary?.map((b) => b.text ?? '').join('') || thoughts.get(index) || '';
        if (text) result.content.push({ type: 'thinking', text });
      } else if (item.type === 'function_call' && completeCalls.has(index) && item.call_id && item.name)
        result.content.push({
          type: 'toolCall',
          id: item.call_id,
          name: item.name,
          args: parseArgs(item.arguments ?? ''),
        });
    }
    if (terminal && result.stopReason !== 'error' && result.stopReason !== 'aborted')
      result.responsesOutput = [...items]
        .sort(([a], [b]) => a - b)
        .filter(([i, item]) => item.type !== 'function_call' || completeCalls.has(i))
        .map(([, item]) => item);
    if (result.stopReason === 'end' && result.content.some((b) => b.type === 'toolCall')) result.stopReason = 'toolUse';
    return result;
  }
}
