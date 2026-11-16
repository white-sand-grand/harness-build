import type { Message, AssistantMessage, ToolCallBlock, ModelRequest } from '../ai/index.ts';
import { isContextOverflow } from '../ai/index.ts';
import { ToolError } from './types.ts';
import type { AgentConfig, RunOptions, AgentEndReason, ToolResult, ContextReplacement } from './types.ts';
import { validateCall } from './validate.ts';
/** Extremely deep tool arguments crash JSON.stringify (V8 recursion) when persisting the transcript. */
const MAX_ARGS_DEPTH = 64;
const MAX_TOKEN_CONTINUATIONS = 3;
function argsDepth(value: unknown): number {
  let max = 0;
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  while (stack.length) {
    const { value: current, depth } = stack.pop()!;
    max = Math.max(max, depth);
    if (current && typeof current === 'object' && depth <= MAX_ARGS_DEPTH)
      for (const child of Array.isArray(current) ? current : Object.values(current))
        stack.push({ value: child, depth: depth + 1 });
  }
  return max;
}
export async function runAgent(cfg: AgentConfig, messages: Message[], opts: RunOptions): Promise<AgentEndReason> {
  const emit = opts.onEvent;
  const push = (message: Message) => {
    messages.push(message);
    emit({ type: 'message', message });
  };
  const errorResult = (text: string): ToolResult => ({ isError: true, content: [{ type: 'text', text }] });
  const end = (reason: AgentEndReason, error?: string) => {
    emit({ type: 'agentEnd', reason, ...(error ? { error } : {}) });
    return reason;
  };
  function replace(r: ContextReplacement) {
    lastUsage = undefined;
    previousRequest = undefined;
    emit({ type: 'contextReplaced', replacement: r });
    messages.splice(0, messages.length, ...r.messages);
  }
  function appendResult(call: ToolCallBlock, result: ToolResult) {
    push({
      role: 'toolResult',
      toolCallId: call.id,
      toolName: call.name,
      content: result.content,
      isError: !!result.isError,
    });
  }
  async function execute(call: ToolCallBlock): Promise<ToolResult | { defer: string }> {
    const tool = cfg.tools.find((t) => t.name === call.name);
    if (!tool)
      return errorResult(`Unknown tool "${call.name}". Available tools: ${cfg.tools.map((t) => t.name).join(', ')}.`);
    const invalid = validateCall(tool, call);
    if (invalid) return errorResult(invalid);
    try {
      const decision = await cfg.hooks.beforeTool?.(call, tool);
      if (decision?.action === 'deny') return errorResult(decision.reason);
      if (decision?.action === 'defer') return { defer: decision.reason };
      const result = await tool.execute(call.args, {
        cwd: opts.toolContext?.cwd ?? '',
        sessionDir: opts.toolContext?.sessionDir ?? '',
        home: opts.toolContext?.home,
        signal: opts.signal,
        onUpdate: (text) => emit({ type: 'toolUpdate', callId: call.id, text }),
      });
      return (await cfg.hooks.afterTool?.(call, tool, result)) ?? result;
    } catch (error) {
      return errorResult(
        (error instanceof ToolError ? '' : 'Internal tool error: ') +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }
  const prepareRequest = async (): Promise<ModelRequest | undefined> => {
    let context: string | undefined;
    try {
      context = (await cfg.hooks.modelContext?.(messages))?.trim();
    } catch (error) {
      if (opts.signal.aborted) return undefined;
      throw error;
    }
    if (opts.signal.aborted) return undefined;
    return {
      model: cfg.model,
      system: context ? `${cfg.system}\n\n${context}` : cfg.system,
      systemCacheBoundary: cfg.systemCacheBoundary,
      messages,
      tools: cfg.tools.map(({ name, description, parameters }) => ({ name, description, parameters })),
      thinking: cfg.thinking,
    };
  };
  const request = (input: ModelRequest) =>
    cfg.provider.stream(input, opts.signal, (event) => emit({ type: 'stream', event }));
  let lastUsage: AssistantMessage['usage'] | undefined;
  let previousRequest: ModelRequest | undefined;
  let turn = 0;
  let retriedOverflow = false;
  let tokenContinuations = 0;
  async function runTools(calls: ToolCallBlock[], from = 0): Promise<boolean> {
    for (let index = from; index < calls.length; index++) {
      const call = calls[index]!;
      emit({ type: 'toolStart', call });
      const started = Date.now();
      let result = opts.signal.aborted
        ? errorResult('Tool call was not executed: the user interrupted the run.')
        : await execute(call);
      if ('defer' in result) {
        if (opts.onSuspend) {
          const batch = { calls: structuredClone(calls), nextCallIndex: index };
          const { requestId } = await opts.onSuspend(batch, result.defer);
          emit({ type: 'toolDeferred', call, batch, requestId, reason: result.defer });
          return true;
        }
        result = errorResult('This caller cannot persist a deferred tool call. The tool was not executed.');
      }
      emit({ type: 'toolEnd', call, result, durationMs: Date.now() - started });
      appendResult(call, result);
    }
    return false;
  }
  emit({ type: 'agentStart' });
  if (opts.resumeTools && (await runTools(opts.resumeTools.calls, opts.resumeTools.nextCallIndex)))
    return end('suspended');
  while (true) {
    if (opts.signal.aborted) return end('aborted');
    if (cfg.maxTurns !== undefined && turn >= cfg.maxTurns) return end('maxTurns');
    emit({ type: 'turnStart', turn: ++turn });
    let input = await prepareRequest();
    if (!input) return end('aborted');
    const replacement = await cfg.hooks.beforeModel?.(messages, { lastUsage, request: input, previousRequest });
    if (replacement) replace(replacement);
    if (opts.signal.aborted) return end('aborted');
    let assistant = await request(input);
    if (assistant.stopReason === 'error' && isContextOverflow(assistant.errorMessage) && !retriedOverflow) {
      retriedOverflow = true;
      const forced = await cfg.hooks.beforeModel?.(messages, {
        lastUsage,
        force: true,
        request: input,
        previousRequest,
      });
      if (forced) {
        replace(forced);
        input = await prepareRequest();
        if (!input) return end('aborted');
        assistant = await request(input);
      }
    }
    lastUsage = assistant.usage;
    previousRequest = { ...input, messages: [] };
    for (const block of assistant.content)
      if (block.type === 'toolCall' && argsDepth(block.args) > MAX_ARGS_DEPTH)
        block.args = { __invalidArgs: 'tool call arguments exceed the supported nesting depth' };
    push(assistant);
    const calls = assistant.content.filter((b): b is ToolCallBlock => b.type === 'toolCall');
    if (assistant.stopReason === 'aborted' || assistant.stopReason === 'error') {
      for (const call of calls) appendResult(call, errorResult('Tool call was not executed: the run was interrupted.'));
      return end(assistant.stopReason === 'aborted' ? 'aborted' : 'error', assistant.errorMessage);
    }
    if (!calls.length) {
      const steering = opts.getSteering?.() ?? [];
      if (steering.length) {
        for (const m of steering) push(m);
        continue;
      }
      if (assistant.stopReason === 'maxTokens') {
        if (++tokenContinuations > MAX_TOKEN_CONTINUATIONS)
          return end('maxTurns', 'Output token limit hit repeatedly; ending this run to avoid an unbounded loop.');
        push({
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Your previous reply was cut off by the output token limit. Continue from where you stopped.',
            },
          ],
        });
        continue;
      }
      const decision = (await cfg.hooks.onStop?.(assistant)) ?? { action: 'stop' as const };
      emit({ type: 'stopHook', decision });
      if (decision.action === 'continue') {
        push({ role: 'user', content: [{ type: 'text', text: decision.message }] });
        continue;
      }
      return end(opts.signal.aborted ? 'aborted' : 'done');
    }
    if (await runTools(calls)) return end('suspended');
    for (const m of opts.getSteering?.() ?? []) push(m);
  }
}
