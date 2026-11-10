import type { AssistantMessage, Usage } from '../ai/index.ts';
import { addUsage, zeroUsage, cost, resolveModel } from '../ai/index.ts';
import type { Config } from '../app/config.ts';

export type BudgetKind = 'actor' | 'optimizer' | 'judge';
export type EvolutionLimits = { maxModelCalls: number; maxTokens: number; maxDurationSec: number };
export type BudgetStop = 'modelCallBudget' | 'tokenBudget' | 'timeBudget' | 'aborted';
export function evolutionBudget(opts: {
  limits: EvolutionLimits;
  config: Config;
  optimizerConfig: Config;
  signal?: AbortSignal;
  onRecord: (record: Record<string, unknown>) => void;
}) {
  const controller = new AbortController(),
    started = Date.now();
  const calls = { actor: 0, optimizer: 0, judge: 0 },
    responses = { ...calls };
  const usage: Record<BudgetKind, Usage> = { actor: zeroUsage(), optimizer: zeroUsage(), judge: zeroUsage() };
  let stopReason: BudgetStop | undefined,
    knownCost = 0,
    completeCost = true,
    completeUsage = true;
  function stop(reason: BudgetStop) {
    stopReason ??= reason;
    controller.abort();
  }
  const abort = () => stop('aborted');
  opts.signal?.addEventListener('abort', abort, { once: true });
  if (opts.signal?.aborted) abort();
  const timer = setTimeout(() => stop('timeBudget'), opts.limits.maxDurationSec * 1000);
  timer.unref();
  function totalTokens() {
    return Object.values(usage).reduce((sum, u) => sum + u.input + u.output + u.cacheRead + u.cacheWrite, 0);
  }
  return {
    signal: controller.signal,
    before(kind: BudgetKind) {
      if (Date.now() - started >= opts.limits.maxDurationSec * 1000) stop('timeBudget');
      if (Object.values(calls).reduce((sum, n) => sum + n, 0) >= opts.limits.maxModelCalls) stop('modelCallBudget');
      if (totalTokens() >= opts.limits.maxTokens) stop('tokenBudget');
      if (controller.signal.aborted) throw new Error(`Evolution stopped: ${stopReason}`);
      calls[kind]++;
      opts.onRecord({ type: 'request', kind, calls: { ...calls } });
    },
    after(kind: BudgetKind, message: AssistantMessage) {
      responses[kind]++;
      if (message.stopReason === 'error' || message.stopReason === 'aborted') completeUsage = false;
      usage[kind] = addUsage(usage[kind], message.usage);
      const config = kind === 'optimizer' ? opts.optimizerConfig : opts.config;
      const amount = cost(message.usage, resolveModel(config.model, config.models, config.provider));
      if (amount === undefined) completeCost = false;
      else knownCost += amount;
      opts.onRecord({ type: 'response', kind, usage: message.usage, stopReason: message.stopReason });
      if (totalTokens() >= opts.limits.maxTokens) stop('tokenBudget');
    },
    snapshot() {
      const requested = Object.values(calls).reduce((sum, n) => sum + n, 0);
      const reported = Object.values(responses).reduce((sum, n) => sum + n, 0);
      return {
        limits: opts.limits,
        calls: { ...calls },
        responses: { ...responses },
        usage: structuredClone(usage),
        totalTokens: totalTokens(),
        usageComplete: completeUsage && requested === reported,
        cost: completeCost && completeUsage && requested === reported ? knownCost : null,
        durationMs: Date.now() - started,
        stopReason,
      };
    },
    close() {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', abort);
    },
  };
}
