import type { Hooks } from '../agent/index.ts';
import { runCommand } from '../util/process.ts';
import { renderTemplate } from '../util/template.ts';
import type { HookCommand } from './command-types.ts';
export function stopCheckHook(opts: {
  cwd: string;
  commands: HookCommand[];
  maxContinuations: number;
  template: string;
  signal: AbortSignal;
  onExhausted?: (data: { command: string; outputTail: string }) => void;
}): Hooks {
  let continuations = 0;
  return {
    async onStop() {
      for (const hook of opts.commands) {
        const r = await runCommand(hook.command, {
          cwd: opts.cwd,
          timeoutSec: hook.timeoutSec ?? 120,
          signal: opts.signal,
        });
        if (r.exitCode === 0 && !r.timedOut && !r.aborted) continue;
        const outputTail = r.output.slice(-3000) + (r.timedOut ? '\n[timed out]' : '');
        if (opts.signal.aborted) return { action: 'stop' };
        if (continuations >= opts.maxContinuations) {
          opts.onExhausted?.({ command: hook.command, outputTail });
          return { action: 'stop' };
        }
        return {
          action: 'continue',
          message: renderTemplate(opts.template, {
            command: hook.command,
            outputTail,
            attempt: ++continuations,
            max: opts.maxContinuations,
          }),
        };
      }
      return { action: 'stop' };
    },
  };
}
