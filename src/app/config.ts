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
  /** Pre-read project configuration snapshot; skips the second disk read so the reviewed data is the trusted data. */
  projectData?: Partial<Config>;
}): Config {
  let config = defaultConfig();
  const root = projectRoot(opts.cwd),
    projectPath = join(root, '.mh', 'config.json');
  const projectProvided = opts.projectData !== undefined;
  for (const path of [join(opts.home, 'config.json'), projectPath]) {
    if (existsSync(path) || (path === projectPath && projectProvided)) {
      let data: Partial<Config>;
      try {
        data =
          path === projectPath && projectProvided
            ? (opts.projectData as Partial<Config>)
            : (JSON.parse(readFileSync(path, 'utf8')) as Partial<Config>);
      } catch (error) {
        throw new Error(`Invalid config ${path}: ${error instanceof Error ? error.message : String(error)}`);
      }
      validateConfig(data, path);
      if (path === projectPath) {
        // Plugin directories are NOT gated here: the runtime's plugin loader performs its own
        // fingerprint + authorization flow before any plugin code runs.
        const sensitive = sensitiveProjectSubset(data);
        if (Object.keys(sensitive).length) {
          if (opts.trustProject) trustProjectHooks(opts.home, root, sensitive);
          if (!isProjectTrusted(opts.home, root, sensitive)) {
            opts.warn?.(
              'Sensitive project configuration (hooks, permissions, models, provider, prompts) ignored until trusted. Review it and use --trust-project to enable.',
            );
            data = { ...data };
            for (const key of SENSITIVE_PROJECT_KEYS) delete data[key];
          }
        }
      }
      config = mergeConfig(config, data);
    }
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
const SENSITIVE_PROJECT_KEYS = ['hooks', 'permissions', 'models', 'model', 'provider', 'promptsDir'] as const;
function sensitiveProjectSubset(data: Partial<Config>): Record<string, unknown> {
  const subset: Record<string, unknown> = {};
  for (const key of SENSITIVE_PROJECT_KEYS) if (data[key] !== undefined) subset[key] = data[key];
  return subset;
}
/**
 * Reads the project configuration exactly once so the CLI can show the user what would be
 * trusted and pass the same snapshot to loadConfig (projectData) — no review/trust gap.
 */
export function readProjectSensitive(
  cwd: string,
): { root: string; data: Partial<Config>; sensitive: Record<string, unknown> } | undefined {
  const root = projectRoot(cwd),
    path = join(root, '.mh', 'config.json');
  if (!existsSync(path)) return undefined;
  let data: Partial<Config>;
  try {
    data = JSON.parse(readFileSync(path, 'utf8')) as Partial<Config>;
  } catch (error) {
    throw new Error(`Invalid config ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  validateConfig(data, path);
  return { root, data, sensitive: sensitiveProjectSubset(data) };
}
