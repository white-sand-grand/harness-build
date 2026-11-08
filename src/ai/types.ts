import type { JsonSchema } from '../util/jsonschema.ts';
export type TextBlock = { type: 'text'; text: string };
export type ImageBlock = {
  type: 'image';
  mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  data: string; /* base64 */
};
export type ThinkingBlock = { type: 'thinking'; text: string; signature?: string /* Anthropic 回传必须原样保留 */ };
export type ToolCallBlock = { type: 'toolCall'; id: string; name: string; args: Record<string, unknown> };

export type UserMessage = { role: 'user'; content: Array<TextBlock | ImageBlock> };
export type PromptCacheDiagnostics = {
  type: string;
  reason?: string;
  comparison_reusable_tokens?: number;
  cache_missed_tokens?: number;
};
export type CacheInfo = {
  readReported: boolean;
  writeReported: boolean;
  diagnostics?: PromptCacheDiagnostics;
  compatibilityFallback?: boolean;
};
export type AssistantMessage = {
  role: 'assistant';
  content: Array<TextBlock | ThinkingBlock | ToolCallBlock>;
  stopReason: StopReason;
  usage: Usage;
  model: string; // 实际产出这条消息的模型 id
  provider: ProviderId;
  /** Native Responses output, retained verbatim for encrypted reasoning and item replay. */
  responsesOutput?: Record<string, unknown>[];
  responsesId?: string;
  cache?: CacheInfo;
  errorMessage?: string; // stopReason === 'error' 时必填，人类可读
};
export type ToolResultMessage = {
  role: 'toolResult';
  toolCallId: string;
  toolName: string;
  content: Array<TextBlock | ImageBlock>;
  isError: boolean;
};
export type Message = UserMessage | AssistantMessage | ToolResultMessage;

export type StopReason = 'end' | 'toolUse' | 'maxTokens' | 'aborted' | 'error';
export type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number };
export type ProviderId = 'anthropic' | 'openai';

export type ToolSpec = { name: string; description: string; parameters: JsonSchema };

export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high';

export type ModelRequest = {
  model: ModelInfo;
  system: string;
  /** Character offset ending the reusable system prefix; omitted means the whole system. */
  systemCacheBoundary?: number;
  messages: Message[];
  tools: ToolSpec[];
  maxOutputTokens?: number; // 缺省用 model.maxOutputTokens
  thinking?: ThinkingLevel; // 缺省 'off'
};

export type StreamEvent =
  | { type: 'textDelta'; text: string }
  | { type: 'thinkingDelta'; text: string }
  | { type: 'toolCallStart'; id: string; name: string }
  | { type: 'toolCallDelta'; id: string; argsText: string }; // 原始 JSON 片段，仅供 UI 预览

export interface Provider {
  readonly id: ProviderId;
  /**
   * 永不因 API/网络错误而 reject：错误编码为 stopReason 'error' + errorMessage。
   * 只有编程错误（bug）才 throw。signal 触发后尽快返回 stopReason 'aborted'，content 保留已完成的部分。
   */
  stream(req: ModelRequest, signal: AbortSignal, onEvent: (e: StreamEvent) => void): Promise<AssistantMessage>;
}

export type ModelInfo = {
  id: string; // 发给 API 的 model 字符串
  provider: ProviderId;
  contextWindow: number; // token
  maxOutputTokens: number;
  supportsImages: boolean;
  supportsThinking: boolean;
  pricing?: { input: number; output: number; cacheRead: number; cacheWrite: number }; // USD / 百万 token；未知就不填
  baseUrl?: string; // 覆盖 provider 默认地址
  apiKeyEnv?: string; // 覆盖默认的密钥环境变量名
  compat?: OpenAICompat; // 仅 openai provider
};

export type OpenAICompat = {
  includeEncryptedReasoning?: boolean;
  /** Native Sol caching controls; false keeps legacy Responses gateway compatibility. */
  promptCache?: boolean;
};

export type { JsonSchema } from '../util/jsonschema.ts';
