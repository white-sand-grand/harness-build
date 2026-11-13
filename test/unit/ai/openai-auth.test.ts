import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenAIProvider, resolveModel, type ModelRequest, type StreamEvent } from '../../../src/ai/index.ts';
import { sse, withSSEServer } from '../../helpers/sse-server.ts';

const authVariables = ['OPENAI_API_KEY', 'MH_TEST_INJECTED_OPENAI_KEY'] as const;
async function withAuthEnv(values: Partial<Record<(typeof authVariables)[number], string>>, run: () => Promise<void>) {
  const previous = authVariables.map((name) => [name, process.env[name]] as const);
  try {
    for (const name of authVariables) {
      if (values[name] === undefined) delete process.env[name];
      else process.env[name] = values[name];
    }
    await run();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}
const request = (baseUrl: string, apiKeyEnv?: string): ModelRequest => ({
  model: { ...resolveModel('local-auth-fixture', {}, 'openai'), baseUrl, apiKeyEnv },
  system: 'A local authentication test.',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply briefly.' }] }],
  tools: [],
});
const completed = sse({
  type: 'response.completed',
  response: {
    id: 'auth-fixture',
    output: [{ type: 'message', content: [{ type: 'output_text', text: 'hello' }] }],
  },
});

test('OpenAI instance credentials authenticate without entering request, event or environment data', async () =>
  withAuthEnv({}, async () => {
    const key = 'fixture-private-openai-credential';
    const provider = new OpenAIProvider({ apiKey: key });
    let requestBody = '',
      authorization: string | undefined;
    await withSSEServer(
      (body, _, incoming) => {
        requestBody = JSON.stringify(body);
        authorization = incoming.headers.authorization;
        assert.equal(incoming.url, '/v1/responses');
        return { chunks: [completed] };
      },
      async (url) => {
        const req = request(url);
        const events: StreamEvent[] = [];
        const result = await provider.stream(req, AbortSignal.timeout(5000), (event) => events.push(event));
        assert.equal(result.stopReason, 'end', result.errorMessage);
        assert.equal(authorization, `Bearer ${key}`);
        assert.ok(!requestBody.includes(key));
        assert.ok(!JSON.stringify({ req, provider, events, result }).includes(key));
        assert.ok(!Object.values(process.env).some((value) => value?.includes(key)));
        assert.ok(authVariables.every((name) => process.env[name] === undefined));
      },
    );
  }));

test('OpenAI instance credentials override environment keys and stay isolated across concurrent providers', async () =>
  withAuthEnv(
    { OPENAI_API_KEY: 'fixture-default-env-key', MH_TEST_INJECTED_OPENAI_KEY: 'fixture-selected-env-key' },
    async () => {
      const headers: string[] = [];
      const keys = ['fixture-first-instance-key', 'fixture-second-instance-key'];
      await withSSEServer(
        (_, __, incoming) => {
          headers.push(incoming.headers.authorization ?? '');
          return { chunks: [completed] };
        },
        async (url) => {
          const results = await Promise.all(
            keys.map((apiKey) =>
              new OpenAIProvider({ apiKey }).stream(
                request(url, 'MH_TEST_INJECTED_OPENAI_KEY'),
                AbortSignal.timeout(5000),
                () => {},
              ),
            ),
          );
          assert.ok(results.every((result) => result.stopReason === 'end'));
          assert.deepEqual(headers.sort(), keys.map((key) => `Bearer ${key}`).sort());
          assert.equal(process.env.OPENAI_API_KEY, 'fixture-default-env-key');
          assert.equal(process.env.MH_TEST_INJECTED_OPENAI_KEY, 'fixture-selected-env-key');
        },
      );
    },
  ));

for (const [name, apiKeyEnv, apiKey, expected] of [
  ['selected environment key', 'MH_TEST_INJECTED_OPENAI_KEY', undefined, 'fixture-selected-env-key'],
  ['default environment key', undefined, undefined, 'fixture-default-env-key'],
  ['empty instance key fallback', 'MH_TEST_INJECTED_OPENAI_KEY', '', 'fixture-selected-env-key'],
] as const)
  test(`OpenAI authentication preserves ${name}`, async () =>
    withAuthEnv(
      { OPENAI_API_KEY: 'fixture-default-env-key', MH_TEST_INJECTED_OPENAI_KEY: 'fixture-selected-env-key' },
      async () => {
        let authorization: string | undefined;
        await withSSEServer(
          (_, __, incoming) => {
            authorization = incoming.headers.authorization;
            return { chunks: [completed] };
          },
          async (url) => {
            const result = await new OpenAIProvider({ apiKey }).stream(
              request(url, apiKeyEnv),
              AbortSignal.timeout(5000),
              () => {},
            );
            assert.equal(result.stopReason, 'end', result.errorMessage);
            assert.equal(authorization, `Bearer ${expected}`);
          },
        );
      },
    ));

test('OpenAI missing selected environment key does not silently use the default key', async () =>
  withAuthEnv({ OPENAI_API_KEY: 'fixture-default-env-key' }, async () => {
    const result = await new OpenAIProvider().stream(
      request('http://127.0.0.1:1', 'MH_TEST_INJECTED_OPENAI_KEY'),
      AbortSignal.timeout(5000),
      () => {},
    );
    assert.equal(result.stopReason, 'error');
    assert.match(result.errorMessage!, /Missing API key.*MH_TEST_INJECTED_OPENAI_KEY/);
    assert.ok(!result.errorMessage!.includes('fixture-default-env-key'));
  }));

test('OpenAI injected credentials retain retry sleep and authorization across attempts', async () =>
  withAuthEnv({}, async () => {
    const delays: number[] = [],
      headers: string[] = [];
    await withSSEServer(
      (_, attempt, incoming) => {
        headers.push(incoming.headers.authorization ?? '');
        return attempt === 1
          ? { status: 429, headers: { 'retry-after': '0.01' }, chunks: ['retry later'] }
          : { chunks: [completed] };
      },
      async (url) => {
        const result = await new OpenAIProvider({
          apiKey: 'fixture-retry-key',
          sleep: async (ms) => {
            delays.push(ms);
          },
        }).stream(request(url), AbortSignal.timeout(5000), () => {});
        assert.equal(result.stopReason, 'end', result.errorMessage);
        assert.deepEqual(delays, [10]);
        assert.deepEqual(headers, ['Bearer fixture-retry-key', 'Bearer fixture-retry-key']);
      },
    );
  }));

test('OpenAI HTTP errors redact injected credentials before truncating body excerpts', async () =>
  withAuthEnv({}, async () => {
    const key = 'fixture-private/echo?key=.$[openai]';
    await withSSEServer(
      () => ({ status: 400, chunks: ['x'.repeat(1475) + key + ' ' + key] }),
      async (url) => {
        const result = await new OpenAIProvider({ apiKey: key }).stream(
          request(url),
          AbortSignal.timeout(5000),
          () => {},
        );
        assert.equal(result.stopReason, 'error');
        assert.match(result.errorMessage!, /HTTP 400:.*\[redacted\]/);
        assert.ok(!result.errorMessage!.includes(key.slice(0, 12)));
      },
    );
  }));

test('OpenAI streamed errors redact injected credentials without leaking them through events', async () =>
  withAuthEnv({}, async () => {
    const key = 'fixture-stream-private-key';
    for (const error of [
      { type: 'error', code: 'invalid_api_key', message: `Rejected ${key}; ${key}` },
      { type: 'response.failed', response: { error: { code: 'invalid_api_key', message: `Rejected ${key}` } } },
    ])
      await withSSEServer(
        () => ({ chunks: [sse(error)] }),
        async (url) => {
          const events: StreamEvent[] = [];
          const result = await new OpenAIProvider({ apiKey: key }).stream(
            request(url),
            AbortSignal.timeout(5000),
            (event) => events.push(event),
          );
          assert.equal(result.stopReason, 'error');
          assert.match(result.errorMessage!, /invalid_api_key: Rejected \[redacted\]/);
          assert.ok(!JSON.stringify({ result, events }).includes(key));
        },
      );
  }));
