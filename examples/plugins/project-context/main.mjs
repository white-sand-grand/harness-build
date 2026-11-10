import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

const ignored = new Set(['node_modules', 'dist', 'coverage']);
const visible = (entry) => !entry.name.startsWith('.') && !ignored.has(entry.name) && !entry.isSymbolicLink();
const text = (value, details) => ({ content: [{ type: 'text', text: value }], details });
const memoryFile = (ctx) =>
  join(ctx.home, 'examples', 'project-context', createHash('sha256').update(resolve(ctx.cwd)).digest('hex') + '.json');

async function recentTasks(ctx) {
  ctx.signal.throwIfAborted();
  try {
    const value = JSON.parse(await readFile(memoryFile(ctx), 'utf8'));
    if (!Array.isArray(value)) throw new Error('Project memory must contain an array.');
    return value.filter((item) => typeof item?.task === 'string' && typeof item?.at === 'string').slice(-5);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

export default {
  id: 'project',
  version: '1.0.0',
  tools: [
    {
      name: 'find_file',
      description:
        '在当前项目中按相对路径的片段查找文件。跳过隐藏目录、node_modules、dist、coverage 和符号链接；最多检查 10000 个条目、6 层目录，返回最多 30 条路径。',
      parameters: {
        type: 'object',
        properties: { needle: { type: 'string', description: '要匹配的路径片段，例如 config 或 src/app' } },
        required: ['needle'],
        additionalProperties: false,
      },
      readOnly: true,
      async execute(args, ctx) {
        const needle = String(args.needle ?? '')
          .trim()
          .toLowerCase();
        if (!needle || needle.length > 120) throw new Error('needle 必须为 1–120 个字符的路径片段。');
        const root = resolve(ctx.cwd),
          queue = [{ directory: root, depth: 0 }],
          found = [];
        let visited = 0;
        while (queue.length && visited < 10000 && found.length < 30) {
          ctx.signal.throwIfAborted();
          const { directory, depth } = queue.shift();
          const entries = (await readdir(directory, { withFileTypes: true }))
            .filter(visible)
            .sort((a, b) => a.name.localeCompare(b.name));
          for (const entry of entries) {
            if (++visited > 10000 || found.length >= 30) break;
            const path = join(directory, entry.name),
              name = relative(root, path).replaceAll('\\', '/');
            if (entry.isDirectory() && depth < 6) queue.push({ directory: path, depth: depth + 1 });
            else if (entry.isFile() && name.toLowerCase().includes(needle)) found.push(name);
          }
        }
        return text(found.length ? found.join('\n') : '在本次检索范围内没有找到匹配文件。', {
          visited,
          limitReached: visited >= 10000 || found.length >= 30,
        });
      },
    },
  ],
  context: [
    {
      id: 'overview',
      async provide(ctx) {
        ctx.signal.throwIfAborted();
        const entries = (await readdir(ctx.cwd, { withFileTypes: true }))
          .filter(visible)
          .sort((a, b) => a.name.localeCompare(b.name))
          .slice(0, 20);
        return `当前项目顶层条目：${entries.map((entry) => entry.name + (entry.isDirectory() ? '/' : '')).join('、')}。需要定位文件时可调用 project__find_file。`;
      },
    },
  ],
  memory: [
    {
      id: 'recent',
      async recall(ctx) {
        const notes = await recentTasks(ctx);
        return notes.length
          ? '最近完成的任务（历史记录）：\n' + notes.map((note) => `${note.at}: ${note.task}`).join('\n')
          : '';
      },
      async remember(ctx, reason) {
        if (reason !== 'done' || !ctx.prompt.trim()) return;
        const notes = await recentTasks(ctx),
          file = memoryFile(ctx);
        notes.push({ at: new Date().toISOString(), task: ctx.prompt.trim().slice(0, 200) });
        ctx.signal.throwIfAborted();
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, JSON.stringify(notes.slice(-5), null, 2) + '\n');
      },
    },
  ],
  prompts: {
    navigation:
      '定位文件时先用 project__find_file 缩小范围，再用 read 阅读实际内容。文件路径匹配结果不能作为已经阅读源码的依据。',
  },
  hooks: [
    {
      id: 'find-hint',
      async afterTool(call, _tool, result) {
        if (call.name !== 'project__find_file' || result.isError) return result;
        return {
          ...result,
          content: [
            ...result.content,
            { type: 'text', text: '以上仅为文件路径；需要了解实现时，请继续用 read 阅读。' },
          ],
        };
      },
    },
  ],
};
