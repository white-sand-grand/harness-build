import type { Message, AssistantMessage, ToolCallBlock } from '../ai/index.ts';
import { isContextOverflow } from '../ai/index.ts';
import { ToolError } from './types.ts';
import type { AgentConfig, RunOptions, AgentEndReason, ToolResult, ContextReplacement } from './types.ts';
import { validateCall } from './validate.ts';
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
    messages.splice(0, messages.length, ...r.messages);
    emit({ type: 'contextReplaced', replacement: r });
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
  async function execute(call: ToolCallBlock): Promise<ToolResult> {
    const tool = cfg.tools.find((t) => t.name === call.name);
    if (!tool)
      return errorResult(`Unknown tool "${call.name}". Available tools: ${cfg.tools.map((t) => t.name).join(', ')}.`);
    const invalid = validateCall(tool, call);
    if (invalid) return errorResult(invalid);
    try {
      const decision = await cfg.hooks.beforeTool?.(call, tool);
      if (decision?.action === 'deny') return errorResult(decision.reason);
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
  const request = () =>
    cfg.provider.stream(
      {
        model: cfg.model,
        system: cfg.system,
        systemCacheBoundary: cfg.systemCacheBoundary,
        messages,
        tools: cfg.tools.map(({ name, description, parameters }) => ({ name, description, parameters })),
        thinking: cfg.thinking,
      },
      opts.signal,
      (event) => emit({ type: 'stream', event }),
    );
  let lastUsage: AssistantMessage['usage'] | undefined;
  let turn = 0;
  let retriedOverflow = false;
  emit({ type: 'agentStart' });
  while (true) {
    if (opts.signal.aborted) return end('aborted');
    if (cfg.maxTurns !== undefined && turn >= cfg.maxTurns) return end('maxTurns');
    emit({ type: 'turnStart', turn: ++turn });
    const replacement = await cfg.hooks.beforeModel?.(messages, { lastUsage });
    if (replacement) replace(replacement);
    let assistant = await request();
    if (assistant.stopReason === 'error' && isContextOverflow(assistant.errorMessage) && !retriedOverflow) {
      retriedOverflow = true;
      const forced = await cfg.hooks.beforeModel?.(messages, { lastUsage, force: true });
      if (forced) {
        replace(forced);
        assistant = await request();
      }
    }
    lastUsage = assistant.usage;
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
    for (const call of calls) {
      emit({ type: 'toolStart', call });
      const started = Date.now();
      const result = opts.signal.aborted
        ? errorResult('Tool call was not executed: the user interrupted the run.')
        : await execute(call);
      emit({ type: 'toolEnd', call, result, durationMs: Date.now() - started });
      appendResult(call, result);
    }
    for (const m of opts.getSteering?.() ?? []) push(m);
  }
}
