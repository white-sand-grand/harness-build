import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}
export const trustHash = (hooks: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(canonical(hooks)))
    .digest('hex');
function trusted(home: string): Record<string, string[]> {
  const path = join(home, 'trusted.json');
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, string[]>;
  } catch {
    throw new Error(`Invalid trust store: ${path}`);
  }
}
export const isProjectTrusted = (home: string, root: string, hooks: unknown) =>
  trusted(home)[resolve(root)]?.includes(trustHash(hooks)) ?? false;
export function trustProjectHooks(home: string, root: string, hooks: unknown) {
  const data = trusted(home),
    key = resolve(root);
  data[key] = [...new Set([...(data[key] ?? []), trustHash(hooks)])];
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'trusted.json'), JSON.stringify(data, null, 2) + '\n');
}
