import test from 'node:test';
import assert from 'node:assert/strict';
import { AnthropicProvider, resolveModel, type ModelRequest, type StreamEvent } from '../../../src/ai/index.ts';
import { anthropicFixture, sse, withSSEServer } from '../../helpers/sse-server.ts';

const authVariables = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'MH_TEST_INJECTED_AUTH_KEY'] as const;
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

test('Anthropic instance credentials authenticate without entering request or event data', async () =>
  withAuthEnv({}, async () => {
    const key = 'fixture-instance-authentication-key';
    const provider = new AnthropicProvider({ apiKey: key });
    let requestBody = '',
      headerKey: string | string[] | undefined;
    await withSSEServer(
      (body, _, request) => {
        requestBody = JSON.stringify(body);
        headerKey = request.headers['x-api-key'];
        return { chunks: anthropicFixture([{ type: 'text' }]) };
      },
      async (url) => {
        const request: ModelRequest = {
          model: { ...resolveModel('local-auth-fixture', {}, 'anthropic'), baseUrl: url },
          system: 'A local authentication test.',
          messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply briefly.' }] }],
          tools: [],
        };
        const events: StreamEvent[] = [];
        const result = await provider.stream(request, new AbortController().signal, (event) => events.push(event));
        assert.equal(result.stopReason, 'end', result.errorMessage);
        assert.equal(headerKey, key);
        assert.ok(!requestBody.includes(key));
        assert.ok(!JSON.stringify({ request, events, result, provider }).includes(key));
        assert.ok(authVariables.every((name) => process.env[name] === undefined));
      },
    );
  }));

test('Anthropic instance bearer credentials authenticate without entering request, event or environment data', async () =>
  withAuthEnv({}, async () => {
    const token = 'fixture-instance-bearer-token';
    const provider = new AnthropicProvider({ authToken: token });
    let requestBody = '',
      bearer: string | undefined,
      headerKey: string | string[] | undefined;
    await withSSEServer(
      (body, _, request) => {
        requestBody = JSON.stringify(body);
        bearer = request.headers.authorization;
        headerKey = request.headers['x-api-key'];
        return { chunks: anthropicFixture([{ type: 'text' }]) };
      },
      async (url) => {
        const request: ModelRequest = {
          model: { ...resolveModel('local-auth-fixture', {}, 'anthropic'), baseUrl: url },
          system: 'A local authentication test.',
          messages: [],
          tools: [],
        };
        const events: StreamEvent[] = [];
        const result = await provider.stream(request, AbortSignal.timeout(5000), (event) => events.push(event));
        assert.equal(result.stopReason, 'end', result.errorMessage);
        assert.equal(bearer, `Bearer ${token}`);
        assert.equal(headerKey, undefined);
        assert.ok(!requestBody.includes(token));
        assert.ok(!JSON.stringify({ request, provider, events, result }).includes(token));
        assert.ok(!Object.values(process.env).some((value) => value?.includes(token)));
        assert.ok(authVariables.every((name) => process.env[name] === undefined));
      },
    );
  }));

for (const useApiKey of [false, true])
  test(`Anthropic instance ${useApiKey ? 'API key takes precedence over bearer' : 'bearer overrides environment keys'}`, async () =>
    withAuthEnv(
      {
        ANTHROPIC_API_KEY: 'fixture-default-env-key',
        ANTHROPIC_AUTH_TOKEN: 'fixture-env-bearer-token',
        MH_TEST_INJECTED_AUTH_KEY: 'fixture-selected-env-key',
      },
      async () => {
        let headerKey: string | string[] | undefined, bearer: string | undefined;
        await withSSEServer(
          (_, __, request) => {
            headerKey = request.headers['x-api-key'];
            bearer = request.headers.authorization;
            return { chunks: anthropicFixture([{ type: 'text' }]) };
          },
          async (url) => {
            const result = await new AnthropicProvider({
              ...(useApiKey ? { apiKey: 'fixture-instance-key' } : {}),
              authToken: 'fixture-instance-bearer-token',
            }).stream(
              {
                model: {
                  ...resolveModel('local-auth-fixture', {}, 'anthropic'),
                  baseUrl: url,
                  apiKeyEnv: 'MH_TEST_INJECTED_AUTH_KEY',
                },
                system: 'A local authentication test.',
                messages: [],
                tools: [],
              },
              AbortSignal.timeout(5000),
              () => {},
            );
            assert.equal(result.stopReason, 'end', result.errorMessage);
            assert.equal(headerKey, useApiKey ? 'fixture-instance-key' : undefined);
            assert.equal(bearer, useApiKey ? undefined : 'Bearer fixture-instance-bearer-token');
            assert.equal(process.env.ANTHROPIC_API_KEY, 'fixture-default-env-key');
            assert.equal(process.env.ANTHROPIC_AUTH_TOKEN, 'fixture-env-bearer-token');
            assert.equal(process.env.MH_TEST_INJECTED_AUTH_KEY, 'fixture-selected-env-key');
          },
        );
      },
    ));

