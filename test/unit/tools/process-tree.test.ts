import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runCommand } from '../../../src/util/process.ts';
import { withTmpDir } from '../../helpers/tmp.ts';
test('timeout kills descendants that ignore SIGTERM and close inherited output', async () =>
  withTmpDir(async (d) => {
    const command =
      "node -e \"const c=require('child_process').spawn(process.execPath,['-e','process.on(\\\"SIGTERM\\\",()=>{});setTimeout(()=>{},30000)'],{stdio:'ignore'});require('fs').writeFileSync('resistant.pid',String(c.pid));setTimeout(()=>{},30000)\"";
    const r = await runCommand(command, { cwd: d, timeoutSec: 1 });
    assert.ok(r.timedOut);
    const pid = Number(await readFile(join(d, 'resistant.pid'), 'utf8'));
    try {
      // SIGKILL delivery/reaping is asynchronous for non-child descendants.
      let alive = true;
      const deadline = Date.now() + 1000;
      while (alive && Date.now() < deadline) {
        try {
          process.kill(pid, 0);
        } catch {
          alive = false;
        }
        if (alive && process.platform !== 'win32') {
          const stat = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => '');
          alive = !!stat && !stat.includes(') Z ');
        }
        if (alive) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(alive, false, 'resistant descendant survived its parent');
    } finally {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
  }));
