import type { ModelInfo, ProviderId, Usage } from './types.ts';
// Conservative fallbacks, not verified model limits or availability. Override in config.
const defaults = { contextWindow: 128000, maxOutputTokens: 8192, supportsImages: true, supportsThinking: false };
export function resolveModel(
  id: string,
  overrides: Record<string, Partial<ModelInfo>> = {},
  provider?: ProviderId,
): ModelInfo {
  const entry = overrides[id];
  const family = id.startsWith('claude-') ? 'anthropic' : undefined;
  const selected = entry?.provider ?? provider ?? family;
  if (!selected) throw new Error(`Unknown model "${id}". Set provider and models.${id} in config.`);
  return { ...defaults, ...entry, id, provider: selected };
}
export function cost(usage: Usage, model: ModelInfo): number | undefined {
  const p = model.pricing;
  return p
    ? (usage.input * p.input +
        usage.output * p.output +
        usage.cacheRead * p.cacheRead +
        usage.cacheWrite * p.cacheWrite) /
        1e6
    : undefined;
}
export const zeroUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
export function addUsage(a: Usage, b: Usage): Usage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
  };
}
