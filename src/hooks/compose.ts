import type { Hooks, ContextReplacement } from '../agent/index.ts';
export function composeHooks(...hooks: Hooks[]): Hooks {
  return {
    async modelContext(messages) {
      const parts: string[] = [];
      for (const h of hooks) {
        const part = (await h.modelContext?.(messages))?.trim();
        if (part) parts.push(part);
      }
      return parts.length ? parts.join('\n\n') : undefined;
    },
    async beforeModel(messages, info) {
      let replacement: ContextReplacement | undefined;
      for (const h of hooks) {
        const next: ContextReplacement | undefined = await h.beforeModel?.(replacement?.messages ?? messages, info);
        if (next) replacement = next;
      }
      return replacement;
    },
    async beforeTool(call, tool) {
      for (const h of hooks) {
        const d = await h.beforeTool?.(call, tool);
        if (d?.action === 'deny') return d;
      }
      return { action: 'allow' };
    },
    async afterTool(call, tool, result) {
      for (const h of hooks) result = (await h.afterTool?.(call, tool, result)) ?? result;
      return result;
    },
    async onStop(last) {
      for (const h of hooks) {
        const d = await h.onStop?.(last);
        if (d?.action === 'continue') return d;
      }
      return { action: 'stop' };
    },
  };
}
export function traceHooks(hooks: Hooks, record: (data: Record<string, unknown>) => void): Hooks {
  async function timed<T>(hook: string, run: () => Promise<T>, decision: (value: T) => string): Promise<T> {
    const start = Date.now();
    try {
      const value = await run();
      record({ hook, decision: decision(value), durationMs: Date.now() - start });
      return value;
    } catch (error) {
      record({ hook, decision: 'error', durationMs: Date.now() - start });
      throw error;
    }
  }
  return {
    modelContext: hooks.modelContext
      ? (messages) =>
          timed(
            'modelContext',
            () => hooks.modelContext!(messages),
            (r) => (r?.trim() ? 'provided' : 'empty'),
          )
      : undefined,
    beforeModel: hooks.beforeModel
      ? (messages, info) =>
          timed(
            'beforeModel',
            () => hooks.beforeModel!(messages, info),
            (r) => r?.kind ?? 'unchanged',
          )
      : undefined,
    beforeTool: hooks.beforeTool
      ? (call, tool) =>
          timed(
            'beforeTool',
            () => hooks.beforeTool!(call, tool),
            (r) => r.action,
          )
      : undefined,
    afterTool: hooks.afterTool
      ? (call, tool, result) =>
          timed(
            'afterTool',
            () => hooks.afterTool!(call, tool, result),
            (r) => (r.isError ? 'error' : 'ok'),
          )
      : undefined,
    onStop: hooks.onStop
      ? (last) =>
          timed(
            'onStop',
            () => hooks.onStop!(last),
            (r) => r.action,
          )
      : undefined,
  };
}
