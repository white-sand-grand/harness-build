import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveModel, type ModelInfo } from '../../../src/ai/index.ts';
import { loadPrompts } from '../../../src/app/prompts.ts';
import { runJudge } from '../../../src/eval/judge.ts';
import { scripted } from '../../helpers/fake-provider.ts';

const verdict = { score: 1, pass: true, reason: 'The explanation is correct and the files were preserved.' };
const model = resolveModel('reasoning-judge-fixture', {}, 'anthropic');
const options = (selectedModel: ModelInfo = model) => ({
  model: selectedModel,
  template: loadPrompts().judge,
  prompt: 'Explain the function without editing files.',
  rubric: 'The explanation is correct and the files are unchanged.',
  diff: '',
  finalText: 'The function normalizes whitespace.',
  signal: new AbortController().signal,
});

function reasoningJudge() {
  return scripted((request) => {
    const budget = request.maxOutputTokens ?? request.model.maxOutputTokens;
    // This deterministic model needs 2500 tokens before it can emit its 200-token verdict.
    const complete = budget >= 2700;
    return {
      thinking: 'SYNTHETIC_REASONING_BLOCK',
      text: complete ? JSON.stringify(verdict) : undefined,
      stopReason: complete ? 'end' : 'maxTokens',
      usage: { output: Math.min(budget, 2700) },
    };
  });
}

test('reasoning judge can reach its verdict after the old 2048-token cutoff', async () => {
  const limited = await runJudge({ ...options({ ...model, maxOutputTokens: 2048 }), provider: reasoningJudge() });
  assert.ok('error' in limited.verdict);
  assert.equal(limited.usage.output, 2048);
  const completed = await runJudge({ ...options(), provider: reasoningJudge() });
  assert.deepEqual(completed.verdict, verdict);
  assert.equal(completed.usage.output, 2700);
  assert.deepEqual(completed.response, { stopReason: 'end', text: JSON.stringify(verdict) });
  assert.ok(!JSON.stringify(completed).includes('SYNTHETIC_REASONING_BLOCK'));
});

test('judge honors a smaller configured budget and reports exhaustion with its final text', async () => {
  const result = await runJudge({ ...options({ ...model, maxOutputTokens: 600 }), provider: reasoningJudge() });
  assert.ok('error' in result.verdict);
  assert.match('error' in result.verdict ? result.verdict.error : '', /output budget exhausted.*600/);
  assert.equal(result.usage.output, 600);
  assert.deepEqual(result.response, { stopReason: 'maxTokens', text: '' });
});

test('judge distinguishes truncated JSON from a complete verdict at the token limit', async () => {
  const truncatedText = '{"score":1,"pass":';
  const truncated = await runJudge({
    ...options(),
    provider: scripted({ text: truncatedText, stopReason: 'maxTokens' }),
  });
  assert.match('error' in truncated.verdict ? truncated.verdict.error : '', /output budget exhausted/);
  assert.deepEqual(truncated.response, { stopReason: 'maxTokens', text: truncatedText });
  const complete = await runJudge({
    ...options(),
    provider: scripted({ text: JSON.stringify(verdict), stopReason: 'maxTokens' }),
  });
  assert.deepEqual(complete.verdict, verdict);
  assert.equal(complete.response.stopReason, 'maxTokens');
});

test('judge preserves malformed and interrupted verdict semantics', async () => {
  const malformed = await runJudge({ ...options(), provider: scripted({ text: 'not JSON' }) });
  assert.match('error' in malformed.verdict ? malformed.verdict.error : '', /did not contain a JSON object/);
  assert.deepEqual(malformed.response, { stopReason: 'end', text: 'not JSON' });
  const interrupted = await runJudge({
    ...options(),
    provider: scripted({ text: '{', stopReason: 'aborted' }),
  });
  assert.deepEqual(interrupted.verdict, { error: 'Judge interrupted' });
  assert.deepEqual(interrupted.response, { stopReason: 'aborted', text: '{' });
});