for (const failure of ['HTTP', 'streamed'])
  test(`Anthropic ${failure} errors redact private key and token before exposing diagnostics`, async () =>
    withAuthEnv({}, async () => {
      const key = 'fixture-private-anthropic-key',
        token = key + '-bearer-secret-tail';
      await withSSEServer(
        () =>
          failure === 'HTTP'
            ? { status: 400, chunks: ['x'.repeat(1475) + token + ' ' + key] }
            : {
                chunks: [
                  sse({ type: 'error', error: { type: 'authentication_error', message: `Rejected ${token}; ${key}` } }),
                ],
              },
        async (url) => {
          const provider = new AnthropicProvider({ apiKey: key, authToken: token });
          const events: StreamEvent[] = [];
          const result = await provider.stream(
            {
              model: { ...resolveModel('local-auth-fixture', {}, 'anthropic'), baseUrl: url },
              system: 'A local authentication test.',
              messages: [],
              tools: [],
            },
            AbortSignal.timeout(5000),
            (event) => events.push(event),
          );
          assert.equal(result.stopReason, 'error');
          assert.match(result.errorMessage!, /\[redacted\]/);
          assert.match(result.errorMessage!, failure === 'HTTP' ? /HTTP 400:/ : /authentication_error: Rejected/);
          assert.ok(!JSON.stringify({ provider, result, events }).includes(key.slice(0, 12)));
          assert.ok(!result.errorMessage!.includes('bearer-secret-tail'));
        },
      );
    }));

test('Anthropic instance credentials take precedence over environment authentication', async () =>
  withAuthEnv(
    {
      ANTHROPIC_API_KEY: 'fixture-default-env-key',
      ANTHROPIC_AUTH_TOKEN: 'fixture-bearer-token',
      MH_TEST_INJECTED_AUTH_KEY: 'fixture-selected-env-key',
    },
    async () => {
      let headerKey: string | string[] | undefined, bearer: string | undefined;
      await withSSEServer(
        (_, __, request) => {
          headerKey = request.headers['x-api-key'];
          bearer = request.headers.authorization;
          return { chunks: anthropicFixture([{ type: 'text' }]) };
        },
        async (url) => {
          const provider = new AnthropicProvider({ apiKey: 'fixture-injected-key' });
          const result = await provider.stream(
            {
              model: {
                ...resolveModel('local-auth-fixture', {}, 'anthropic'),
                baseUrl: url,
                apiKeyEnv: 'MH_TEST_INJECTED_AUTH_KEY',
              },
              system: 'A local authentication test.',
              messages: [],
              tools: [],
            },
            new AbortController().signal,
            () => {},
          );
          assert.equal(result.stopReason, 'end', result.errorMessage);
          assert.equal(headerKey, 'fixture-injected-key');
          assert.equal(bearer, undefined);
        },
      );
    },
  ));

for (const [name, values, expectedKey, expectedBearer] of [
  [
    'selected key',
    { MH_TEST_INJECTED_AUTH_KEY: 'fixture-selected-env-key', ANTHROPIC_API_KEY: 'fixture-default-env-key' },
    'fixture-selected-env-key',
    undefined,
  ],
  ['default key', { ANTHROPIC_API_KEY: 'fixture-default-env-key' }, 'fixture-default-env-key', undefined],
  ['bearer token', { ANTHROPIC_AUTH_TOKEN: 'fixture-bearer-token' }, undefined, 'Bearer fixture-bearer-token'],
] as const)
  test(`Anthropic environment authentication still supports ${name}`, async () =>
    withAuthEnv(values, async () => {
      let headerKey: string | string[] | undefined, bearer: string | undefined;
      await withSSEServer(
        (_, __, request) => {
          headerKey = request.headers['x-api-key'];
          bearer = request.headers.authorization;
          return { chunks: anthropicFixture([{ type: 'text' }]) };
        },
        async (url) => {
          const result = await new AnthropicProvider().stream(
            {
              model: {
                ...resolveModel('local-auth-fixture', {}, 'anthropic'),
                baseUrl: url,
                apiKeyEnv: 'MH_TEST_INJECTED_AUTH_KEY',
              },
              system: 'A local authentication test.',
              messages: [],
              tools: [],
            },
            new AbortController().signal,
            () => {},
          );
          assert.equal(result.stopReason, 'end', result.errorMessage);
          assert.equal(headerKey, expectedKey);
          assert.equal(bearer, expectedBearer);
        },
      );
    }));

test('Anthropic environment-resolved keys are redacted from error diagnostics', async () =>
  withAuthEnv({ ANTHROPIC_API_KEY: 'fixture-env-key-to-redact-9812' }, async () => {
    await withSSEServer(
      () => ({ status: 400, chunks: ['x'.repeat(1475) + 'fixture-env-key-to-redact-9812'] }),
      async (url) => {
        const result = await new AnthropicProvider().stream(
          {
            model: { ...resolveModel('local-auth-fixture', {}, 'anthropic'), baseUrl: url },
            system: 'A local authentication test.',
            messages: [],
            tools: [],
          },
          AbortSignal.timeout(5000),
          () => {},
        );
        assert.equal(result.stopReason, 'error');
        assert.match(result.errorMessage!, /HTTP 400:.*\[redacted\]/);
        assert.ok(!result.errorMessage!.includes('fixture-env-key-to-redact-9812'));
      },
    );
  }));
