import type { ModelRequest, Provider, StreamEvent, AssistantMessage, ImageBlock } from './types.ts';
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
  status?: string;
  output?: ResponseItem[];
  usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } };
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
export function buildOpenAIBody(req: ModelRequest) {
  const input: Record<string, unknown>[] = [];
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
  return {
    model: req.model.id,
    instructions: req.system,
    input,
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
    ...(req.thinking && req.thinking !== 'off' && req.model.supportsThinking
      ? { reasoning: { effort: req.thinking, summary: 'auto' } }
      : {}),
  };
}
export class OpenAIProvider implements Provider {
  readonly id = 'openai';
  private retrySleep?: Sleep;
  constructor(opts: { sleep?: Sleep } = {}) {
    this.retrySleep = opts.sleep;
  }
  async stream(req: ModelRequest, signal: AbortSignal, onEvent: (e: StreamEvent) => void): Promise<AssistantMessage> {
    const result = emptyAssistant(req, this.id),
      items = new Map<number, ResponseItem>(),
      texts = new Map<number, string>(),
      thoughts = new Map<number, string>(),
      completeCalls = new Set<number>(),
      announced = new Set<string>();
    let seen = false,
      terminal = false;
    const announce = (item: ResponseItem) => {
      if (item.type === 'function_call' && item.call_id && item.name && !announced.has(item.call_id)) {
        announced.add(item.call_id);
        onEvent({ type: 'toolCallStart', id: item.call_id, name: item.name });
      }
    };
    try {
      const env = req.model.apiKeyEnv ?? 'OPENAI_API_KEY',
        key = process.env[env];
      if (!key) throw new Error(`Missing API key. Set ${env} (for a local server, a placeholder value is sufficient).`);
      await withRetry(
        async () => {
          const response = await fetch(
            endpoint(req.model.baseUrl ?? process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1', '/v1/responses'),
            {
              method: 'POST',
              signal,
              headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
              body: JSON.stringify(buildOpenAIBody(req)),
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
                cached = u?.input_tokens_details?.cached_tokens ?? 0;
              result.usage = {
                input: Math.max(0, (u?.input_tokens ?? 0) - cached),
                output: u?.output_tokens ?? 0,
                cacheRead: cached,
                cacheWrite: 0,
              };
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
      if (!signal.aborted) result.errorMessage = errorText(error);
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
