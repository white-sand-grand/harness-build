import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Usage } from '../ai/index.ts';
import type { AgentEndReason } from '../agent/index.ts';
import { validateSchema, type JsonSchema } from '../util/jsonschema.ts';
import { matchesGlob } from '../util/glob.ts';
export type EvalTask = {
  id: string;
  split: 'dev' | 'heldout';
  prompt: string;
  setup?: string;
  check: { command: string; timeoutSec?: number };
  judge?: { rubric: string };
  maxTurns?: number;
  tags?: string[];
};
export type AttemptResult = {
  taskId: string;
  attempt: number;
  variant: string;
  model: string;
  status: 'pass' | 'fail' | 'setupError' | 'harnessError';
  checkExitCode?: number;
  checkOutputTail?: string;
  judge?: { score: number; pass: boolean; reason: string } | { error: string };
  turns: number;
  usage: Usage;
  cost?: number;
  durationMs: number;
  toolCalls: number;
  toolErrors: number;
  endReason: AgentEndReason;
  sessionPath: string;
};
const str: JsonSchema = { type: 'string' };
const schema: JsonSchema = {
  type: 'object',
  required: ['id', 'split', 'prompt', 'check'],
  additionalProperties: false,
  properties: {
    id: str,
    split: { type: 'string', enum: ['dev', 'heldout'] },
    prompt: str,
    setup: str,
    check: {
      type: 'object',
      required: ['command'],
      additionalProperties: false,
      properties: { command: str, timeoutSec: { type: 'integer', minimum: 1 } },
    },
    judge: { type: 'object', required: ['rubric'], additionalProperties: false, properties: { rubric: str } },
    maxTurns: { type: 'integer', minimum: 1 },
    tags: { type: 'array', items: str },
  },
};
export function loadTasks(dir: string, opts: { pattern?: string; split?: 'dev' | 'heldout' | 'all' } = {}): EvalTask[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))
    .filter((e) => matchesGlob(opts.pattern ?? '*', e.name))
    .map((e) => {
      const path = join(dir, e.name, 'task.json'),
        data: unknown = JSON.parse(readFileSync(path, 'utf8')),
        errors = validateSchema(schema, data);
      if (errors.length) throw new Error(`Invalid task ${path}: ${errors.join('; ')}`);
      const task = data as EvalTask;
      if (task.id !== e.name || !/^[-A-Za-z0-9_]+$/.test(task.id) || !task.prompt.trim() || !task.check.command.trim())
        throw new Error(`Invalid task identity/prompt/check: ${path}`);
      return task;
    })
    .filter((t) => !opts.split || opts.split === 'all' || t.split === opts.split);
}
