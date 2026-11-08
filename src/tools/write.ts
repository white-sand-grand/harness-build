import { writeFile, mkdir, access } from 'node:fs/promises';
import { dirname } from 'node:path';
import { resolvePath } from '../util/paths.ts';
import type { Tool } from '../agent/index.ts';
import { pathSchema, objectSchema, textResult } from './shared.ts';
export function createWriteTool(description: string): Tool {
  return {
    name: 'write',
    description,
    readOnly: false,
    parameters: objectSchema({ path: pathSchema, content: { type: 'string' } }, ['path', 'content']),
    async execute(args, ctx) {
      const path = resolvePath(ctx.cwd, String(args.path)),
        content = String(args.content);
      const created = await access(path).then(
        () => false,
        () => true,
      );
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content, 'utf8');
      return textResult(
        `Wrote ${content.split('\n').length} lines (${Buffer.byteLength(content)} bytes) to ${String(args.path)}`,
        { created },
      );
    },
  };
}
