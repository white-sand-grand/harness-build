import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { assembleSystemPrompt } from '../../../src/context/system-prompt.ts';
import { collectInstructions } from '../../../src/memory/agents-md.ts';
import { compactionHook, findCutPoint } from '../../../src/context/compaction.ts';
import { createSession } from '../../../src/session/index.ts';
import { startRun, persistReplacement } from '../../../src/app/run.ts';
import { defaultConfig } from '../../../src/app/config.ts';
import { loadPrompts } from '../../../src/app/prompts.ts';
import { createDefaultTools } from '../../../src/tools/index.ts';
import { scripted, failingProvider } from '../../helpers/fake-provider.ts';
import { resolveModel, zeroUsage } from '../../../src/ai/index.ts';
import type { Message, Provider } from '../../../src/ai/index.ts';
import { withTmpDir } from '../../helpers/tmp.ts';
import { runCommand } from '../../../src/util/process.ts';
const user = (text: string): Message => ({ role: 'user', content: [{ type: 'text', text }] });
const old: Message[] = [
  ...Array.from({ length: 5 }, (_, i): Message[] => [
    user('old task ' + i),
    {
      role: 'assistant',
      content: [{ type: 'toolCall', id: String(i), name: 'read', args: { path: 'a' } }],
      stopReason: 'toolUse',
      model: 'test',
      provider: 'anthropic',
      usage: zeroUsage(),
    },
    {
      role: 'toolResult',
      toolCallId: String(i),
      toolName: 'read',
      content: [{ type: 'text', text: 'x'.repeat(6000) }],
      isError: false,
    },
  ]).flat(),
  user('new task'),
];
const hook = (provider: Provider = scripted({ text: 'summary' }), dir = '/tmp/session') =>
  compactionHook({
    provider,
    model: resolveModel('test', { test: { contextWindow: 10000 } }, 'anthropic'),
    sessionDir: dir,
    template: loadPrompts().compact,
    config: { enabled: true, clearAtRatio: 0.2, compactAtRatio: 0.8, keepRecentTokens: 500 },
    signal: new AbortController().signal,
  });
test('system prompt order: static → instructions → memory → environment', () => {
  const s = assembleSystemPrompt({
    base: 'BASE',
    instructions: [{ path: 'a', content: 'INSTRUCTIONS' }],
    memory: 'MEMORY',
    env: { cwd: '/cwd', platform: 'linux', date: '2026-11-08', shell: 'bash' },
  });
  assert.ok(s.indexOf('BASE') < s.indexOf('INSTRUCTIONS'));
  assert.ok(s.indexOf('INSTRUCTIONS') < s.indexOf('MEMORY'));
  assert.ok(s.indexOf('MEMORY') < s.indexOf('# Environment'));
});
test('date has no time component', () =>
  assert.match(
    assembleSystemPrompt({
      base: 'b',
      instructions: [],
      env: { cwd: '/', platform: 'linux', date: '2026-11-08', shell: 'bash' },
    }),
    /date: 2026-11-08\n/,
  ));
test('collects AGENTS.md from git root to cwd, CLAUDE.md fallback', async () =>
  withTmpDir(async (d) => {
    await runCommand('git init', { cwd: d });
    await mkdir(join(d, 'sub'));
    await writeFile(join(d, 'AGENTS.md'), 'root');
    await writeFile(join(d, 'sub/CLAUDE.md'), 'child');
    const r = collectInstructions(join(d, 'home'), join(d, 'sub'));
    assert.deepEqual(
      r.map((r) => r.content),
      ['root', 'child'],
    );
  }));
test('large AGENTS.md truncated with notice', async () =>
  withTmpDir(async (d) => {
    await writeFile(join(d, 'AGENTS.md'), 'x'.repeat(40000));
    const r = collectInstructions(join(d, 'home'), d);
    assert.match(r[0]!.content, /truncated/);
    assert.ok(r[0]!.content.length < 33000);
  }));
