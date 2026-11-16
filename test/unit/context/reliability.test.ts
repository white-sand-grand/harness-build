import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { requestTokens, requestBudget } from '../../../src/context/tokens.ts';
import { parseContinuation, continuationFacts } from '../../../src/context/continuation.ts';
import { compactionHook } from '../../../src/context/compaction.ts';
import { createSession, openSession } from '../../../src/session/index.ts';
import { buildAgent } from '../../../src/app/build-agent.ts';
import { compactSession } from '../../../src/app/compact.ts';
import { persistReplacement } from '../../../src/app/run.ts';
import { defaultConfig } from '../../../src/app/config.ts';
import { resolveModel, zeroUsage } from '../../../src/ai/index.ts';
import type { Message } from '../../../src/ai/index.ts';
import { scripted } from '../../helpers/fake-provider.ts';
import { withTmpDir } from '../../helpers/tmp.ts';

const user = (text: string): Message => ({ role: 'user', content: [{ type: 'text', text }] });
const summary = {
  v: 1,
  goal: 'Preserve the API',
  decisions: [{ text: 'read the source', evidenceEntryIds: ['e1'] }],
  unresolved: [],
  nextSteps: ['fix tests'],
};

test('request admission includes initial system, schemas, recall and output reserve without counting reported input twice', () => {
  const envelope = {
    system: 's'.repeat(36000),
    tools: [{ name: 'read', description: 'd'.repeat(1000), parameters: { type: 'object' as const } }],
  };
  const messages = [user('hi')];
  const tokens = requestTokens(messages, envelope);
  assert.ok(tokens > 9000);
  assert.equal(requestTokens(messages, envelope, { ...zeroUsage(), input: 10000, output: 10 }, envelope), 10019);
  assert.equal(
    requestTokens(messages, { ...envelope, system: 'changed' }, { ...zeroUsage(), input: 100000 }, envelope),
    requestTokens(messages, { ...envelope, system: 'changed' }),
  );
  assert.ok(tokens > requestBudget({ contextWindow: 10000, maxOutputTokens: 2048 }, envelope).inputLimit);
});

test('an impossible initial envelope stops before requesting either a summary or the model', async () => {
  const provider = scripted({ text: 'unused' });
  const h = compactionHook({
    provider,
    model: resolveModel('test', { test: { contextWindow: 10000, maxOutputTokens: 2048 } }, 'anthropic'),
    sessionDir: '/session',
    template: '{{conversation}}',
    signal: new AbortController().signal,
    config: { enabled: true, clearAtRatio: 0.6, compactAtRatio: 0.8, keepRecentTokens: 500 },
  });
  await assert.rejects(
    h.beforeModel!([user('hi')], { request: { system: 's'.repeat(36000), tools: [] } }),
    /Context budget exhausted/,
  );
  assert.equal(provider.requests.length, 0);
});

test('continuation summaries reject fabricated evidence and unbounded structures', () => {
  assert.equal(parseContinuation(JSON.stringify(summary), ['e1']).goal, summary.goal);
  assert.throws(() => parseContinuation(JSON.stringify(summary), ['e2']), /references/);
  assert.throws(
    () => parseContinuation(JSON.stringify({ ...summary, nextSteps: ['x'.repeat(2100)] }), ['e1']),
    /bounds/,
  );
  assert.throws(() => parseContinuation('{"v":1}', ['e1']), /schema/);
});
test('request admission accounts for UTF-8, images and retained native Responses items', () => {
  const envelope = { system: '', tools: [] };
  const plain = requestTokens([user('x'.repeat(100))], envelope);
  assert.ok(requestTokens([user('汉'.repeat(100))], envelope) > plain);
  assert.ok(
    requestTokens([{ role: 'user', content: [{ type: 'image', mediaType: 'image/png', data: 'AA==' }] }], envelope) >
      1500,
  );
  assert.ok(
    requestTokens(
      [
        {
          role: 'assistant',
          content: [],
          stopReason: 'end',
          model: 'test',
          provider: 'openai',
          usage: zeroUsage(),
          responsesOutput: [{ type: 'reasoning', encrypted_content: 'x'.repeat(10000) }],
        },
      ],
      envelope,
    ) > 2500,
  );
});

