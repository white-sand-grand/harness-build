import { dirname, resolve } from 'node:path';
import { lstatSync } from 'node:fs';
import type { Hooks } from '../agent/index.ts';
import { realPath, isWithin, resolvePath } from '../util/paths.ts';
export type Asker = (q: { title: string; detail: string }) => Promise<'once' | 'session' | 'deny'>;
function hasSymlink(path: string): boolean {
  let current = resolve(path);
  while (true) {
    try {
      if (lstatSync(current).isSymbolicLink()) return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return true;
    }
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}
export function riskyCategory(command: string, extra: RegExp[] = []): string | undefined {
  const rm = command.match(/\brm\s+([^;|\n]*)/i)?.[1] ?? '';
  if (
    (/(?:^|\s)-(?:[a-z]*r[a-z]*)(?:\s|$|")|--recursive\b/i.test(rm) &&
      /(?:^|\s)-(?:[a-z]*f[a-z]*)(?:\s|$|")|--force\b/i.test(rm)) ||
    /\b(?:Remove-Item|del|ri|rm)\b(?=[^;\n]*-Recurse\b)(?=[^;\n]*-Force\b)/i.test(command) ||
    /\b(?:Remove-Item|ri)\b(?=[^;\n]*\s-r(?:\s|$))(?=[^;\n]*\s-fo(?:rce)?(?:\s|$))/i.test(command) ||
    /\bdel\b(?=[^;\n]*\/s\b)(?=[^;\n]*\/q\b)/i.test(command) ||
    /\brmdir\b[^;\n]*\/s\b/i.test(command) ||
    /\brimraf\b/i.test(command) ||
    /\bfind\b[^;\n]*\s-delete\b/i.test(command) ||
    /\bshred\b/i.test(command) ||
    /\btruncate\b\s+-s\s+0\b/i.test(command)
  )
    return 'recursive delete';
  if (
    /\bgit\b[^;\n]*\b(?:push\b[^;\n]*(?:--force(?:-with-lease)?\b|\s-f\b|\s\+[\w./~-]+|--delete\b|--mirror\b)|reset\s+--hard\b|clean\s+(?:-[a-z]*f|--force)|checkout\s+(?:--\s+\.(?:\s|$)|-f\b|--force\b)|restore\b[^;\n]*\s(?:\.(?:\s|$)|:(?:\s|$)|:\/)|branch\s+-D\b)/.test(
      command,
    )
  )
    return 'git history';
  if (
    /\b(?:curl|wget)\b[^;\n]*\|\s*(?:ba|da|z)?sh\b/i.test(command) ||
    /\b(?:curl|wget)\b[^;\n]*\|\s*(?:python(?:3)?|node|perl|ruby|php)\b/i.test(command) ||
    (/\b(?:iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b/i.test(command) &&
      /\b(?:iex|Invoke-Expression)\b/i.test(command)) ||
    /\b(?:ba|z)?sh\b\s*<\s*\(\s*(?:curl|wget)\b/i.test(command)
  )
    return 'remote script';
  if (
    /\b(?:curl|wget)\b[^;\n]*(?:--data(?:-binary|-raw|-urlencode)?\s*(?:'|"|\s)*@|-d\s*(?:'|"|\s)*@|--form\s+[^;\s]*@|-F\s+[^;\s]*@|--upload-file\s+\S+|-T\s+\S+|--post-file=\S+)/i.test(
      command,
    ) ||
    /(?:^|[;|&]\s*)(?:cat|head|tail|base64)\b[^;\n|]*\|\s*(?:curl|wget)\b/i.test(command) ||
    /\bscp\b[^;\n]*\s\S+@\S+:/i.test(command)
  )
    return 'exfiltration';
  if (/\b(?:npm|pnpm|yarn|bun)\s+(?:install|i|add)\b|\b(?:npx|bunx)\b|\b(?:pnpm|yarn)\s+dlx\b/i.test(command))
    return 'install';
  if (
    /\b(?:mkfs(?:\.\w+)?|shutdown|reboot|Format-Volume|Clear-Disk|Initialize-Disk)\b|\bdd\b[^;\n]*\bof=\/dev\/|>\s*\/dev\/sd|\bformat\s+[a-z]:\b/i.test(
      command,
    )
  )
    return 'disk/system';
  if (
    /\bsudo\s|\bchmod\s+-[a-z]*R\b[^;\n]*777|\bchown\s+-[a-z]*R\b/i.test(command) ||
    /\b(?:schtasks\s+\/?create|reg\s+add\b|runas\b|Start-Process\b[^;\n]*-Verb\s+RunAs)\b/i.test(command)
  )
    return 'privilege';
  if (/\b(?:npm|pnpm)\s+publish\b|\bdocker\s+push\b/i.test(command)) return 'publish';
  if (
    extra.some((re) => {
      re.lastIndex = 0;
      return re.test(command);
    })
  )
    return 'custom';
  return undefined;
}
export function permissionHook(opts: {
  mode: 'ask' | 'yolo';
  root: string;
  cwd?: string;
  allowedDirs: string[];
  ask?: Asker;
  extraPatterns: RegExp[];
  strictWriteRoots?: string[];
  strictReadRoots?: string[];
  strictWritePaths?: string[];
  /** Paths tools must never write, even in yolo mode: harness-managed files such as the session transcript. */
  deniedPaths?: string[];
  approvals?: Set<string>;
}): Hooks {
  const approved = opts.approvals ?? new Set<string>();
  return {
    async beforeTool(call, tool) {
      if (tool.external) {
        if (opts.strictReadRoots || opts.strictWriteRoots || opts.strictWritePaths)
          return { action: 'deny', reason: 'Blocked: external tools are not available in restricted operations.' };
        if (opts.mode === 'yolo') return { action: 'allow' };
        const { pluginId, fingerprint } = tool.external;
        const key = JSON.stringify(['external', pluginId, fingerprint, tool.name]);
        if (approved.has(key)) return { action: 'allow' };
        if (!opts.ask)
          return {
            action: 'deny',
            reason: 'Blocked: external tools require approval and no user is available to approve this action.',
          };
        const answer = await opts.ask({
          title: `Approve external tool ${tool.name}?`,
          detail: `Plugin: ${pluginId}\nFingerprint: ${fingerprint}\nArguments: ${JSON.stringify(call.args)}`,
        });
        if (answer === 'deny')
          return {
            action: 'deny',
            reason:
              'The user denied this action. Do not retry it; ask the user how to proceed or choose a different approach.',
          };
        if (answer === 'session') approved.add(key);
        return { action: 'allow' };
      }
      if (call.name === 'read' && opts.strictReadRoots) {
        const path = resolvePath(opts.cwd ?? opts.root, String(call.args.path));
        if (hasSymlink(path) || !opts.strictReadRoots.some((root) => isWithin(realPath(root), realPath(path))))
          return {
            action: 'deny',
            reason: 'Blocked: reads are restricted to the supplied evidence and prompts; symlinks are not allowed.',
          };
      }
      if (tool.readOnly) return { action: 'allow' };
      let category: string | undefined,
        detail = '';
      if (call.name === 'write' || call.name === 'edit') {
        const path = resolvePath(opts.cwd ?? opts.root, String(call.args.path));
        const target = realPath(path);
        if (opts.deniedPaths?.some((denied) => isWithin(realPath(denied), target)))
          return {
            action: 'deny',
            reason:
              'Blocked: this file is harness-managed (the session transcript) and cannot be edited by tools. Never recreate or modify it.',
          };
        if (
          opts.strictWritePaths &&
          (hasSymlink(path) ||
            !opts.strictWritePaths.some(
              (allowed) => isWithin(realPath(allowed), target) && isWithin(target, realPath(allowed)),
            ))
        )
          return {
            action: 'deny',
            reason:
              'Blocked: only the selected prompt and proposal output files may be written; symlinks are not allowed.',
          };
        if (
          opts.strictWriteRoots &&
          (!opts.strictWriteRoots.some((root) => isWithin(realPath(root), target)) ||
            target.split(/[\\/]/).includes('.git'))
        )
          return {
            action: 'deny',
            reason: 'Blocked: writes are restricted to this operation’s output directory (excluding .git).',
          };
        if (![opts.root, ...opts.allowedDirs].some((root) => isWithin(realPath(root), target))) {
          category = 'outside:' + dirname(target);
          detail = target;
        }
      } else if (call.name === 'bash') {
        category = riskyCategory(String(call.args.command), opts.extraPatterns);
        detail = String(call.args.command);
      }
      if (opts.mode === 'yolo' || !category) return { action: 'allow' };
      const key = call.name + ':' + category;
      if (approved.has(key)) return { action: 'allow' };
      if (!opts.ask)
        return {
          action: 'deny',
          reason: `Blocked: this action matches a risky pattern (${category}) and no user is available to approve it. Choose a safer alternative or explain what you need.`,
        };
      const answer = await opts.ask({ title: `Approve ${call.name}: ${category}?`, detail });
      if (answer === 'deny')
        return {
          action: 'deny',
          reason:
            'The user denied this action. Do not retry it; ask the user how to proceed or choose a different approach.',
        };
      if (answer === 'session') approved.add(key);
      return { action: 'allow' };
    },
  };
}
