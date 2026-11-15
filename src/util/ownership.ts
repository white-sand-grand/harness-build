import { openSync, closeSync, writeFileSync, readFileSync, unlinkSync, fsyncSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';

export type OwnerRecord = { v: 1; owner: string; pid: number; host: string; platform: string; createdAt: string };
export type Ownership = { file: string; owner: string; assert(): void; release(): void };
export class OwnershipBusyError extends Error {
  readonly stale: boolean;
  constructor(file: string, stale: boolean) {
    super(`Execution ownership is busy or needs reconciliation: ${file}. Never steal a lock by timeout.`);
    this.stale = stale;
  }
}

export function readOwner(file: string): OwnerRecord {
  const value = JSON.parse(readFileSync(file, 'utf8')) as OwnerRecord;
  if (
    value.v !== 1 ||
    typeof value.owner !== 'string' ||
    !value.owner ||
    !Number.isInteger(value.pid) ||
    value.pid <= 0 ||
    typeof value.host !== 'string' ||
    typeof value.platform !== 'string'
  )
    throw new Error(`Invalid ownership record: ${file}. Reconcile it before continuing.`);
  return value;
}

/** An expired timestamp or a dead PID is not proof that the previous tool tree has stopped. */
export function acquireOwnership(file: string): Ownership {
  mkdirSync(dirname(file), { recursive: true });
  const record: OwnerRecord = {
    v: 1,
    owner: randomUUID(),
    pid: process.pid,
    host: hostname(),
    platform: process.platform,
    createdAt: new Date().toISOString(),
  };
  let fd: number;
  try {
    fd = openSync(file, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      let stale = false;
      try {
        const previous = readOwner(file);
        if (previous.host !== hostname() || previous.platform !== process.platform) stale = true;
        else
          try {
            process.kill(previous.pid, 0);
          } catch (failure) {
            stale = (failure as NodeJS.ErrnoException).code === 'ESRCH';
          }
      } catch {
        /* A lock being initialized is busy; never replace or steal it. */
      }
      throw new OwnershipBusyError(file, stale);
    }
    throw error;
  }
  try {
    writeFileSync(fd, JSON.stringify(record) + '\n');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  let released = false;
  const assert = () => {
    if (released || readOwner(file).owner !== record.owner) throw new Error(`Execution ownership was lost: ${file}`);
  };
  return {
    file,
    owner: record.owner,
    assert,
    release() {
      if (released) return;
      assert();
      unlinkSync(file);
      released = true;
    },
  };
}

/** Caller must have separately confirmed that all managed descendants have exited. */
export function assertOwnerStopped(file: string, owner: string, descendantsStopped: true): void {
  const record = readOwner(file);
  if (
    !descendantsStopped ||
    record.owner !== owner ||
    record.host !== hostname() ||
    record.platform !== process.platform
  )
    throw new Error('Ownership reconciliation does not match this host and owner.');
  try {
    process.kill(record.pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
      return;
    }
    throw error;
  }
  throw new Error('The execution owner is still alive; its lock cannot be reconciled.');
}
export function reconcileOwnership(file: string, owner: string, descendantsStopped: true): void {
  assertOwnerStopped(file, owner, descendantsStopped);
  if (readOwner(file).owner !== owner) throw new Error('Ownership changed during reconciliation.');
  unlinkSync(file);
}
