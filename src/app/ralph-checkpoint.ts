import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { SessionStore } from '../session/index.ts';
import { replaceFileDurably } from '../util/durable-file.ts';
import { isWithin } from '../util/paths.ts';
import type { CommandResult } from '../util/process.ts';
import { nonSecretEnvironment } from '../util/process.ts';

export const checkpointHash = (value: string): string => createHash('sha256').update(value).digest('hex');
export type WorkCheckpointV1 = {
  v: 1;
  revision: number;
  goal: string;
  scopeHash: string;
  phase: 'ready' | 'running' | 'finished';
  sessionIds: string[];
  prompt?: string;
  items: Array<{
    id: 'goal';
    description: string;
    state: 'todo' | 'inProgress' | 'verified' | 'blocked';
    checkIds: string[];
  }>;
  evidence?: {
    workspaceFingerprint: string;
    result: 'passed' | 'failed' | 'unknown';
    outputRef: string;
    sourceSessionId: string;
  };
  lastCheck?: CommandResult;
  lastFailure?: string;
};

/** Includes dirty/untracked files and symlink identities; never follows a link or scans the run home. */
export function workspaceFingerprint(cwd: string, home: string): string {
  const hash = createHash('sha256');
  const head = spawnSync('git', ['-C', cwd, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
    timeout: 10000,
    windowsHide: true,
    env: nonSecretEnvironment(process.env),
  });
  hash.update(head.status === 0 ? head.stdout.trim() : 'no-git-head');
  let files = 0,
    bytes = 0;
  const visit = (directory: string) => {
    for (const name of readdirSync(directory).sort()) {
      const file = join(directory, name);
      if (['.git', 'node_modules'].includes(name) || isWithin(home, file)) continue;
      const stat = lstatSync(file);
      const path = relative(cwd, file).replaceAll('\\', '/');
      if (stat.isSymbolicLink()) hash.update('link\0' + path + '\0' + readlinkSync(file) + '\0');
      else if (stat.isDirectory()) {
        hash.update('dir\0' + path + '\0');
        visit(file);
      } else if (stat.isFile()) {
        if (++files > 10000 || (bytes += stat.size) > 64 * 1024 * 1024 || stat.size > 16 * 1024 * 1024)
          throw new Error('Workspace fingerprint exceeds its bound; narrow the task workspace.');
        hash
          .update(path + '\0' + stat.mode + '\0')
          .update(readFileSync(file))
          .update('\0');
      }
    }
  };
  if (isWithin(home, cwd)) throw new Error('The Ralph workspace must not be inside its data home.');
  visit(cwd);
  return hash.digest('hex');
}

export class RalphCheckpoint {
  readonly directory: string;
  readonly session: SessionStore;
  constructor(session: SessionStore) {
    this.session = session;
    this.directory = join(session.dir, 'ralph-checkpoints');
  }
  load(): WorkCheckpointV1 | undefined {
    const record = this.session
      .entries()
      .findLast((entry) => entry.type === 'trace' && entry.name === 'hook' && entry.data.hook === 'ralphCheckpoint');
    if (record?.type !== 'trace') return undefined;
    const revision = record.data.revision;
    if (!Number.isSafeInteger(revision) || Number(revision) < 1) throw new Error('Invalid checkpoint revision.');
    const file = join(this.directory, `${revision}.json`);
    if (!existsSync(file) || lstatSync(file).size > 128 * 1024 || lstatSync(file).isSymbolicLink())
      throw new Error('Missing or oversized Ralph checkpoint.');
    const raw = readFileSync(file, 'utf8');
    if (checkpointHash(raw) !== record.data.hash)
      throw new Error('Ralph checkpoint hash mismatch; reconciliation is required.');
    const value = JSON.parse(raw) as WorkCheckpointV1;
    if (
      value.v !== 1 ||
      value.revision !== revision ||
      value.scopeHash !== record.data.scopeHash ||
      typeof value.goal !== 'string' ||
      value.goal.length > 16000 ||
      !Array.isArray(value.sessionIds) ||
      value.sessionIds.length > 1000 ||
      value.sessionIds.some((id) => typeof id !== 'string' || !/^[\w-]+$/.test(id)) ||
      !['ready', 'running', 'finished'].includes(value.phase) ||
      !Array.isArray(value.items) ||
      value.items.length !== 1 ||
      !['todo', 'inProgress', 'verified', 'blocked'].includes(value.items[0]!.state)
    )
      throw new Error('Invalid Ralph checkpoint schema.');
    return value;
  }
  save(value: WorkCheckpointV1): string {
    const revision = value.revision + 1;
    const file = join(this.directory, `${revision}.json`);
    const raw = JSON.stringify({ ...value, revision }) + '\n';
    if (Buffer.byteLength(raw) > 128 * 1024) throw new Error('Ralph checkpoint exceeds its bound.');
    const release = this.session.acquireWriter();
    try {
      const latest = this.load();
      if ((latest?.revision ?? 0) !== value.revision) throw new Error('Ralph checkpoint revision conflict.');
      mkdirSync(this.directory, { recursive: true });
      replaceFileDurably(file, raw);
      this.session.append({
        type: 'trace',
        name: 'hook',
        data: { hook: 'ralphCheckpoint', revision, scopeHash: value.scopeHash, hash: checkpointHash(raw) },
      });
      this.session.flush();
      value.revision = revision;
      return file;
    } finally {
      release();
    }
  }
}
