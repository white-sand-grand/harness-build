import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { isWithin, realPath } from '../util/paths.ts';
import { defaultPromptsDir, type Prompts } from './prompts.ts';
import type { Config } from './config.ts';
import type { RuntimeProfile } from './plugin-types.ts';

export const promptFiles = [
  'system.md',
  'tools/read.md',
  'tools/write.md',
  'tools/edit.md',
  'tools/bash.md',
  'compact.md',
  'dream.md',
  'analyze.md',
  'judge.md',
  'fragments/memory.md',
  'fragments/stop-continue.md',
  'fragments/ralph-iteration.md',
] as const;
const digest = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
export function readPromptSelection(
  config: Config,
  profile: RuntimeProfile,
  cwd: string,
): {
  prompts: Prompts;
  hash: string;
  directory: string;
} {
  let directory = resolve(cwd, profile.promptsDir ?? config.promptsDir ?? defaultPromptsDir);
  let expected: { hash?: unknown; files?: Record<string, unknown> } | undefined;
  if (profile.promptsDir && profile.promptArtifact) throw new Error('Choose promptsDir or promptArtifact, not both.');
  if (profile.promptArtifact) {
    const file = resolve(cwd, profile.promptArtifact);
    if (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()) throw new Error('Invalid prompt artifact file.');
    const value = JSON.parse(readFileSync(file, 'utf8'));
    if (
      value?.v !== 1 ||
      !['recommend', 'unchanged'].includes(value.decision) ||
      typeof value.promptsDir !== 'string' ||
      isAbsolute(value.promptsDir) ||
      !value.files ||
      typeof value.files !== 'object' ||
      Array.isArray(value.files)
    )
      throw new Error('Invalid or unapproved prompt artifact.');
    directory = resolve(dirname(file), value.promptsDir);
    if (!isWithin(realPath(dirname(file)), realPath(directory))) throw new Error('Prompt artifact escapes its root.');
    expected = value;
  }
  const hash = createHash('sha256');
  const texts: Record<string, string> = {};
  if (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory())
    throw new Error('Invalid prompt directory.');
  for (const name of promptFiles) {
    let current = directory;
    for (const part of name.split('/')) {
      current = join(current, part);
      if (lstatSync(current).isSymbolicLink()) throw new Error('Prompt files must not use symlinks.');
    }
    const text = readFileSync(current, 'utf8');
    texts[name] = text;
    if (expected && expected.files?.[name] !== digest(Buffer.from(text)))
      throw new Error(`Prompt artifact changed: ${name}`);
    hash.update(JSON.stringify([name, text]) + '\n');
  }
  const bundleHash = hash.digest('hex');
  if (expected && (expected.hash !== bundleHash || Object.keys(expected.files!).length !== promptFiles.length))
    throw new Error('Prompt artifact hash or file list does not match.');
  const get = (name: (typeof promptFiles)[number]) => texts[name]!;
  return {
    prompts: {
      system: get('system.md'),
      tools: Object.fromEntries(['read', 'write', 'edit', 'bash'].map((name) => [name, texts[`tools/${name}.md`]!])),
      compact: get('compact.md'),
      dream: get('dream.md'),
      analyze: get('analyze.md'),
      judge: get('judge.md'),
      fragments: {
        memory: get('fragments/memory.md'),
        stopContinue: get('fragments/stop-continue.md'),
        ralphIteration: get('fragments/ralph-iteration.md'),
      },
    },
    hash: bundleHash,
    directory,
  };
}
export function writePromptSelection(prompts: Prompts, directory: string) {
  const texts: Record<string, string> = {
    'system.md': prompts.system,
    'compact.md': prompts.compact,
    'dream.md': prompts.dream,
    'analyze.md': prompts.analyze,
    'judge.md': prompts.judge,
    'fragments/memory.md': prompts.fragments.memory,
    'fragments/stop-continue.md': prompts.fragments.stopContinue,
    'fragments/ralph-iteration.md': prompts.fragments.ralphIteration,
    ...Object.fromEntries(Object.entries(prompts.tools).map(([name, text]) => [`tools/${name}.md`, text])),
  };
  for (const name of promptFiles) {
    const file = join(directory, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, texts[name]!);
  }
}
