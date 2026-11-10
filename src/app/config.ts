import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ProviderId, ThinkingLevel, ModelInfo } from '../ai/index.ts';
import { projectRoot } from '../util/paths.ts';
import { validateConfig } from './config-schema.ts';
import { isProjectTrusted, trustProjectHooks } from '../hooks/trust.ts';
import type { RuntimeConfig } from './plugin-types.ts';
export type HookCommand = { match?: string; command: string; timeoutSec?: number };
export type Config = {
  provider: ProviderId;
  model: string;
  thinking: ThinkingLevel;
  models: Record<string, Partial<ModelInfo>>;
  permissions: { mode: 'ask' | 'yolo'; extraRiskyPatterns: string[] };
  hooks: { afterEdit: HookCommand[]; onStop: HookCommand[]; maxStopContinuations: number };
  compaction: { enabled: boolean; clearAtRatio: number; compactAtRatio: number; keepRecentTokens: number };
  toolOutput: { maxChars: number; maxLines: number };
  promptsDir?: string;
  runtime?: RuntimeConfig;
};
export function defaultConfig(): Config {
  return {
    provider: 'anthropic',
    model: 'claude-sonnet-5-5',
    thinking: 'off',
    models: {},
    permissions: { mode: 'ask', extraRiskyPatterns: [] },
    hooks: { afterEdit: [], onStop: [], maxStopContinuations: 2 },
    compaction: { enabled: true, clearAtRatio: 0.6, compactAtRatio: 0.8, keepRecentTokens: 20000 },
    toolOutput: { maxChars: 30000, maxLines: 2000 },
  };
}
export function mergeConfig(base: Config, override: Partial<Config>): Config {
  return {
    ...base,
    ...override,
    models: { ...base.models, ...override.models },
    permissions: { ...base.permissions, ...override.permissions },
    hooks: { ...base.hooks, ...override.hooks },
    compaction: { ...base.compaction, ...override.compaction },
    toolOutput: { ...base.toolOutput, ...override.toolOutput },
    ...((base.runtime || override.runtime) && {
      runtime: {
        ...base.runtime,
        ...override.runtime,
        profiles: { ...base.runtime?.profiles, ...override.runtime?.profiles },
      },
    }),
  };
}
export function loadConfig(opts: {
  home: string;
  cwd: string;
  overrides?: Partial<Config>;
  trustProject?: boolean;
  warn?: (s: string) => void;
}): Config {
  let config = defaultConfig();
  const root = projectRoot(opts.cwd),
    projectPath = join(root, '.mh', 'config.json');
  for (const path of [join(opts.home, 'config.json'), projectPath])
    if (existsSync(path)) {
      let data: Partial<Config>;
      try {
        data = JSON.parse(readFileSync(path, 'utf8')) as Partial<Config>;
      } catch (error) {
        throw new Error(`Invalid config ${path}: ${error instanceof Error ? error.message : String(error)}`);
      }
      validateConfig(data, path);
      if (path === projectPath && data.hooks) {
        if (opts.trustProject) trustProjectHooks(opts.home, root, data.hooks);
        if (!isProjectTrusted(opts.home, root, data.hooks)) {
          opts.warn?.('Project hooks ignored until trusted. Review them and use --trust-project to enable.');
          data = { ...data };
          delete data.hooks;
        }
      }
      config = mergeConfig(config, data);
    }
  validateConfig(opts.overrides ?? {}, 'CLI overrides');
  config = mergeConfig(config, opts.overrides ?? {});
  if (config.compaction.clearAtRatio > config.compaction.compactAtRatio)
    throw new Error('compaction.clearAtRatio must be <= compactAtRatio');
  for (const pattern of config.permissions.extraRiskyPatterns)
    try {
      new RegExp(pattern, 'i');
    } catch {
      throw new Error('Invalid permissions.extraRiskyPatterns regex');
    }
  return config;
}
export function untrustedProjectHooks(home: string, cwd: string): unknown | undefined {
  const root = projectRoot(cwd),
    path = join(root, '.mh', 'config.json');
  if (!existsSync(path)) return undefined;
  const data = JSON.parse(readFileSync(path, 'utf8')) as Partial<Config>;
  validateConfig(data, path);
  return data.hooks && !isProjectTrusted(home, root, data.hooks) ? data.hooks : undefined;
}
