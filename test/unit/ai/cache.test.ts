import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { OpenAIProvider, buildOpenAIBody, resolveModel, zeroUsage } from '../../../src/ai/index.ts';
import type { ModelRequest, Message } from '../../../src/ai/index.ts';
import { startRun } from '../../../src/app/run.ts';
import { defaultConfig } from '../../../src/app/config.ts';
import { systemCacheBoundary } from '../../../src/context/system-prompt.ts';
import { summarizeTrace } from '../../../src/eval/report.ts';
import { withSSEServer, sse } from '../../helpers/sse-server.ts';
import { withTmpDir } from '../../helpers/tmp.ts';

process.env.MH_TEST_CACHE_KEY = 'test-only';
const request = (messages: Message[] = []): ModelRequest => ({
  model: resolveModel('gpt-6.1-sol', { 'gpt-6.1-sol': { apiKeyEnv: 'MH_TEST_CACHE_KEY' } }, 'openai'),
  system: 'Stable developer instructions.',
  messages,
  tools: [],
});
const completed = (id: string, output: unknown[] = [], extra = {}) =>
  sse({ type: 'response.completed', response: { id, output, ...extra } });

test('Sol caches a stable developer prefix and preserves reasoning across turns', () => {
  const req = request([{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]);
  const before = structuredClone(req);
  const body = buildOpenAIBody(req);
  assert.deepEqual(body.input[0], {
    role: 'developer',
    content: [{ type: 'input_text', text: req.system, prompt_cache_breakpoint: { mode: 'explicit' } }],
  });
  assert.equal(body.instructions, undefined);
  assert.deepEqual(body.prompt_cache_options, { mode: 'implicit', ttl: '30m' });
  assert.equal(body.reasoning?.context, 'all_turns');
  assert.equal(body.store, false);
  assert.deepEqual(req, before);
});

test('memory and environment changes remain after the stable developer cache boundary', () => {
  const req = request();
  req.system = 'Shared project instructions.\n\n# Memory\nold index\n\n# Environment\ncwd: /first';
  req.systemCacheBoundary = systemCacheBoundary(req.system);
  const first = buildOpenAIBody(req).input[0] as { content: Record<string, unknown>[] };
  req.system = 'Shared project instructions.\n\n# Memory\nnew index\n\n# Environment\ncwd: /second';
  req.systemCacheBoundary = systemCacheBoundary(req.system);
  const second = buildOpenAIBody(req).input[0] as { content: Record<string, unknown>[] };
  assert.deepEqual(first.content[0], second.content[0]);
  assert.equal(first.content[0]?.text, 'Shared project instructions.');
  assert.equal(first.content[1]?.prompt_cache_breakpoint, undefined);
  assert.equal(second.content.map((b) => b.text).join(''), req.system);
});

test('Responses separates ordinary input, cache reads and cache writes without double counting', async () =>
  withSSEServer(
    () => ({
      chunks: [
        completed('resp_usage', [], {
          usage: {
            input_tokens: 12000,
            output_tokens: 10,
            input_tokens_details: { cached_tokens: 4000, cache_write_tokens: 7000 },
          },
        }),
      ],
    }),
    async (url) => {
      const req = request();
      req.model.baseUrl = url;
      const result = await new OpenAIProvider().stream(req, AbortSignal.timeout(5000), () => {});
      assert.deepEqual(result.usage, { input: 1000, output: 10, cacheRead: 4000, cacheWrite: 7000 });
      assert.equal(result.responsesId, 'resp_usage');
      assert.equal(result.cache?.readReported, true);
      assert.equal(result.cache?.writeReported, true);
    },
  ));

test('Sol replays the wire prefix and records server cache-miss diagnostics in the session', async () =>
  withTmpDir(async (dir) => {
    await writeFile(join(dir, 'input.txt'), 'evidence');
    let firstInput: unknown[] = [];
    const reasoning = { type: 'reasoning', id: 'rs_1', encrypted_content: 'opaque', summary: [] };
    const call = {
      type: 'function_call',
      call_id: 'call_1',
      name: 'read',
      arguments: '{"path":"input.txt"}',
      status: 'completed',
    };
    const diagnostics = {
      type: 'cache_miss',
      reason: 'input_changed',
      comparison_reusable_tokens: 2000,
      cache_missed_tokens: 1000,
    };
    await withSSEServer(
      (value, attempt) => {
        const body = value as { input: unknown[]; prompt_cache_options: { comparison_response_id?: string } };
        if (attempt === 1) {
          firstInput = structuredClone(body.input);
          assert.equal(body.prompt_cache_options.comparison_response_id, undefined);
          return { chunks: [completed('resp_first', [reasoning, call])] };
        }
        assert.deepEqual(body.input.slice(0, firstInput.length), firstInput);
        assert.deepEqual(body.input.slice(firstInput.length, firstInput.length + 2), [reasoning, call]);
        assert.equal(body.prompt_cache_options.comparison_response_id, 'resp_first');
        return {
          chunks: [
            completed(
              'resp_second',
              [
                {
                  type: 'message',
                  role: 'assistant',
                  phase: 'final_answer',
                  content: [{ type: 'output_text', text: 'done' }],
                },
              ],
              {
                usage: {
                  input_tokens: 2000,
                  output_tokens: 5,
                  input_tokens_details: { cached_tokens: 0, cache_write_tokens: 2000 },
                },
                prompt_cache_diagnostics: diagnostics,
              },
            ),
          ],
        };
      },
      async (url) => {
        const config = defaultConfig();
        config.provider = 'openai';
        config.model = 'gpt-6.1-sol';
        config.models[config.model] = { apiKeyEnv: 'MH_TEST_CACHE_KEY', baseUrl: url };
        const result = await startRun({
          cwd: dir,
          home: join(dir, 'home'),
          config,
          prompt: 'Read input.txt.',
          maxTurns: 3,
          signal: AbortSignal.timeout(5000),
        });
        assert.equal(result.reason, 'done');
        const turn = result.session.entries().findLast((e) => e.type === 'trace' && e.name === 'turn');
        assert.ok(turn?.type === 'trace');
        assert.deepEqual((turn.data.cache as { diagnostics?: unknown } | undefined)?.diagnostics, diagnostics);
        assert.equal(summarizeTrace(result.session.entries()).cache.misses.input_changed, 1);
        assert.equal(result.usage.cacheWrite, 2000);
      },
    );
  }));

test('a gateway rejecting native cache parameters retries compatible Responses once per endpoint', async () => {
  let calls = 0;
  await withSSEServer(
    (value, attempt, http) => {
      calls++;
      assert.equal(http.url, '/v1/responses');
      const body = value as Record<string, unknown>;
      if (attempt === 1) {
        assert.ok(body.prompt_cache_options);
        return { status: 400, chunks: ['{"error":{"message":"Unknown parameter: prompt_cache_options"}}'] };
      }
      assert.ok(!('prompt_cache_options' in body));
      assert.equal(body.instructions, 'Stable developer instructions.');
      return { chunks: [completed('resp_compat')] };
    },
    async (url) => {
      const req = request();
      req.model.baseUrl = url;
      const provider = new OpenAIProvider();
      const first = await provider.stream(req, AbortSignal.timeout(5000), () => {});
      assert.equal(first.stopReason, 'end');
      assert.equal(first.cache?.compatibilityFallback, true);
      await provider.stream(req, AbortSignal.timeout(5000), () => {});
      assert.equal(calls, 3);
    },
  );
});

test('a generic HTTP 400 does not trigger a cache compatibility retry', async () => {
  let calls = 0;
  await withSSEServer(
    () => {
      calls++;
      return { status: 400, chunks: ['{"error":{"message":"Invalid model configuration"}}'] };
    },
    async (url) => {
      const req = request();
      req.model.baseUrl = url;
      const result = await new OpenAIProvider().stream(req, AbortSignal.timeout(5000), () => {});
      assert.equal(result.stopReason, 'error');
      assert.equal(calls, 1);
    },
  );
});

test('cache compatibility never retries an error after the SSE stream has started', async () => {
  let calls = 0;
  await withSSEServer(
    () => {
      calls++;
      return { chunks: [sse({ type: 'error', message: 'Unknown parameter: prompt_cache_options' })] };
    },
    async (url) => {
      const req = request();
      req.model.baseUrl = url;
      const result = await new OpenAIProvider().stream(req, AbortSignal.timeout(5000), () => {});
      assert.equal(result.stopReason, 'error');
      assert.equal(calls, 1);
    },
  );
});

test('reported zero cache reads produce a confirmed zero hit rate', () => {
  const report = summarizeTrace([
    {
      type: 'trace',
      id: 'e1',
      ts: '2026-11-08',
      name: 'turn',
      data: {
        usage: { input: 0, output: 5, cacheRead: 0, cacheWrite: 2000 },
        cache: { readReported: true, writeReported: true },
      },
    },
  ]);
  assert.equal(report.cache.readReported, true);
  assert.equal(report.cache.writeReported, true);
  assert.equal(report.cache.hitRate, 0);
});

test('gateway cache counters that are absent stay unknown in trace summaries', async () =>
  withTmpDir(async (dir) =>
    withSSEServer(
      () => ({ chunks: [completed('resp_missing', [], { usage: { input_tokens: 2000, output_tokens: 5 } })] }),
      async (url) => {
        const config = defaultConfig();
        config.provider = 'openai';
        config.model = 'gpt-6.1-sol';
        config.models[config.model] = { baseUrl: url, apiKeyEnv: 'MH_TEST_CACHE_KEY' };
        const run = await startRun({
          cwd: dir,
          home: join(dir, 'home'),
          config,
          prompt: 'hello',
          signal: AbortSignal.timeout(5000),
        });
        const cache = summarizeTrace(run.session.entries()).cache;
        assert.equal(cache.readReported, false);
        assert.equal(cache.writeReported, false);
        assert.equal(cache.hitRate, null);
      },
    ),
  ));

test('native cache extensions can be disabled explicitly for a gateway', () => {
  const req = request();
  req.model.compat = { promptCache: false };
  const body = buildOpenAIBody(req);
  assert.equal(body.instructions, req.system);
  assert.ok(!('prompt_cache_options' in body));
  assert.equal(body.reasoning?.context, undefined);
  assert.equal(body.store, false);
});

test('cache diagnostics compare only responses from the same model', () => {
  const body = buildOpenAIBody(
    request([
      {
        role: 'assistant',
        provider: 'openai',
        model: 'other',
        responsesId: 'resp_other',
        content: [],
        stopReason: 'end',
        usage: zeroUsage(),
      },
    ]),
  );
  assert.equal(body.prompt_cache_options?.comparison_response_id, undefined);
});
