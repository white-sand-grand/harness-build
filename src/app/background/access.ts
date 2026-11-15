import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionStore } from '../../session/index.ts';

export function assertSessionAccess(session: SessionStore, guard?: (session: SessionStore, taskId: string) => void) {
  if (!existsSync(join(session.dir, 'background.json'))) return;
  if (!guard) throw new Error('This session belongs to a background task. Continue it through background controls.');
  const marker = JSON.parse(readFileSync(join(session.dir, 'background.json'), 'utf8')) as {
    v: number;
    taskId: string;
  };
  if (marker.v !== 1 || typeof marker.taskId !== 'string') throw new Error('Invalid managed session marker.');
  guard(session, marker.taskId);
}
