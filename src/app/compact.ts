import type { StartRunOptions } from './run.ts';
import { persistReplacement } from './run.ts';
import { buildAgent } from './build-agent.ts';
export async function compactSession(opts: StartRunOptions): Promise<boolean> {
  if (!opts.session) return false;
  const cfg = buildAgent(opts, opts.session),
    r = await cfg.hooks.beforeModel?.(opts.session.context().messages, { force: true });
  if (!r) return false;
  persistReplacement(opts.session, r);
  return true;
}
