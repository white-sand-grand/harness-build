import electron from 'electron';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const desktop = fileURLToPath(new URL('../', import.meta.url));
const executableIndex = process.argv.indexOf('--exe');
const executable = executableIndex >= 0 ? resolve(process.argv[executableIndex + 1]) : electron;
const temporary = mkdtempSync(join(tmpdir(), 'mh-desktop-smoke-'));
const evidence = resolve(desktop, '../.codex/desktop-mvp-checks');
mkdirSync(evidence, { recursive: true });
const report = join(evidence, `smoke-${Date.now()}.json`);
const env = {
  ...process.env,
  MH_HOME: join(temporary, 'home'),
  MH_DESKTOP_USER_DATA: join(temporary, 'app'),
  MH_DESKTOP_SMOKE_REPORT: report,
  DESKTOP_SENTINEL_API_KEY: 'smoke-sentinel-not-a-real-key',
};
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(executable, executableIndex >= 0 ? ['--mh-smoke'] : [desktop, '--mh-smoke'], {
  cwd: desktop,
  env,
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
child.stdout.on('data', (chunk) => {
  output = (output + chunk).slice(-4000);
});
child.stderr.on('data', (chunk) => {
  output = (output + chunk).slice(-4000);
});
const timer = setTimeout(() => {
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } catch {}
  } else child.kill();
}, 40000);
const exitCode = await new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('exit', resolve);
});
clearTimeout(timer);
if (exitCode !== 0) {
  process.stderr.write(output + '\n');
  throw new Error(`Desktop smoke failed (${exitCode}); report: ${report}`);
}
const result = JSON.parse(readFileSync(report, 'utf8'));
if (result.rendererEnvironmentHasSecrets || !result.hostContainment)
  throw new Error('Desktop process isolation probe failed.');
process.stdout.write(JSON.stringify({ report, ...result }, null, 2) + '\n');
