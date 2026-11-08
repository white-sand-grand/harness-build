import type { AssistantMessage, ModelRequest, ProviderId } from './types.ts';
import { zeroUsage } from './models.ts';
export function emptyAssistant(req: ModelRequest, provider: ProviderId): AssistantMessage {
  return { role: 'assistant', content: [], stopReason: 'error', usage: zeroUsage(), model: req.model.id, provider };
}
export function parseArgs(raw: string): Record<string, unknown> {
  try {
    const args: unknown = JSON.parse(raw || '{}');
    if (args && typeof args === 'object' && !Array.isArray(args)) return args as Record<string, unknown>;
  } catch {
    /* The model receives malformed arguments and can correct its next call. */
  }
  return { __invalidJson: raw };
}
export function endpoint(base: string, suffix: string): string {
  const clean = base.replace(/\/+$/, '');
  return clean.endsWith(suffix) ? clean : clean + (clean.endsWith('/v1') ? suffix.replace(/^\/v1/, '') : suffix);
}
