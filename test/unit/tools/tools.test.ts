import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createReadTool, createWriteTool, createEditTool, createBashTool } from '../../../src/tools/index.ts';
import { offloadHook } from '../../../src/context/offload.ts';
import { detectShell, runCommand } from '../../../src/util/process.ts';
import { withTmpDir } from '../../helpers/tmp.ts';
import type { ToolContext, ToolResult } from '../../../src/agent/index.ts';
const ctx = (cwd: string, signal = new AbortController().signal): ToolContext => ({
  cwd,
  sessionDir: join(cwd, 'session'),
  signal,
});
const text = (r: ToolResult) =>
  r.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
test('reads with line numbers', async () =>
  withTmpDir(async (d) => {
    await writeFile(join(d, 'a'), 'one\ntwo\n');
    assert.equal(text(await createReadTool('').execute({ path: 'a' }, ctx(d))), '     1\tone\n     2\ttwo');
  }));
test('offset/limit paging with continuation hint', async () =>
  withTmpDir(async (d) => {
    await writeFile(join(d, 'a'), 'one\ntwo\nthree');
    const r = text(await createReadTool('').execute({ path: 'a', offset: 2, limit: 1 }, ctx(d)));
    assert.match(r, /2\ttwo/);
    assert.match(r, /offset=3/);
  }));
test('truncates long lines', async () =>
  withTmpDir(async (d) => {
    await writeFile(join(d, 'a'), 'x'.repeat(3000));
    assert.match(text(await createReadTool('').execute({ path: 'a' }, ctx(d))), /line truncated/);
  }));
test('image returns ImageBlock', async () =>
  withTmpDir(async (d) => {
    await writeFile(join(d, 'a.png'), Buffer.from([137, 80, 78, 71]));
    assert.equal((await createReadTool('').execute({ path: 'a.png' }, ctx(d))).content[0]?.type, 'image');
  }));
test('binary file → ToolError', async () =>
  withTmpDir(async (d) => {
    await writeFile(join(d, 'a'), Buffer.from([0, 1]));
    await assert.rejects(() => createReadTool('').execute({ path: 'a' }, ctx(d)), /binary/);
  }));
test('missing file hint mentions cwd', async () =>
  withTmpDir(async (d) =>
    assert.rejects(() => createReadTool('').execute({ path: 'missing' }, ctx(d)), new RegExp('Current directory')),
  ));
test('empty file', async () =>
  withTmpDir(async (d) => {
    await writeFile(join(d, 'a'), '');
    assert.equal(text(await createReadTool('').execute({ path: 'a' }, ctx(d))), '[File is empty]');
  }));
test('directory → hint', async () =>
  withTmpDir(async (d) => assert.rejects(() => createReadTool('').execute({ path: '.' }, ctx(d)), /directory.*ls/i)));
test('creates parent dirs', async () =>
  withTmpDir(async (d) => {
    await createWriteTool('').execute({ path: 'nested/a', content: 'hi' }, ctx(d));
    assert.equal(await readFile(join(d, 'nested/a'), 'utf8'), 'hi');
  }));
test('overwrites', async () =>
  withTmpDir(async (d) => {
    const t = createWriteTool('');
    await t.execute({ path: 'a', content: 'old' }, ctx(d));
    await t.execute({ path: 'a', content: 'new' }, ctx(d));
    assert.equal(await readFile(join(d, 'a'), 'utf8'), 'new');
  }));
test('reports created flag', async () =>
  withTmpDir(async (d) => {
    const t = createWriteTool('');
    assert.deepEqual((await t.execute({ path: 'a', content: 'a' }, ctx(d))).details, { created: true });
    assert.deepEqual((await t.execute({ path: 'a', content: 'b' }, ctx(d))).details, { created: false });
  }));
