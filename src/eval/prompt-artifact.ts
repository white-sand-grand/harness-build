import { createHash } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { isWithin, realPath } from '../util/paths.ts';
import { PROMPT_FILES, promptHash } from './candidate.ts';
import type { PromptOptimizer } from './optimizer.ts';

export type PromptArtifact = {
  v: 1;
  decision: 'recommend' | 'unchanged';
  optimizer: Pick<PromptOptimizer, 'id' | 'version'>;
  hash: string;
  promptsDir: string;
  files: Record<string, string>;
  parentHash: string;
};

export function writePromptArtifact(opts: {
  outputDir: string;
  promptsDir: string;
  decision: PromptArtifact['decision'];
  optimizer: PromptArtifact['optimizer'];
  parentHash: string;
}): PromptArtifact {
  const output = resolve(opts.outputDir),
    prompts = resolve(opts.promptsDir);
  if (!isWithin(output, prompts) || !isWithin(realPath(output), realPath(prompts)))
    throw new Error('Published prompts must remain inside the evolution output directory.');
  const artifact: PromptArtifact = {
    v: 1,
    decision: opts.decision,
    optimizer: { id: opts.optimizer.id, version: opts.optimizer.version },
    hash: promptHash(prompts),
    promptsDir: relative(output, prompts).split(sep).join('/'),
    files: Object.fromEntries(
      PROMPT_FILES.map((file) => [
        file,
        createHash('sha256')
          .update(readFileSync(join(prompts, file)))
          .digest('hex'),
      ]),
    ),
    parentHash: opts.parentHash,
  };
  const path = join(output, 'prompt-artifact.json');
  writeFileSync(path + '.tmp', JSON.stringify(artifact, null, 2) + '\n', { flag: 'wx' });
  renameSync(path + '.tmp', path);
  return artifact;
}
