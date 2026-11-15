import { createHash } from 'node:crypto';
import { loadedImplementationHash } from '../../util/implementation.ts';
import { collectInstructions } from '../../memory/agents-md.ts';
import type { Config } from '../config.ts';
import { loadPrompts } from '../prompts.ts';
import type { BackgroundTask } from './types.ts';

export const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function implementationFingerprint(): string {
  return loadedImplementationHash;
}
export function backgroundContract(config: Config, cwd: string, home: string): string {
  return fingerprint({
    implementation: implementationFingerprint(),
    config,
    prompts: loadPrompts(config.promptsDir),
    instructions: collectInstructions(home, cwd),
  });
}
export function taskPolicy(task: BackgroundTask): string {
  return fingerprint({
    cwd: task.cwd,
    kind: task.kind,
    goal: task.goal,
    editablePaths: task.editablePaths ?? [],
    limits: task.limits,
    expiresAt: task.expiresAt,
  });
}
