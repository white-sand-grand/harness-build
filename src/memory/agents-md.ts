import { existsSync, readFileSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { projectRoot } from '../util/paths.ts';
export function collectInstructions(home: string, cwd: string): Array<{ path: string; content: string }> {
  const root = projectRoot(cwd),
    dirs: string[] = [];
  let dir = resolve(cwd);
  while (true) {
    dirs.unshift(dir);
    if (dir === root || dirname(dir) === dir) break;
    dir = dirname(dir);
  }
  const paths = [
    join(home, 'AGENTS.md'),
    ...dirs.map((d) => (existsSync(join(d, 'AGENTS.md')) ? join(d, 'AGENTS.md') : join(d, 'CLAUDE.md'))),
  ];
  return paths.filter(existsSync).map((path) => {
    const raw = readFileSync(path, 'utf8'),
      large = Buffer.byteLength(raw) > 32768;
    return {
      path: relative(cwd, path),
      content: large
        ? Buffer.from(raw)
            .subarray(0, 32768)
            .toString('utf8')
            .replace(/\uFFFD$/, '') + '\n[Instructions truncated at 32KB; read the file for the rest.]'
        : raw,
    };
  });
}
