import { join } from 'node:path';
import { acquireOwnership, type Ownership } from '../../util/ownership.ts';
import { projectRoot, realPath } from '../../util/paths.ts';
import { createHash } from 'node:crypto';

export function workspaceOwnerFile(home: string, cwd: string): string {
  const root = realPath(projectRoot(cwd));
  const canonical = process.platform === 'win32' ? root.toLowerCase() : root;
  return join(home, 'background', 'owners', createHash('sha256').update(canonical).digest('hex') + '.lock');
}
export function acquireWorkspace(home: string, cwd: string): Ownership {
  return acquireOwnership(workspaceOwnerFile(home, cwd));
}
