import { relative } from 'node:path';
import type { Hooks } from '../agent/index.ts';
import { runCommand } from '../util/process.ts';
import { resolvePath } from '../util/paths.ts';
import { matchesGlob } from '../util/glob.ts';
import type { HookCommand } from './command-types.ts';
export function afterEditHook(opts: {
  cwd: string;
  fileCwd?: string;
  home?: string;
  commands: HookCommand[];
  signal: AbortSignal;
}): Hooks {
  return {
    async afterTool(call, _, result) {
      if (!['write', 'edit'].includes(call.name) || result.isError) return result;
      const path = resolvePath(opts.fileCwd ?? opts.cwd, String(call.args.path)),
        name = relative(opts.cwd, path);
      let current = result;
      for (const hook of opts.commands) {
        if (hook.match && !matchesGlob(hook.match, name)) continue;
        const r = await runCommand(hook.command, {
          cwd: opts.cwd,
          timeoutSec: hook.timeoutSec ?? 30,
          signal: opts.signal,
          env: { MH_FILE: path, ...(opts.home === undefined ? {} : { MH_HOME: opts.home }) },
        });
        if (r.exitCode === 0 && !r.timedOut && !r.aborted) continue;
        current = {
          ...current,
          isError: true,
          content: [
            ...current.content,
            {
              type: 'text',
              text: `\n\n[after-edit check failed: ${hook.command}]\n${r.output.slice(-3000)}${r.timedOut ? '\n[timed out]' : ''}${r.aborted ? '\n[aborted]' : ''}\nFix these problems before continuing.`,
            },
          ],
        };
      }
      return current;
    },
  };
}
