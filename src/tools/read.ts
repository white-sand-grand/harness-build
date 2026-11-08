import { readFile, stat } from 'node:fs/promises';
import { extname } from 'node:path';
import { resolvePath } from '../util/paths.ts';
import { ToolError } from '../agent/index.ts';
import type { Tool } from '../agent/index.ts';
import type { ImageBlock } from '../ai/index.ts';
import { pathSchema, objectSchema, textResult } from './shared.ts';
export function createReadTool(description: string): Tool {
  return {
    name: 'read',
    description,
    readOnly: true,
    parameters: objectSchema(
      { path: pathSchema, offset: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1 } },
      ['path'],
    ),
    async execute(args, ctx) {
      const path = resolvePath(ctx.cwd, String(args.path));
      const info = await stat(path).catch(() => {
        throw new ToolError(
          `File not found: ${path}. Current directory is ${ctx.cwd}. Use bash ls or find to locate it.`,
        );
      });
      if (info.isDirectory()) throw new ToolError(`${path} is a directory. Use bash ls to list its contents.`);
      const images: Record<string, ImageBlock['mediaType']> = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
      };
      const mediaType = images[extname(path).toLowerCase()];
      if (mediaType && info.size > 5 * 1024 * 1024)
        throw new ToolError('Image exceeds the 5MB limit. Resize it before reading.');
      const data = await readFile(path);
      if (mediaType) return { content: [{ type: 'image', mediaType, data: data.toString('base64') }] };
      if (data.subarray(0, 8192).includes(0))
        throw new ToolError(
          `"${path}" looks like a binary file (${data.length} bytes). Use bash (e.g. xxd, file) to inspect it.`,
        );
      if (!data.length) return textResult('[File is empty]');
      const lines = data.toString('utf8').split(/\r?\n/);
      if (lines.at(-1) === '') lines.pop();
      const offset = Number(args.offset ?? 1),
        limit = Math.min(Number(args.limit ?? 2000), 2000);
      const page = lines
        .slice(offset - 1, offset - 1 + limit)
        .map(
          (line, i) =>
            `${String(offset + i).padStart(6)}\t${line.length > 2000 ? line.slice(0, 2000) + '…[line truncated]' : line}`,
        );
      if (offset - 1 + limit < lines.length)
        page.push(
          `[Showing lines ${offset}-${offset + limit - 1} of ${lines.length}. Use offset=${offset + limit} to continue.]`,
        );
      return textResult(page.join('\n'));
    },
  };
}