for (const [name, input, args, expected] of [
  ['single replacement', 'abc', { oldText: 'b', newText: 'B' }, 'aBc'],
  ['replaceAll', 'a a', { oldText: 'a', newText: 'b', replaceAll: true }, 'b b'],
  ['preserves CRLF', 'a\r\nb\r\n', { oldText: 'a\nb', newText: 'A\nB' }, 'A\r\nB\r\n'],
  ['preserves BOM', '\uFEFFabc', { oldText: 'b', newText: 'B' }, '\uFEFFaBc'],
] as const)
  test(name, async () =>
    withTmpDir(async (d) => {
      await writeFile(join(d, 'a'), input);
      await createEditTool('').execute({ path: 'a', ...args }, ctx(d));
      assert.equal(await readFile(join(d, 'a'), 'utf8'), expected);
    }),
  );
for (const [name, input, args, error] of [
  ['not found → reread hint', 'abc', { oldText: 'xyz', newText: 'a' }, /Re-read/],
  ['whitespace-only mismatch hint', ' abc ', { oldText: '  abc  ', newText: 'x' }, /whitespace differs/],
  ['line-number prefix hint', 'abc', { oldText: '     1\tabc', newText: 'x' }, /line-number prefixes/],
  ['multiple matches → line numbers listed', 'a\nx\na', { oldText: 'a', newText: 'b' }, /lines 1, 3/],
  ['empty oldText rejected', 'abc', { oldText: '', newText: 'x' }, /must not be empty/],
  ['identical texts rejected', 'abc', { oldText: 'a', newText: 'a' }, /identical|no.op/i],
] as const)
  test(name, async () =>
    withTmpDir(async (d) => {
      await writeFile(join(d, 'a'), input);
      await assert.rejects(() => createEditTool('').execute({ path: 'a', ...args }, ctx(d)), error);
    }),
  );
test('diff in details', async () =>
  withTmpDir(async (d) => {
    await writeFile(join(d, 'a'), 'old');
    assert.match(
      JSON.stringify((await createEditTool('').execute({ path: 'a', oldText: 'old', newText: 'new' }, ctx(d))).details),
      /-old.*\+new/,
    );
  }));
test('captures stdout and stderr interleaved', async () =>
  withTmpDir(async (d) => {
    const r = await runCommand(
      "node -e \"process.stdout.write('out');setTimeout(()=>process.stderr.write('err'),10)\"",
      { cwd: d },
    );
    assert.match(r.output, /outerr/);
  }));
test('reports exit code without isError', async () =>
  withTmpDir(async (d) => {
    const r = await createBashTool('').execute({ command: 'node -e "process.exit(7)"' }, ctx(d));
    assert.match(text(r), /exit code: 7/);
    assert.ok(!r.isError);
  }));
test('bash timeout is reported as a tool error', async () =>
  withTmpDir(async (d) => {
    const r = await createBashTool('').execute({ command: 'node -e "setTimeout(()=>{},30000)"', timeout: 1 }, ctx(d));
    assert.match(text(r), /timed out/);
    assert.equal(r.isError, true);
  }));
test('bash abort is reported as a tool error', async () =>
  withTmpDir(async (d) => {
    const controller = new AbortController();
    const r = await createBashTool('').execute(
      { command: 'node -e "console.log(\'ready\');setTimeout(()=>{},30000)"' },
      { ...ctx(d, controller.signal), onUpdate: () => controller.abort() },
    );
    assert.match(text(r), /aborted/);
    assert.equal(r.isError, true);
  }));
test('timeout kills process group', async () =>
  withTmpDir(async (d) => {
    const command =
      "node -e \"const c=require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},30000)'],{stdio:'inherit'});require('fs').writeFileSync('child.pid',String(c.pid));setTimeout(()=>{},30000)\"";
    const r = await runCommand(command, { cwd: d, timeoutSec: 1 });
    assert.equal(r.timedOut, true);
    const pid = Number(await readFile(join(d, 'child.pid'), 'utf8'));
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    if (process.platform !== 'win32' && alive) {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => '');
      alive = !stat.includes(') Z ');
    }
    assert.equal(alive, false, 'descendant must be terminated');
  }));
