import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { win32, posix } from 'node:path';
export type Shell = { kind: 'bash' | 'powershell'; executable: string; name: string };
export function detectShell(
  opts: { platform?: string; env?: NodeJS.ProcessEnv; exists?: (p: string) => boolean } = {},
): Shell {
  const platform = opts.platform ?? process.platform,
    env = opts.env ?? process.env,
    exists = opts.exists ?? existsSync;
  const paths = (env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : ':');
  const p = platform === 'win32' ? win32 : posix;
  const find = (name: string) => paths.map((d) => p.join(d, name)).find(exists);
  if (platform !== 'win32') return { kind: 'bash', executable: find('bash') ?? '/bin/bash', name: 'bash' };
  const git = find('git.exe');
  const candidates = [
    ...(git ? [p.join(p.dirname(p.dirname(git)), 'usr', 'bin', 'bash.exe')] : []),
    ...(git ? [p.join(p.dirname(p.dirname(git)), 'bin', 'bash.exe')] : []),
    p.join(env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
    p.join(env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Git', 'bin', 'bash.exe'),
    ...paths.filter((d) => /git/i.test(d)).map((d) => p.join(d, 'bash.exe')),
  ];
  const bash = candidates.find(exists);
  if (bash) return { kind: 'bash', executable: bash, name: 'Git Bash' };
  for (const name of ['pwsh.exe', 'powershell.exe']) {
    const executable = find(name);
    if (executable) return { kind: 'powershell', executable, name: name.replace('.exe', '') };
  }
  const legacy = p.join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (exists(legacy)) return { kind: 'powershell', executable: legacy, name: 'powershell' };
  throw new Error('No shell found. Install Git for Windows or PowerShell (pwsh).');
}
export type CommandResult = {
  output: string;
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
  signal: NodeJS.Signals | null;
  truncated: boolean;
};
export async function runCommand(
  command: string,
  opts: {
    cwd: string;
    timeoutSec?: number;
    signal?: AbortSignal;
    onUpdate?: (s: string) => void;
    env?: NodeJS.ProcessEnv;
    shell?: Shell;
    maxChars?: number;
  },
): Promise<CommandResult> {
  if (opts.signal?.aborted)
    return { output: '', exitCode: null, timedOut: false, aborted: true, signal: null, truncated: false };
  const shell = opts.shell ?? detectShell();
  const args =
    shell.kind === 'bash'
      ? ['-c', command]
      : [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new(); & { ${command}\n }; if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }`,
        ];
  // Tool subprocesses must not inherit credentials from the harness environment (mirrors the
  // desktop host's safeEnvironment). Commands that genuinely need a secret can set it inline.
  const env: NodeJS.ProcessEnv = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !/(?:key|token|secret|password|credential|auth)/i.test(name)),
    ),
    PAGER: 'cat',
    GIT_PAGER: 'cat',
    GIT_TERMINAL_PROMPT: '0',
    CI: '1',
    TERM: 'dumb',
    ...opts.env,
  };
  for (const name of Object.keys(env)) if (name.startsWith('NODE_TEST_')) delete env[name];
  let executable = shell.executable,
    spawnArgs = args;
  if (process.platform === 'win32') {
    if (shell.kind === 'bash') {
      const dir = win32.dirname(shell.executable),
        root = /[\\/]usr[\\/]bin$/i.test(dir) ? win32.dirname(win32.dirname(dir)) : win32.dirname(dir);
      const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path'),
        inherited = pathKey ? env[pathKey] : '';
      for (const k of Object.keys(env)) if (k.toLowerCase() === 'path') delete env[k];
      env.PATH = win32.join(root, 'usr', 'bin') + ';' + win32.join(root, 'bin') + ';' + inherited;
    }
    env.MH_JOB_EXECUTABLE = shell.executable;
    env.MH_JOB_ARGUMENTS = JSON.stringify(args);
    executable = win32.join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const helper = readFileSync(fileURLToPath(new URL('./windows-job.ps1', import.meta.url)), 'utf8');
    spawnArgs = [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(helper, 'utf16le').toString('base64'),
    ];
  }
  return new Promise((resolve, reject) => {
    const child = spawn(executable, spawnArgs, {
      cwd: opts.cwd,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
    let buffer = '',
      head = '',
      tail = '',
      truncated = false,
      closed = false,
      timedOut = false,
      aborted = false,
      total = 0;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const cap = opts.maxChars ?? 10 * 1024 * 1024;
    const collect = (s: string) => {
      total += s.length;
      opts.onUpdate?.(s);
      if (!truncated) {
        buffer += s;
        if (buffer.length > cap) {
          truncated = true;
          head = buffer.slice(0, Math.floor(cap * 0.2));
          tail = buffer.slice(-Math.floor(cap * 0.6));
          buffer = '';
        }
      } else tail = (tail + s).slice(-Math.floor(cap * 0.6));
    };
    child.stdout.setEncoding('utf8').on('data', collect);
    child.stderr.setEncoding('utf8').on('data', collect);
    function kill() {
      if (closed || !child.pid) return;
      if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        });
        killer.on('error', () => child.kill());
      } else {
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch {}
        escalation = setTimeout(() => {
          try {
            process.kill(-child.pid!, 'SIGKILL');
          } catch {}
        }, 2000);
        escalation.unref();
      }
    }
    const timer = setTimeout(
      () => {
        timedOut = true;
        kill();
      },
      (opts.timeoutSec ?? 120) * 1000,
    );
    const abort = () => {
      aborted = true;
      kill();
    };
    opts.signal?.addEventListener('abort', abort, { once: true });
    if (opts.signal?.aborted) abort();
    function cleanup() {
      closed = true;
      clearTimeout(timer);
      if (escalation) clearTimeout(escalation);
      opts.signal?.removeEventListener('abort', abort);
    }
    child.once('error', (error) => {
      cleanup();
      reject(error);
    });
    child.once('close', (exitCode, signal) => {
      // The parent may exit before a descendant with closed stdio. Finish killing the group.
      if (process.platform !== 'win32' && (timedOut || aborted) && child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {}
      }
      cleanup();
      resolve({
        output: truncated
          ? `${head}\n[process output exceeded memory limit; ${total - head.length - tail.length} chars discarded]\n${tail}`
          : buffer,
        exitCode,
        signal,
        timedOut,
        aborted,
        truncated,
      });
    });
  });
}