test('host continuation facts retain original user references and exclude failed mutations', () => {
  const entries = [
    { type: 'message' as const, id: 'e1', ts: '', message: user('Keep CommonJS') },
    {
      type: 'message' as const,
      id: 'e2',
      ts: '',
      message: {
        role: 'assistant' as const,
        content: [{ type: 'toolCall' as const, id: 't', name: 'edit', args: { path: 'failed.js' } }],
        model: 'test',
        provider: 'anthropic' as const,
        stopReason: 'toolUse' as const,
        usage: zeroUsage(),
      },
    },
    {
      type: 'message' as const,
      id: 'e3',
      ts: '',
      message: { role: 'toolResult' as const, toolCallId: 't', toolName: 'edit', isError: true, content: [] },
    },
  ];
  const facts = continuationFacts(entries);
  assert.equal(facts.userSources[0]?.entryId, 'e1');
  assert.deepEqual(facts.modifiedFiles, []);
});

test('three persisted compactions retain the original constraint even when generated summaries omit it', async () =>
  withTmpDir(async (d) => {
    const home = join(d, 'home'),
      session = createSession(home, d),
      config = defaultConfig();
    config.compaction.keepRecentTokens = 5;
    session.append({
      type: 'message',
      message: user('Repair the failing test. Keep the CommonJS export interface unchanged.'),
    });
    for (let round = 0; round < 3; round++) {
      session.append({ type: 'message', message: user(`Continue round ${round}`) });
      const provider = scripted((request) => ({
        text: JSON.stringify({
          v: 1,
          goal: 'Continue work',
          decisions: [],
          unresolved: [{ text: 'The test still fails', evidenceEntryIds: [request.system.match(/Entry (e\d+)/)![1]] }],
          nextSteps: ['repair the implementation'],
        }),
      }));
      assert.equal(await compactSession({ cwd: d, home, config, session, prompt: '', provider }), true);
      assert.match(
        JSON.stringify(openSession(home, d, session.id).context().messages),
        /CommonJS export interface unchanged/,
      );
    }
    assert.equal(session.entries().filter((entry) => entry.type === 'compaction' && entry.continuation).length, 3);
  }));

test('clearing receipts use distinct result entries for reused call IDs and survive reopen without suggesting replay', async () =>
  withTmpDir(async (d) => {
    const session = createSession(join(d, 'home'), d);
    session.append({ type: 'message', message: user('read results') });
    for (const text of ['first', 'second']) {
      session.append({
        type: 'message',
        message: {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'same', name: 'bash', args: { command: 'node build.js' } }],
          model: 'test',
          provider: 'anthropic',
          stopReason: 'toolUse',
          usage: zeroUsage(),
        },
      });
      session.append({
        type: 'message',
        message: {
          role: 'toolResult',
          toolCallId: 'same',
          toolName: 'bash',
          isError: false,
          content: [{ type: 'text', text: text.repeat(1800) }],
        },
      });
    }
    session.append({ type: 'message', message: user('continue') });
    const config = defaultConfig();
    config.compaction = { enabled: true, clearAtRatio: 0.001, compactAtRatio: 0.99, keepRecentTokens: 5 };
    const cfg = buildAgent({ cwd: d, home: join(d, 'home'), config, prompt: '', provider: scripted() }, session);
    const replacement = await cfg.hooks.beforeModel!(session.context().messages, {});
    assert.equal(replacement?.kind, 'clearing');
    persistReplacement(session, replacement!);
    const reopened = openSession(join(d, 'home'), d, session.id);
    assert.deepEqual(reopened.context().messages, replacement!.messages);
    const record = session.entries().find((entry) => entry.type === 'clearing');
    assert.ok(record?.type === 'clearing');
    assert.equal(record.receipts?.length, 2);
    assert.notEqual(record.receipts![0]!.outputRef, record.receipts![1]!.outputRef);
    assert.equal(await readFile(join(session.dir, record.receipts![0]!.outputRef), 'utf8'), 'first'.repeat(1800));
    assert.doesNotMatch(JSON.stringify(reopened.context().messages), /Re-run the tool call/);
    await writeFile(join(d, 'untouched'), 'ok');
  }));