test('system + tool descriptions + schemas under 1500 estimated tokens', () => {
  const p = loadPrompts();
  const tools = createDefaultTools(p.tools).map(({ name, description, parameters }) => ({
    name,
    description,
    parameters,
  }));
  assert.ok((p.system.length + JSON.stringify(tools).length) / 4 < 1500);
});
test('prompt is byte-identical across turns within a session', async () =>
  withTmpDir(async (d) => {
    const p = scripted({ text: 'a' }, { text: 'b' });
    const c = defaultConfig();
    const a = await startRun({ cwd: d, home: d, config: c, prompt: 'one', provider: p });
    await writeFile(join(d, 'AGENTS.md'), 'new instructions');
    await startRun({ cwd: d, home: d, config: c, prompt: 'two', provider: p, session: a.session });
    assert.equal(p.requests[0]?.system, p.requests[1]?.system);
  }));
test("request prefix is stable: turn N+1 request body starts with turn N body's messages", async () =>
  withTmpDir(async (d) => {
    await writeFile(join(d, 'a'), 'hi');
    const p = scripted({ toolCalls: [{ name: 'read', args: { path: 'a' } }] }, { text: 'done' });
    await startRun({ cwd: d, home: d, config: defaultConfig(), prompt: 'read', provider: p });
    const first = p.requests[0]!.messages;
    assert.deepEqual(p.requests[1]!.messages.slice(0, first.length), first);
  }));
test('clears only old large tool results', async () => {
  const r = await hook().beforeModel!(structuredClone(old), {});
  assert.equal(r?.kind, 'clearing');
  assert.match(JSON.stringify(r?.messages), /cleared to save context/);
  assert.equal(r?.messages.at(-1)?.role, 'user');
});
test('does not trigger below threshold', async () =>
  assert.equal(await hook().beforeModel!([user('hi')], {}), undefined));
test('session rebuild reproduces cleared placeholders', async () =>
  withTmpDir(async (d) => {
    const s = createSession(d, d);
    for (const m of old) s.append({ type: 'message', message: m });
    const r = await hook(undefined, s.dir).beforeModel!(s.context().messages, {});
    assert.ok(r);
    persistReplacement(s, r);
    assert.deepEqual(s.context().messages, r.messages);
  }));
test('cut point never separates toolCall from toolResult', () => {
  const i = findCutPoint(old, 1000);
  assert.notEqual(old[i]?.role, 'toolResult');
});
test('cut point lands on user message', () => {
  const i = findCutPoint(old, 1000);
  assert.equal(old[i]?.role, 'user');
});
test('summary call uses compact prompt', async () => {
  const p = scripted({ text: 'summary' });
  await hook(p).beforeModel!(old, { force: true });
  assert.match(p.requests[0]!.system, /summarizing the earlier part/);
  assert.equal(p.requests[0]!.tools.length, 0);
});
test('rolling summary includes previous summary', async () => {
  const p = scripted({ text: 'new summary' });
  await hook(p).beforeModel!([user('<summary>previous facts</summary>'), ...old], { force: true });
  assert.match(p.requests[0]!.system, /previous facts/);
});
test('summary failure leaves context unchanged', async () => {
  const messages = structuredClone(old);
  assert.equal(await hook(failingProvider('unavailable')).beforeModel!(messages, { force: true }), undefined);
  assert.deepEqual(messages, old);
});
test('forced compaction on overflow', async () => {
  const r = await hook().beforeModel!(old, { force: true });
  assert.equal(r?.kind, 'compaction');
  assert.match(JSON.stringify(r?.messages[0]), /<summary>summary/);
});
test('rebuild after compaction matches live context', async () =>
  withTmpDir(async (d) => {
    const s = createSession(d, d);
    for (const m of old) s.append({ type: 'message', message: m });
    const r = await hook(undefined, s.dir).beforeModel!(s.context().messages, { force: true });
    assert.ok(r);
    persistReplacement(s, r);
    assert.deepEqual(s.context().messages, r.messages);
  }));
test('compacts a single long tool loop without dangling tool results', async () => {
  const messages = old.filter((m, i) => i === 0 || m.role !== 'user');
  const r = await hook().beforeModel!(messages, { force: true });
  assert.ok(r);
  assert.notEqual(r.messages[1]?.role, 'toolResult');
});
