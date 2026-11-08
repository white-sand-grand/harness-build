import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { projectSlug } from '../util/paths.ts';
export const memoryDir = (home: string, cwd: string) => join(home, 'projects', projectSlug(cwd), 'memory');
export function readIndex(dir: string): { text: string; truncated: boolean } {
  const path = join(dir, 'MEMORY.md');
  if (!existsSync(path)) return { text: '', truncated: false };
  const raw = readFileSync(path, 'utf8'),
    lines = raw.split('\n');
  let text = lines.slice(0, 200).join('\n');
  const truncated = lines.length > 200 || Buffer.byteLength(text) > 25000;
  if (Buffer.byteLength(text) > 25000)
    text = Buffer.from(text)
      .subarray(0, 25000)
      .toString('utf8')
      .replace(/\uFFFD$/, '');
  return {
    text: text + (truncated ? '\n[Memory index truncated; use read to inspect the remaining notes.]' : ''),
    truncated,
  };
}
