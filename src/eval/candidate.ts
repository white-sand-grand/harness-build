import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { detectShell } from '../util/process.ts';

export const PROMPT_TARGETS = [
  'system.md',
  'tools/read.md',
  'tools/write.md',
  'tools/edit.md',
  'tools/bash.md',
] as const;
export type PromptTarget = (typeof PROMPT_TARGETS)[number];
export const PROMPT_FILES = [
  ...PROMPT_TARGETS,
  'compact.md',
  'dream.md',
  'analyze.md',
  'judge.md',
  'fragments/memory.md',
  'fragments/stop-continue.md',
  'fragments/ralph-iteration.md',
] as const;
export type CandidateValidation = { valid: boolean; errors: string[]; changedFiles: string[]; hash: string };
const metadata = new Set(['analysis.md', 'proposal.json', 'optimizer.json']);
const variables = (text: string) => [...new Set([...text.matchAll(/{{\s*(\w+)\s*}}/g)].map((m) => m[1]!))].sort();

function readSnapshot(dir: string, errors: string[]): Map<string, string> {
  const files = new Map<string, string>();
  function walk(relative = '') {
    const path = join(dir, relative);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      errors.push(`Symbolic links are not allowed: ${relative || '.'}`);
      return;
    }
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path)) walk(relative ? `${relative}/${entry}` : entry);
    } else if (!stat.isFile()) errors.push(`Not a regular file: ${relative}`);
    else if ((PROMPT_FILES as readonly string[]).includes(relative)) files.set(relative, readFileSync(path, 'utf8'));
    else if (!metadata.has(relative) && !relative.startsWith('optimizer/')) errors.push(`Unexpected file: ${relative}`);
  }
  try {
    walk();
  } catch (error) {
    errors.push(`Cannot read prompt snapshot: ${error instanceof Error ? error.message : String(error)}`);
  }
  for (const file of PROMPT_FILES) if (!files.has(file)) errors.push(`Missing prompt: ${file}`);
  return files;
}

export function promptHash(dir: string): string {
  const errors: string[] = [];
  const files = readSnapshot(dir, errors);
  if (errors.length) throw new Error(errors.join('; '));
  return snapshotHash(files);
}

function snapshotHash(files: Map<string, string>): string {
  const hash = createHash('sha256');
  for (const file of PROMPT_FILES) hash.update(JSON.stringify([file, files.get(file) ?? null]) + '\n');
  return hash.digest('hex');
}

export function validateCandidate(opts: {
  baseDir: string;
  candidateDir: string;
  targetFile: PromptTarget;
  seenHashes?: ReadonlySet<string>;
  shellKind?: 'bash' | 'powershell';
}): CandidateValidation {
  const errors: string[] = [];
  const base = readSnapshot(opts.baseDir, errors),
    candidate = readSnapshot(opts.candidateDir, errors);
  const changedFiles = PROMPT_FILES.filter((file) => base.get(file) !== candidate.get(file));
  const hash = snapshotHash(candidate);
  if (!(PROMPT_TARGETS as readonly string[]).includes(opts.targetFile)) errors.push('Unsupported prompt target.');
  if (opts.targetFile === 'tools/bash.md' && (opts.shellKind ?? detectShell().kind) === 'powershell')
    errors.push('The bash prompt is overridden by the PowerShell tool description on this platform.');
  if (!changedFiles.length) errors.push('No prompt changes.');
  for (const file of changedFiles) if (file !== opts.targetFile) errors.push(`Frozen prompt changed: ${file}`);
  const text = candidate.get(opts.targetFile);
  if (text !== undefined) {
    if (!text.trim()) errors.push('The target prompt must not be empty.');
    if (Buffer.byteLength(text) > 16384) errors.push('The target prompt exceeds the 16 KiB limit.');
    if (JSON.stringify(variables(text)) !== JSON.stringify(variables(base.get(opts.targetFile) ?? '')))
      errors.push('The target prompt must retain exactly the original template variables.');
  }
  if (opts.seenHashes?.has(hash)) errors.push('Duplicate prompt content.');
  return { valid: errors.length === 0, errors, changedFiles, hash };
}
