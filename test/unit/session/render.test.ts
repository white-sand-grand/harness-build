import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMessages } from '../../../src/session/render.ts';
import { zeroUsage } from '../../../src/ai/index.ts';
test('rendered failure transcripts retain model transport errors for analyze', () => {
  const rendered = renderMessages([
    {
      role: 'assistant',
      content: [],
      stopReason: 'error',
      errorMessage: 'HTTP 503: upstream unavailable',
      usage: zeroUsage(),
      model: 'test',
      provider: 'openai',
    },
  ]);
  assert.match(rendered, /HTTP 503: upstream unavailable/);
});
