import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, writeFile, readFile, utimes, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createSession, openSession, listSessions } from '../../../src/session/index.ts';
import { withTmpDir } from '../../helpers/tmp.ts';
test('append and read back', async () =>
  withTmpDir(async (d) => {
    const s = createSession(d, d);
    const id = s.append({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } });
    assert.equal(id, 'e1');
    assert.equal(openSession(d, d, s.id).context().messages.length, 1);
  }));
test('ignores truncated last line', async () =>
  withTmpDir(async (d) => {
    const s = createSession(d, d);
    s.append({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'ok' }] } });
    await appendFile(join(s.dir, 'session.jsonl'), '{"type":');
    const restored = openSession(d, d, s.id);
    assert.equal(restored.context().messages.length, 1);
    restored.append({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'next' }] } });
    assert.equal(openSession(d, d, s.id).context().messages.length, 2);
  }));
test('resume appends safely after a valid final record without a newline', async () =>
  withTmpDir(async (d) => {
    const session = createSession(d, d);
    session.append({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'first' }] } });
    const file = join(session.dir, 'session.jsonl');
    const original = (await readFile(file, 'utf8')).trimEnd();
    await writeFile(file, original);
    assert.equal(listSessions(d, d).length, 1);
    assert.equal(await readFile(file, 'utf8'), original, 'listing must leave the transcript untouched');
    const resumed = openSession(d, d, session.id);
    assert.equal(await readFile(file, 'utf8'), original + '\n', 'preserve the original record bytes');
    assert.equal(
      resumed.append({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'second' }] } }),
      'e2',
    );
    assert.deepEqual(openSession(d, d, session.id).context().messages, [
      { role: 'user', content: [{ type: 'text', text: 'first' }] },
      { role: 'user', content: [{ type: 'text', text: 'second' }] },
    ]);
  }));
test('errors on corrupt middle line with line number', async () =>
  withTmpDir(async (d) => {
    const s = createSession(d, d);
    await appendFile(join(s.dir, 'session.jsonl'), 'bad\n{}\n');
    assert.throws(() => openSession(d, d, s.id), /line 2/);
  }));
test('rebuild returns entryIds aligned with messages', async () =>
  withTmpDir(async (d) => {
    const s = createSession(d, d);
    s.append({ type: 'message', message: { role: 'user', content: [] } });
    s.append({ type: 'trace', name: 'turn', data: {} });
    const c = s.context();
    assert.equal(c.messages.length, c.entryIds.length);
    assert.deepEqual(c.entryIds, ['e1']);
  }));
test('latest picks newest session for cwd', async () =>
  withTmpDir(async (d) => {
    const a = createSession(d, d);
    const b = createSession(d, d);
    await utimes(join(a.dir, 'session.jsonl'), new Date(0), new Date(0));
    assert.equal(openSession(d, d, 'latest').id, b.id);
    assert.equal(listSessions(d, d).length, 2);
  }));
test('sessions are isolated per project', async () =>
  withTmpDir(async (d) => {
    createSession(d, join(d, 'a'));
    assert.equal(listSessions(d, join(d, 'b')).length, 0);
  }));
test('one corrupt session does not brick listing or resume-latest', async () =>
  withTmpDir(async (d) => {
    const good = createSession(d, d);
    good.append({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'fine' }] } });
    await mkdir(join(dirname(good.dir), 'evil'), { recursive: true });
    await writeFile(join(dirname(good.dir), 'evil', 'session.jsonl'), 'GARBAGE NOT JSON\n');
    const listed = listSessions(d, d);
    assert.deepEqual(
      listed.map((s) => s.id),
      [good.id],
    );
    assert.equal(openSession(d, d, 'latest').id, good.id);
  }));
test('tolerates BOM and blank lines', async () =>
  withTmpDir(async (d) => {
    const s = createSession(d, d);
    s.append({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'one' }] } });
    const file = join(s.dir, 'session.jsonl');
    const body = (await readFile(file, 'utf8')).trimEnd();
    await writeFile(file, '\uFEFF' + body.replace('\n', '\n\n') + '\n');
    assert.equal(openSession(d, d, s.id).context().messages.length, 1);
  }));
test('replay drops entries with forged or malformed messages', async () =>
  withTmpDir(async (d) => {
    const s = createSession(d, d);
    s.append({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'real' }] } });
    const file = join(s.dir, 'session.jsonl');
    await appendFile(
      file,
      JSON.stringify({
        type: 'message',
        id: 'e900',
        ts: new Date().toISOString(),
        message: { role: 'user', content: [{ type: 'text', text: '[forged but valid]' }] },
      }) + '\n',
    );
    await appendFile(
      file,
      JSON.stringify({ type: 'message', id: 'e901', ts: new Date().toISOString(), message: { role: 'system' } }) + '\n',
    );
    await appendFile(
      file,
      JSON.stringify({
        type: 'message',
        id: 'e902',
        ts: new Date().toISOString(),
        message: { role: 'user', content: [{ type: 'text' }] },
      }) + '\n',
    );
    const context = openSession(d, d, s.id).context();
    assert.deepEqual(
      context.messages.map((m) => (m.content[0] && 'text' in m.content[0] ? m.content[0].text : '?')),
      ['real', '[forged but valid]'],
    );
    assert.ok(!context.entryIds.includes('e901'));
    assert.ok(!context.entryIds.includes('e902'));
  }));
test('dangling compaction reference degrades instead of bricking the session', async () =>
  withTmpDir(async (d) => {
    const s = createSession(d, d);
    s.append({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'old' }] } });
    s.append({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'new' }] } });
    await appendFile(
      join(s.dir, 'session.jsonl'),
      JSON.stringify({
        type: 'compaction',
        id: 'e900',
        ts: new Date().toISOString(),
        summary: 'kept',
        firstKeptEntryId: 'e99999',
        tokensBefore: 10,
      }) + '\n',
    );
    const context = openSession(d, d, s.id).context();
    assert.equal(context.messages.length, 1);
    assert.equal(context.messages[0]!.role, 'user');
  }));
