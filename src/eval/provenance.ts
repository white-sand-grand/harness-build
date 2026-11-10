import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ModelInfo } from '../ai/index.ts';
import type { Config } from '../app/config.ts';
import { detectShell } from '../util/process.ts';
import type { EvalTask } from './task.ts';

export type RunProvenance = {
  v: 1;
  contractHash: string;
  tasksHash: string;
  taskHashes: Record<string, string>;
  evaluatorHash: string;
  harnessHash: string;
  environmentHash: string;
  effectiveConfig: Record<string, unknown>;
  model: Record<string, unknown>;
  platform: string;
  arch: string;
  node: string;
  shell: { kind: string; name: string; executable: string };
  repeat: number;
  concurrency: number;
  maxTurns: Record<string, number>;
};

export const hashText = (text: string | Buffer): string => createHash('sha256').update(text).digest('hex');
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => JSON.stringify(key) + ':' + stableJson(item))
        .join(',') +
      '}'
    );
  return JSON.stringify(value) ?? 'null';
}

export function redactText(text: string): string {
  let safe = text;
  for (const [key, value] of Object.entries(process.env))
    if (/API_?KEY|TOKEN|SECRET|PASSWORD|AUTH/i.test(key) && value && value.length >= 8)
      safe = safe.replaceAll(value, '[REDACTED]');
  return safe
    .replace(/\b(Bearer\s+)[^\s"'<>]+/gi, '$1[REDACTED]')
    .replace(/\b((?:api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*)[^\s,;&"']+/gi, '$1[REDACTED]');
}

function safeUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    url.hash = '';
    for (const key of url.searchParams.keys())
      if (/key|token|secret|password|auth|credential/i.test(key)) url.searchParams.set(key, '[REDACTED]');
    return redactText(url.toString());
  } catch {
    return '[invalid endpoint]';
  }
}

export function sanitizeForArtifact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeForArtifact);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /^(?:api[-_]?key(?:env)?|(?:access|refresh|auth)[-_]?token|token|secret|password|authorization|credentials?)$/i.test(
          key,
        )
          ? '[REDACTED]'
          : /(?:url|endpoint)$/i.test(key) && typeof item === 'string'
            ? safeUrl(item)
            : sanitizeForArtifact(item),
      ]),
    );
  return typeof value === 'string' ? redactText(value) : value;
}

function treeHash(root: string): string {
  const files: Array<[string, string, string]> = [];
  function walk(dir: string, prefix: string) {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name),
        relative = prefix + name,
        stat = lstatSync(path);
      if (stat.isSymbolicLink()) files.push([relative, 'link', readlinkSync(path)]);
      else if (stat.isDirectory()) walk(path, relative + '/');
      else if (stat.isFile()) files.push([relative, 'file', hashText(readFileSync(path))]);
      else files.push([relative, 'other', '']);
    }
  }
  if (existsSync(root)) walk(root, '');
  return hashText(stableJson(files));
}

export function createProvenance(opts: {
  tasks: EvalTask[];
  tasksDir: string;
  evaluatorTemplate: string;
  config: Config;
  model: ModelInfo;
  repeat: number;
  concurrency: number;
}): RunProvenance {
  const executionKeys = new Set([
    'path',
    'pathext',
    'comspec',
    'systemroot',
    'os',
    'lang',
    'lc_all',
    'msys2_env_conv_excl',
    'msys_no_pathconv',
    'node_options',
    'npm_config_script_shell',
  ]);
  const environmentHash = hashText(
    stableJson(
      Object.fromEntries(
        Object.entries(process.env)
          .filter(([name]) => executionKeys.has(name.toLowerCase()))
          .map(([name, value]) => [process.platform === 'win32' ? name.toUpperCase() : name, value]),
      ),
    ),
  );
  const { promptsDir: _promptsDir, models: _models, ...configuration } = opts.config;
  const endpoint =
    opts.model.baseUrl ??
    (opts.model.provider === 'anthropic'
      ? (process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com')
      : (process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1'));
  const taskHashes = Object.fromEntries(
    opts.tasks.map((task) => [
      task.id,
      hashText(stableJson({ definition: task, fixtures: treeHash(join(opts.tasksDir, task.id, 'files')) })),
    ]),
  );
  const contract = {
    v: 1 as const,
    tasksHash: hashText(stableJson(taskHashes)),
    taskHashes,
    evaluatorHash: hashText(opts.evaluatorTemplate),
    environmentHash,
    harnessHash: hashText(
      stableJson({
        source: treeHash(fileURLToPath(new URL('../', import.meta.url))),
        package: hashText(readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)))),
      }),
    ),
    effectiveConfig: sanitizeForArtifact(configuration) as Record<string, unknown>,
    model: sanitizeForArtifact({ ...opts.model, baseUrl: endpoint }) as Record<string, unknown>,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    shell: detectShell(),
    repeat: opts.repeat,
    concurrency: opts.concurrency,
    maxTurns: Object.fromEntries(opts.tasks.map((task) => [task.id, task.maxTurns ?? 30])),
  };
  return { ...contract, contractHash: hashText(stableJson(contract)) };
}

function protectedHash(workspace: string, file: string): string {
  let path = workspace;
  const parts = file.split('/');
  for (let i = 0; i < parts.length; i++) {
    path = join(path, parts[i]!);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || (i === parts.length - 1 ? !stat.isFile() : !stat.isDirectory()))
      throw new Error(`Protected file ${file} is not a regular file within ordinary directories.`);
  }
  return hashText(readFileSync(path));
}

export function snapshotProtectedFiles(workspace: string, files: string[]): Record<string, string> {
  return Object.fromEntries(files.map((file) => [file, protectedHash(workspace, file)]));
}

export function protectedFilesError(workspace: string, snapshot: Record<string, string>): string | undefined {
  for (const [file, expected] of Object.entries(snapshot)) {
    try {
      if (protectedHash(workspace, file) !== expected) return `Protected evaluation file changed: ${file}`;
    } catch {
      return `Protected evaluation file missing, replaced, or unreadable: ${file}`;
    }
  }
  return undefined;
}
