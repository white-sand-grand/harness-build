import type {
  Message,
  AssistantMessage,
  ToolCallBlock,
  TextBlock,
  ImageBlock,
  Provider,
  ModelInfo,
  ThinkingLevel,
  JsonSchema,
} from '../ai/index.ts';

export type ToolContext = {
  cwd: string; // 绝对路径；工具内一切相对路径相对它解析
  home?: string; // 显式运行数据目录，作为子进程 MH_HOME 传递
  signal: AbortSignal;
  sessionDir: string; // offload 等写入位置
  onUpdate?: (partialText: string) => void; // bash 流式输出给 UI（不进上下文）
};

export type ToolResult = {
  content: Array<TextBlock | ImageBlock>; // 给模型
  details?: unknown; // 给 UI / trace（不进上下文），例如 edit 的 diff
  isError?: boolean;
};

export interface Tool {
  name: string;
  description: string; // 从 prompts/tools/<name>.md 加载
  parameters: JsonSchema;
  readOnly: boolean; // 权限层用：只读工具永远放行
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

/** 工具内部抛出它表示"可预期的失败"，message 直接给模型看（要写成可自我纠正的句子）。 */
export class ToolError extends Error {}

export type BeforeToolDecision = { action: 'allow' } | { action: 'deny'; reason: string }; // reason 进入 isError 的 tool result

export type StopDecision = { action: 'stop' } | { action: 'continue'; message: string };

export type Hooks = {
  /** 每次调模型前。可返回替换后的消息数组（压缩），并说明原因；返回 undefined 表示不变。 */
  /** force=true：上下文溢出后的被动压缩，或 /compact 手动触发——必须执行 Level 2 压缩。 */
  beforeModel?(
    messages: Message[],
    info: { lastUsage?: AssistantMessage['usage']; force?: boolean },
  ): Promise<ContextReplacement | undefined>;
  beforeTool?(call: ToolCallBlock, tool: Tool): Promise<BeforeToolDecision>;
  /** 可在结果上追加内容（例如 lint 错误）。返回新的 ToolResult。 */
  afterTool?(call: ToolCallBlock, tool: Tool, result: ToolResult): Promise<ToolResult>;
  /** 模型产出无 tool call 的回复时调用。 */
  onStop?(last: AssistantMessage): Promise<StopDecision>;
};

export type ContextReplacement = {
  messages: Message[];
  kind: 'compaction' | 'clearing';
  summary?: string; // compaction 时必填
  meta: Record<string, unknown>; // 交给 session 层持久化（例如 firstKeptIndex、clearedToolCallIds）
};

export type AgentConfig = {
  provider: Provider;
  model: ModelInfo;
  system: string;
  systemCacheBoundary?: number;
  tools: Tool[];
  hooks: Hooks; // app 层用 hooks/compose.ts 合成一个
  thinking?: ThinkingLevel;
  maxTurns?: number; // 交互模式 undefined；评测/打印模式默认 50
};

export type RunOptions = {
  /** Explicit tool IO locations; the kernel never reads process.cwd or the filesystem. */
  toolContext?: { cwd: string; sessionDir: string; home?: string };
  signal: AbortSignal;
  onEvent: (e: AgentEvent) => void;
  /** 每批工具执行完、下次调模型前调用；返回用户在运行中排队的输入。 */
  getSteering?: () => Message[];
};

export type AgentEndReason = 'done' | 'aborted' | 'error' | 'maxTurns';

export type AgentEvent =
  | { type: 'agentStart' }
  | { type: 'turnStart'; turn: number }
  | { type: 'stream'; event: import('../ai/index.ts').StreamEvent }
  | { type: 'message'; message: Message } // 每条进入上下文的消息都会发一次（持久化依据）
  | { type: 'toolStart'; call: ToolCallBlock }
  | { type: 'toolUpdate'; callId: string; text: string }
  | { type: 'toolEnd'; call: ToolCallBlock; result: ToolResult; durationMs: number }
  | { type: 'contextReplaced'; replacement: ContextReplacement }
  | { type: 'stopHook'; decision: StopDecision }
  | { type: 'agentEnd'; reason: AgentEndReason; error?: string };

// 内核唯一入口，实现在 src/agent/loop.ts（types.ts 中不放函数）。messages 会被就地追加（调用方持有同一个数组）。
// export async function runAgent(config: AgentConfig, messages: Message[], opts: RunOptions): Promise<AgentEndReason>
