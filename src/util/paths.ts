import { resolve, join, dirname, relative, isAbsolute, sep } from 'node:path';
import { homedir } from 'node:os';
import { realpathSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
export function resolvePath(cwd: string, path: string): string {
  if (path === '~' || path.startsWith('~/') || path.startsWith('~\\')) path = join(homedir(), path.slice(2));
  if (process.platform === 'win32' && /^\/[a-z]\//i.test(path)) path = path[1]!.toUpperCase() + ':/' + path.slice(3);
  return resolve(cwd, path);
}
export function realPath(path: string): string {
  let parent = resolve(path);
  const suffix: string[] = [];
  while (!existsSync(parent)) {
    const next = dirname(parent);
    if (next === parent) break;
    suffix.unshift(parent.slice(next.length + (next.endsWith(sep) ? 0 : 1)));
    parent = next;
  }
  return join(realpathSync(parent), ...suffix);
}
export function isWithin(root: string, path: string): boolean {
  const base = process.platform === 'win32' ? root.toLowerCase() : root;
  const target = process.platform === 'win32' ? path.toLowerCase() : path;
  const rel = relative(base, target);
  return rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel));
}
export function projectRoot(cwd: string): string {
  const r = spawnSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', windowsHide: true });
  return r.status === 0 ? resolve(r.stdout.trim()) : resolve(cwd);
}
export function projectSlug(cwd: string): string {
  const root = projectRoot(cwd);
  return (
    root.replace(/[^A-Za-z0-9]/g, '-').slice(0, 100) + '-' + createHash('sha256').update(root).digest('hex').slice(0, 8)
  );
}
