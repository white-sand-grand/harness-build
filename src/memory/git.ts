import { mkdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
function git(dir: string, args: string[]): string {
  const r = spawnSync(
    'git',
    [
      '-C',
      dir,
      '-c',
      'user.name=mini-harness',
      '-c',
      'user.email=mini-harness@localhost',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { encoding: 'utf8', windowsHide: true },
  );
  if (r.error) throw new Error('Git is required for memory snapshots and dreaming. Install Git before running dream.');
  if (r.status !== 0) throw new Error(`Memory git ${args[0]} failed: ${r.stderr.trim()}`);
  return r.stdout.trim();
}
export function ensureRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  if (!existsSync(join(dir, '.git'))) {
    git(dir, ['init']);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '--allow-empty', '-m', 'init memory']);
  }
}
export const gitHead = (dir: string) => git(dir, ['rev-parse', 'HEAD']);
export function commitAll(dir: string, msg: string): string | null {
  git(dir, ['add', '-A']);
  if (!git(dir, ['status', '--porcelain'])) return null;
  git(dir, ['commit', '-m', msg]);
  return gitHead(dir);
}
export const diffStat = (dir: string, from: string, to: string) => git(dir, ['diff', '--stat', from, to]);
export async function memoryUndo(
  dir: string,
  confirm: (stat: string) => Promise<boolean>,
): Promise<{ undone: boolean; stat: string; sha?: string }> {
  const subject = git(dir, ['log', '-1', '--format=%s']);
  if (!subject.startsWith('dream:')) throw new Error('Only the latest dream commit can be undone.');
  if (git(dir, ['status', '--porcelain']))
    throw new Error('Memory has uncommitted changes. Save them before undoing a dream.');
  const stat = git(dir, ['show', '--stat', '--format=short', 'HEAD']);
  if (!(await confirm(stat))) return { undone: false, stat };
  git(dir, ['revert', '--no-edit', 'HEAD']);
  return { undone: true, stat, sha: gitHead(dir) };
}