test('abort kills process', async () =>
  withTmpDir(async (d) => {
    const c = new AbortController();
    const p = runCommand('node -e "console.log(\'ready\');setTimeout(()=>{},30000)"', {
      cwd: d,
      signal: c.signal,
      onUpdate: () => c.abort(),
    });
    const r = await p;
    assert.equal(r.aborted, true);
  }));
test('cd does not persist across calls', async () =>
  withTmpDir(async (d) => {
    await mkdir(join(d, 'sub'));
    const t = createBashTool('');
    await t.execute({ command: 'cd sub' }, ctx(d));
    assert.match(text(await t.execute({ command: 'node -p "process.cwd()"' }, ctx(d))), /mh-test-/);
  }));
test('stdin is closed (cat returns immediately)', async () =>
  withTmpDir(async (d) => {
    const r = await runCommand("node -e \"process.stdin.resume();process.stdin.on('end',()=>console.log('eof'))\"", {
      cwd: d,
      timeoutSec: 2,
    });
    assert.equal(r.timedOut, false);
    assert.match(r.output, /eof/);
  }));
test('onUpdate streams output', async () =>
  withTmpDir(async (d) => {
    const parts: string[] = [];
    await runCommand('node -e "console.log(\'hello\')"', { cwd: d, onUpdate: (p) => parts.push(p) });
    assert.match(parts.join(''), /hello/);
  }));
test('under limit unchanged', async () =>
  withTmpDir(async (d) => {
    const h = offloadHook({ sessionDir: d, maxChars: 1000, maxLines: 100 });
    const r = { content: [{ type: 'text' as const, text: 'hi' }] };
    assert.equal(await h.afterTool!({ type: 'toolCall', id: 'a', name: 'bash', args: {} }, createBashTool(''), r), r);
  }));
test('over limit keeps head and tail and writes full file', async () =>
  withTmpDir(async (d) => {
    const full = 'head\n' + 'middle\n'.repeat(1000) + 'tail';
    const h = offloadHook({ sessionDir: d, maxChars: 1000, maxLines: 100 });
    const r = await h.afterTool!({ type: 'toolCall', id: 'a', name: 'bash', args: {} }, createBashTool(''), {
      content: [{ type: 'text', text: full }],
    });
    assert.match(text(r), /^head/);
    assert.match(text(r), /tail$/);
    assert.equal(await readFile(join(d, 'offload/a.txt'), 'utf8'), full);
  }));
test('marker contains path and counts', async () =>
  withTmpDir(async (d) => {
    const h = offloadHook({ sessionDir: d, maxChars: 1000, maxLines: 100 });
    const r = await h.afterTool!({ type: 'toolCall', id: 'a', name: 'bash', args: {} }, createBashTool(''), {
      content: [{ type: 'text', text: 'x'.repeat(3000) }],
    });
    assert.match(text(r), /chars omitted.*offload/s);
  }));
test('Windows shell selection falls back Git Bash → pwsh → powershell', () => {
  const env = { PATH: 'C:\\Git\\cmd;C:\\PS;C:\\Windows', ProgramFiles: 'C:\\Program Files' };
  for (const [files, kind] of [
    [['C:\\Git\\cmd\\git.exe', 'C:\\Git\\bin\\bash.exe'], 'bash'],
    [['C:\\PS\\pwsh.exe'], 'powershell'],
    [['C:\\Windows\\powershell.exe'], 'powershell'],
  ] as const) {
    const s = detectShell({ platform: 'win32', env, exists: (p) => (files as readonly string[]).includes(p) });
    assert.equal(s.kind, kind);
    assert.ok((files as readonly string[]).includes(s.executable));
  }
});
test('Windows WSL bash launcher is not selected as Git Bash', () => {
  const s = detectShell({
    platform: 'win32',
    env: { PATH: 'C:\\Windows\\System32;C:\\PS' },
    exists: (p) => ['C:\\Windows\\System32\\bash.exe', 'C:\\PS\\pwsh.exe'].includes(p),
  });
  assert.match(s.executable, /pwsh/);
});
