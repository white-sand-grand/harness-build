import { readFile, writeFile } from 'node:fs/promises';
import { resolvePath } from '../util/paths.ts';
import { ToolError } from '../agent/index.ts';
import type { Tool } from '../agent/index.ts';
import { pathSchema, objectSchema, textResult } from './shared.ts';
const normalize = (s: string) => s.replaceAll('\r\n', '\n');
export function createEditTool(description: string): Tool {
  return {
    name: 'edit',
    description,
    readOnly: false,
    parameters: objectSchema(
      { path: pathSchema, oldText: { type: 'string' }, newText: { type: 'string' }, replaceAll: { type: 'boolean' } },
      ['path', 'oldText', 'newText'],
    ),
    async execute(args, ctx) {
      const path = resolvePath(ctx.cwd, String(args.path));
      const raw = await readFile(path, 'utf8');
      const crlf = raw.includes('\r\n'),
        bom = raw.startsWith('\uFEFF');
      const content = normalize(bom ? raw.slice(1) : raw),
        oldText = normalize(String(args.oldText)).replace(/^\uFEFF/, ''),
        newText = normalize(String(args.newText));
      if (!oldText) throw new ToolError('oldText must not be empty. To create or overwrite a file use the write tool.');
      if (oldText === newText) throw new ToolError('oldText and newText are identical; this would be a no-op.');
      const positions: number[] = [];
      let next = 0;
      while ((next = content.indexOf(oldText, next)) !== -1) {
        positions.push(next);
        next += oldText.length;
      }
      if (!positions.length) {
        const hint = /^\s*\d+\t/m.test(oldText)
          ? 'oldText seems to include line-number prefixes from the read tool; remove them.'
          : oldText.trim() && content.includes(oldText.trim())
            ? 'The whitespace differs; copy the exact indentation.'
            : 'Re-read the file to get the exact current text.';
        throw new ToolError(`oldText not found in ${String(args.path)}. ${hint}`);
      }
      const lines = positions.map((p) => content.slice(0, p).split('\n').length);
      if (positions.length > 1 && !args.replaceAll)
        throw new ToolError(
          `oldText matches ${positions.length} locations in ${String(args.path)} (lines ${lines.join(', ')}). Add surrounding context to make it unique, or set replaceAll: true.`,
        );
      const updated = args.replaceAll ? content.split(oldText).join(newText) : content.replace(oldText, () => newText);
      await writeFile(path, (bom ? '\uFEFF' : '') + (crlf ? updated.replaceAll('\n', '\r\n') : updated), 'utf8');
      const diff = `--- ${String(args.path)}\n+++ ${String(args.path)}\n@@ -${lines[0]},${oldText.split('\n').length} +${lines[0]},${newText.split('\n').length} @@\n${oldText
        .split('\n')
        .map((l) => '-' + l)
        .join('\n')}\n${newText
        .split('\n')
        .map((l) => '+' + l)
        .join('\n')}`;
      return textResult(
        `Edited ${String(args.path)}: replaced ${args.replaceAll ? positions.length : 1} occurrence(s) (lines ${lines.join(', ')}).`,
        { diff: diff.slice(0, 5000) },
      );
    },
  };
}
