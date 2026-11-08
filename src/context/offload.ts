import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Hooks } from '../agent/index.ts';
import { truncate } from '../util/truncate.ts';
export function offloadHook(cfg: { sessionDir: string; maxChars: number; maxLines: number }): Hooks {
  return {
    async afterTool(call, _, result) {
      const text = result.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
      const cut = truncate(text, cfg.maxChars, cfg.maxLines);
      if (!cut) return result;
      const dir = join(cfg.sessionDir, 'offload');
      await mkdir(dir, { recursive: true });
      const path = join(dir, call.id.replace(/[^a-zA-Z0-9_-]/g, '_') + '.txt');
      await writeFile(path, text);
      const marker = `\n…[truncated: ${cut.omittedLines} lines / ${cut.omittedChars} chars omitted. Full output saved to ${path}. Use read with offset/limit or bash grep to inspect it.]…\n`;
      return {
        ...result,
        content: [
          { type: 'text', text: cut.head + marker + cut.tail },
          ...result.content.filter((b) => b.type === 'image'),
        ],
        details: { ...(result.details && typeof result.details === 'object' ? result.details : {}), truncated: true },
      };
    },
  };
}
