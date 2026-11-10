import test from 'node:test';
import assert from 'node:assert/strict';
import { AnthropicProvider, resolveModel, type ModelRequest, type StreamEvent } from '../../../src/ai/index.ts';
import { anthropicFixture, withSSEServer } from '../../helpers/sse-server.ts';

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
