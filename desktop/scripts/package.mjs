import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const desktop = fileURLToPath(new URL('../', import.meta.url));
// Keep extraction/staging on the project drive. EFS-encrypted system cache files
// can fail CopyFile into a differently encrypted temporary directory on Windows.
const cache = join(desktop, '.cache', 'builder');
const temporary = join(desktop, '.cache', 'temporary');
mkdirSync(cache, { recursive: true });
mkdirSync(temporary, { recursive: true });
const env = {
  ...process.env,
  ELECTRON_BUILDER_CACHE: cache,
  TEMP: temporary,
  TMP: temporary,
  CSC_IDENTITY_AUTO_DISCOVERY: 'false',
};
for (const key of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD']) delete env[key];
const child = spawn(
  process.execPath,
  [join(desktop, 'node_modules', 'electron-builder', 'cli.js'), ...process.argv.slice(2)],
  { cwd: desktop, env, windowsHide: true, stdio: 'inherit' },
);
child.once('error', (error) => {
  process.stderr.write(error.message + '\n');
  process.exitCode = 1;
});
child.once('exit', (code) => {
  process.exitCode = code ?? 1;
});
