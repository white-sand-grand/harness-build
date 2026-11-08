import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
export const defaultPromptsDir = fileURLToPath(new URL('../../prompts/', import.meta.url));
export type Prompts = {
  system: string;
  tools: Record<string, string>;
  compact: string;
  dream: string;
  analyze: string;
  judge: string;
  fragments: { memory: string; stopContinue: string; ralphIteration: string };
};
export function loadPrompts(dir = defaultPromptsDir): Prompts {
  const read = (path: string) => {
    const file = resolve(dir, path);
    try {
      return readFileSync(file, 'utf8');
    } catch {
      throw new Error(`Missing or unreadable prompt: ${file}`);
    }
  };
  return {
    system: read('system.md'),
    tools: Object.fromEntries(
      ['read', 'write', 'edit', 'bash'].map((name) => [name, read(join('tools', name + '.md'))]),
    ),
    compact: read('compact.md'),
    dream: read('dream.md'),
    analyze: read('analyze.md'),
    judge: read('judge.md'),
    fragments: {
      memory: read('fragments/memory.md'),
      stopContinue: read('fragments/stop-continue.md'),
      ralphIteration: read('fragments/ralph-iteration.md'),
    },
  };
}
export function renderTemplate(template: string, vars: Record<string, string | number>): string {
  return template.replace(/{{\s*(\w+)\s*}}/g, (_, name: string) => {
    if (!Object.hasOwn(vars, name)) throw new Error(`Missing prompt variable: ${name}`);
    return String(vars[name]);
  });
}
