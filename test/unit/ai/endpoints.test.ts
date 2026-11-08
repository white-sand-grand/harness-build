import test from 'node:test';
import assert from 'node:assert/strict';
import { endpoint } from '../../../src/ai/shared.ts';
test('accepts full Messages URLs with a provider prefix', () =>
  assert.equal(
    endpoint('https://api.stepfun.com/step_plan/v1/messages', '/v1/messages'),
    'https://api.stepfun.com/step_plan/v1/messages',
  ));
test('accepts full Responses URLs', () =>
  assert.equal(endpoint('https://example.test/v1/responses/', '/v1/responses'), 'https://example.test/v1/responses'));
test('appends a method to a versioned prefix', () =>
  assert.equal(endpoint('https://example.test/custom/v1/', '/v1/messages'), 'https://example.test/custom/v1/messages'));
test('appends v1 and method to a root URL', () =>
  assert.equal(endpoint('https://example.test/', '/v1/responses'), 'https://example.test/v1/responses'));
