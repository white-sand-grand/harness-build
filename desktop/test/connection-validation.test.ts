import assert from 'node:assert/strict';
import test from 'node:test';
import { connectionFieldErrors } from '../contracts.ts';

test('model IDs reject interface URLs while allowing provider-qualified model names', () => {
  for (const model of [
    'https://api.example.invalid/v1/messages',
    ' file:///private/model ',
    'ftp://example.invalid/model',
  ]) {
    const errors = connectionFieldErrors({ model });
    assert.match(errors.model!, /模型 ID.*Base URL/);
    assert.ok(!errors.model!.includes(model.trim()));
  }
  assert.deepEqual(
    connectionFieldErrors({ model: 'org/model-name', baseUrl: 'https://api.example.invalid/v1/messages' }),
    {},
  );
});

test('environment-name errors explain the key field without echoing fake secret values', () => {
  const secret = 'sk-fake-secret-not-an-env-name-987';
  const invalid = connectionFieldErrors({ model: 'step-5-preview', apiKeyEnv: secret }).apiKeyEnv!;
  const system = connectionFieldErrors({ model: 'step-5-preview', apiKeyEnv: 'PATH' }).apiKeyEnv!;
  assert.match(invalid, /STEP_API_KEY/);
  assert.match(invalid, /API Key/);
  assert.ok(!invalid.includes(secret));
  assert.match(system, /系统运行变量/);
  assert.notEqual(system, invalid);
  assert.deepEqual(connectionFieldErrors({ model: 'step-5-preview', apiKeyEnv: 'STEP_API_KEY' }), {});
});

test('service addresses reject credentials and URL suffixes without leaking supplied values', () => {
  for (const baseUrl of [
    'https://user:fake-password@api.example.invalid/v1',
    'https://api.example.invalid/v1?key=fake-secret-query',
    'https://api.example.invalid/v1#fake-private-fragment',
    'file:///private/model',
  ]) {
    const errors = connectionFieldErrors({ model: 'step-5-preview', baseUrl });
    assert.ok(errors.baseUrl);
    assert.ok(!JSON.stringify(errors).includes('fake-') && !JSON.stringify(errors).includes(baseUrl));
  }
  assert.deepEqual(connectionFieldErrors({ model: 'step-5-preview', baseUrl: '   ', apiKeyEnv: '   ' }), {});
});
