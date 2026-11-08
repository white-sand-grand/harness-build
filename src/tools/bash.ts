import type { Tool } from '../agent/index.ts';
import { runCommand, type Shell } from '../util/process.ts';
import { objectSchema, textResult } from './shared.ts';
export function createBashTool(description: string, shell?: Shell): Tool {
  return {
    name: 'bash',
    description,
    readOnly: false,
    parameters: objectSchema(
      {
        command: { type: 'string', description: 'Command in the current shell syntax' },
        timeout: { type: 'integer', minimum: 1, maximum: 600 },
      },
      ['command'],
    ),
    async execute(args, ctx) {
      const r = await runCommand(String(args.command), {
        cwd: ctx.cwd,
        timeoutSec: Number(args.timeout ?? 120),
        signal: ctx.signal,
        onUpdate: ctx.onUpdate,
        shell,
      });
      const status = r.timedOut
        ? `[timed out after ${Number(args.timeout ?? 120)}s; process killed]`
        : r.aborted
          ? '[aborted; process killed]'
          : r.signal
            ? `[killed by ${r.signal}]`
            : `[exit code: ${r.exitCode}]`;
      return textResult(`${r.output}\n${status}`, {
        exitCode: r.exitCode,
        timedOut: r.timedOut,
        aborted: r.aborted,
        truncated: r.truncated,
      });
    },
  };
}
