import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { memoryDir, readIndex } from '../../../src/memory/memory-dir.ts';
import { ensureRepo, commitAll, gitHead, memoryUndo } from '../../../src/memory/git.ts';
import { runDream } from '../../../src/app/dream.ts';
import { startRun } from '../../../src/app/run.ts';
import { defaultConfig } from '../../../src/app/config.ts';
import { withTmpDir } from '../../helpers/tmp.ts';
import { scripted } from '../../helpers/fake-provider.ts';
import { createSession } from '../../../src/session/index.ts';
test('dream lists exact transcript and memory paths without requiring a directory tool', async () =>
  withTmpDir(async (d) => {
    const home = join(d, 'home'),
      session = createSession(home, d);
    session.append({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'verified fact' }] } });
    const dir = memoryDir(home, d);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'note.md'), 'existing');
    const p = scripted((req) => {
      const user = req.messages[0]!.content.find((b) => b.type === 'text');
      assert.ok(user?.type === 'text' && user.text.includes(session.id + '.md'));
      assert.ok(user?.type === 'text' && user.text.includes('note.md'));
      return { text: 'done' };
    });
    await runDream({ cwd: d, home, config: defaultConfig(), provider: p });
  }));
test('MEMORY.md index truncated at 200 lines or 25KB, whichever first', async () =>
  withTmpDir(async (d) => {
    await writeFile(join(d, 'MEMORY.md'), Array(300).fill('line').join('\n'));
    assert.ok(readIndex(d).truncated);
    assert.ok(readIndex(d).text.split('\n').length <= 202);
    await writeFile(join(d, 'MEMORY.md'), '中'.repeat(20000));
    assert.ok(readIndex(d).truncated);
    assert.ok(Buffer.byteLength(readIndex(d).text) < 26000);
  }));
test('memory dir writable without ask', async () =>
  withTmpDir(async (d) => {
    const home = join(d, 'home'),
      dir = memoryDir(home, d),
      p = scripted(
        { toolCalls: [{ name: 'write', args: { path: join(dir, 'note.md'), content: 'fact' } }] },
        { text: 'done' },
      );
    await startRun({ cwd: d, home, config: defaultConfig(), prompt: 'remember', provider: p });
    assert.equal(await readFile(join(dir, 'note.md'), 'utf8'), 'fact');
  }));
test('memory injected into system prompt', async () =>
  withTmpDir(async (d) => {
    const home = join(d, 'home'),
      dir = memoryDir(home, d);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'MEMORY.md'), 'verified project fact');
    const p = scripted({ text: 'done' });
    await startRun({ cwd: d, home, config: defaultConfig(), prompt: 'hi', provider: p });
    assert.match(p.requests[0]!.system, /verified project fact/);
    assert.ok(p.requests[0]!.system.indexOf('# Memory') < p.requests[0]!.system.indexOf('# Environment'));
  }));
test('ensureRepo initializes once', async () =>
  withTmpDir(async (d) => {
    ensureRepo(d);
    const before = gitHead(d);
    ensureRepo(d);
    assert.equal(gitHead(d), before);
  }));
test('commitAll returns null when nothing changed', async () =>
  withTmpDir(async (d) => {
    ensureRepo(d);
    assert.equal(commitAll(d, 'none'), null);
  }));
test('commits pre-dream snapshot and dream result', async () =>
  withTmpDir(async (d) => {
    const home = join(d, 'home'),
      dir = memoryDir(home, d);
    await mkdir(dir, { recursive: true });
    ensureRepo(dir);
    await writeFile(join(dir, 'note.md'), 'before');
    const p = scripted(
      { toolCalls: [{ name: 'write', args: { path: 'note.md', content: 'after' } }] },
      { text: 'organized' },
    );
    const r = await runDream({ cwd: d, home, config: defaultConfig(), provider: p });
    assert.notEqual(r.before, r.after);
    assert.match(r.diffStat, /note.md/);
    assert.equal(await readFile(join(dir, 'note.md'), 'utf8'), 'after');
  }));
test('bash not available to dream agent', async () =>
  withTmpDir(async (d) => {
    const p = scripted((req) => {
      assert.deepEqual(
        req.tools.map((t) => t.name),
        ['read', 'write', 'edit'],
      );
      return { text: 'done' };
    });
    await runDream({ cwd: d, home: join(d, 'home'), config: defaultConfig(), provider: p });
  }));
test('writes outside memory dir denied', async () =>
  withTmpDir(async (d) => {
    const p = scripted(
      { toolCalls: [{ name: 'write', args: { path: join(d, 'outside'), content: 'bad' } }] },
      { text: 'done' },
    );
    await runDream({ cwd: d, home: join(d, 'home'), config: defaultConfig(), provider: p });
    const second = p.requests[1]!;
    assert.ok(second.messages.some((m) => m.role === 'toolResult' && m.isError));
    await assert.rejects(() => readFile(join(d, 'outside')));
  }));
test('dry-run leaves real dir untouched', async () =>
  withTmpDir(async (d) => {
    const home = join(d, 'home'),
      dir = memoryDir(home, d);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'note.md'), 'before');
    const p = scripted(
      { toolCalls: [{ name: 'write', args: { path: 'note.md', content: 'after' } }] },
      { text: 'done' },
    );
    await runDream({ cwd: d, home, config: defaultConfig(), provider: p, dryRun: true });
    assert.equal(await readFile(join(dir, 'note.md'), 'utf8'), 'before');
    await assert.rejects(() => readFile(join(dir, '.git/HEAD')));
  }));
test('warns when MEMORY.md exceeds 200 lines', async () =>
  withTmpDir(async (d) => {
    const p = scripted(
      { toolCalls: [{ name: 'write', args: { path: 'MEMORY.md', content: Array(201).fill('note').join('\n') } }] },
      { text: 'done' },
    );
    const r = await runDream({ cwd: d, home: join(d, 'home'), config: defaultConfig(), provider: p });
    assert.ok(r.warnings.some((w) => w.includes('200')));
  }));
test('memory undo shows diffstat and requires confirmation', async () =>
  withTmpDir(async (d) => {
    ensureRepo(d);
    await writeFile(join(d, 'note.md'), 'new');
    commitAll(d, 'dream: test');
    let shown = '';
    const denied = await memoryUndo(d, async (stat) => {
      shown = stat;
      return false;
    });
    assert.equal(denied.undone, false);
    assert.match(shown, /note.md/);
    const allowed = await memoryUndo(d, async () => true);
    assert.ok(allowed.undone);
    await assert.rejects(() => readFile(join(d, 'note.md')));
  }));
