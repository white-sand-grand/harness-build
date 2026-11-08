import test from 'node:test';
import assert from 'node:assert/strict';
import { detectShell, runCommand } from '../../../src/util/process.ts';
import { withTmpDir } from '../../helpers/tmp.ts';
test('Windows Git Bash selection prefers the real shell over the launcher', () => {
  const paths = ['C:\\Git\\cmd\\git.exe', 'C:\\Git\\bin\\bash.exe', 'C:\\Git\\usr\\bin\\bash.exe'];
  const shell = detectShell({
    platform: 'win32',
    env: { PATH: 'C:\\Git\\cmd' },
    exists: (path) => paths.includes(path),
  });
  assert.equal(shell.executable, 'C:\\Git\\usr\\bin\\bash.exe');
});
if (process.platform === 'win32')
  test('Windows Git Bash timeout terminates a pipeline before its natural exit', async () =>
    withTmpDir(async (d) => {
      const shell = detectShell();
      if (shell.kind !== 'bash') return;
      const started = Date.now(),
        result = await runCommand('sleep 4 | cat', { cwd: d, timeoutSec: 1, shell });
      assert.ok(result.timedOut);
      assert.ok(Date.now() - started < 3000, 'pipeline outlived the timeout after the launcher exited');
    }));
