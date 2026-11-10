import type { StartRunOptions } from './run.ts';
import { persistReplacement } from './run.ts';
import { buildAgent } from './build-agent.ts';
export async function compactSession(opts: StartRunOptions): Promise<boolean> {
  if (!opts.session) return false;
  const lease = opts.runtime ? await opts.runtime.acquireRun() : undefined;
  try {
    const snapshot = opts.runtimeSnapshot ?? lease?.snapshot;
    const cfg = buildAgent(
        {
          ...opts,
          runtimeSnapshot: snapshot,
          config: snapshot
            ? {
                ...snapshot.config,
                model: opts.config.model,
                provider: opts.config.provider,
                models: opts.config.models,
                thinking: opts.config.thinking,
              }
            : opts.config,
        },
        opts.session,
      ),
      r = await cfg.hooks.beforeModel?.(opts.session.context().messages, { force: true });
    if (!r) return false;
    persistReplacement(opts.session, r);
    return true;
  } finally {
    await lease?.release();
  }
}
