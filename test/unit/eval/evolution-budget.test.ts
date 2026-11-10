import test from 'node:test';
import assert from 'node:assert/strict';
import type { AssistantMessage, Usage } from '../../../src/ai/index.ts';
import { defaultConfig } from '../../../src/app/config.ts';
import { evolutionBudget } from '../../../src/eval/evolution-budget.ts';

function fixture() {
  const config = defaultConfig(),
    optimizerConfig = defaultConfig();
  config.models[config.model] = { pricing: { input: 2, output: 5, cacheRead: 1, cacheWrite: 3 } };
  optimizerConfig.model = 'optimizer-fixture';
  optimizerConfig.models[optimizerConfig.model] = {
    pricing: { input: 4, output: 8, cacheRead: 2, cacheWrite: 6 },
  };
  return evolutionBudget({
    config,
    optimizerConfig,
    limits: { maxModelCalls: 10, maxTokens: 1000, maxDurationSec: 30 },
    onRecord: () => {},
  });
}

function reply(stopReason: AssistantMessage['stopReason'], usage: Usage): AssistantMessage {
  return { role: 'assistant', content: [], provider: 'anthropic', model: 'fixture', stopReason, usage };
}

for (const stopReason of ['error', 'aborted'] as const)
  test(`evolution ${stopReason} response with zero usage does not prove zero cost or complete accounting`, () => {
    const budget = fixture();
    try {
      budget.before('actor');
      budget.after('actor', reply(stopReason, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }));
      const result = budget.snapshot();
      assert.deepEqual(result.calls, { actor: 1, optimizer: 0, judge: 0 });
      assert.deepEqual(result.responses, result.calls);
      assert.equal(result.totalTokens, 0);
      assert.equal(result.usageComplete, false);
      assert.equal(result.cost, null);
    } finally {
      budget.close();
    }
  });

test('evolution completed usage separates actor, optimizer and judge with their configured prices', () => {
  const budget = fixture();
  const actor = { input: 10, output: 4, cacheRead: 2, cacheWrite: 1 },
    optimizer = { input: 20, output: 6, cacheRead: 3, cacheWrite: 2 },
    judge = { input: 7, output: 3, cacheRead: 1, cacheWrite: 0 };
  try {
    for (const [kind, usage] of [
      ['actor', actor],
      ['optimizer', optimizer],
      ['judge', judge],
    ] as const) {
      budget.before(kind);
      budget.after(kind, reply('end', usage));
    }
    const result = budget.snapshot();
    assert.deepEqual(result.calls, { actor: 1, optimizer: 1, judge: 1 });
    assert.deepEqual(result.responses, result.calls);
    assert.deepEqual(result.usage, { actor, optimizer, judge });
    assert.equal(result.totalTokens, 59);
    assert.equal(result.usageComplete, true);
    // Actor: 45, optimizer: 146, judge: 30 microdollars at the fixture prices.
    assert.ok(result.cost !== null && Math.abs(result.cost - 221 / 1_000_000) < 1e-12);
    assert.equal(result.stopReason, undefined);
  } finally {
    budget.close();
  }
});
