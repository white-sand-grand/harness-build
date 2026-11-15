import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { resolveModel, zeroUsage, addUsage } from '../ai/index.ts';
import { realPath, resolvePath, isWithin } from '../util/paths.ts';
import { createRuntime, type RuntimeLease, type RuntimeManager } from '../app/runtime.ts';
import { loadPrompts } from '../app/prompts.ts';
import { fingerprint } from '../app/background/contract.ts';
import type { BackgroundJobHandler, BackgroundJobResult } from '../app/background/jobs.ts';
import { loadTasks, type AttemptResult } from '../eval/task.ts';
import { readManifest, readResults, type RunManifest } from '../eval/runner.ts';
import { createProvenance } from '../eval/provenance.ts';
import { runEvolution } from '../eval/evolve.ts';

/** Eval remains in the CLI's higher layer; app only invokes the injected handler. */
export function evolutionJob(tasksDir: string): BackgroundJobHandler {
  return async (context) => {
    let runtime: RuntimeManager | undefined, lease: RuntimeLease | undefined;
    const skipped = (reason: string, evidenceKey?: string): BackgroundJobResult => {
      const file = join(context.outputDir, 'maintenance.json');
      writeFileSync(file, JSON.stringify({ status: 'skipped', reason, evidenceKey }, null, 2) + '\n');
      return {
        result: { reason: 'done', finalText: '本次未启动进化：' + reason, usage: zeroUsage(), turns: 0 },
        verification: 'notRun',
        artifacts: [file],
        evidenceKey,
        evidence: { status: 'skipped', reason },
      };
    };
    try {
      const payload = [...context.sourceEvents]
        .reverse()
        .map((event) => event.payload)
        .find(
          (value) =>
            value && typeof value === 'object' && typeof (value as { evidenceRun?: unknown }).evidenceRun === 'string',
        ) as { evidenceRun: string } | undefined;
      if (!payload) return skipped('没有指向有效评测运行的 evidenceRun。');
      let manifest: RunManifest, results: AttemptResult[];
      try {
        const evidenceRun = realPath(resolvePath(context.claim.task.cwd, payload.evidenceRun));
        if (!isWithin(context.claim.task.cwd, evidenceRun)) return skipped('评测证据不在已授权工作区内。');
        if (
          statSync(join(evidenceRun, 'run.json')).size > 1024 * 1024 ||
          statSync(join(evidenceRun, 'results.jsonl')).size > 10 * 1024 * 1024
        )
          return skipped('评测证据超过读取上限。');
        manifest = readManifest(evidenceRun);
        results = readResults(evidenceRun);
        if (
          !manifest ||
          manifest.v !== 1 ||
          !Array.isArray(manifest.tasks) ||
          manifest.tasks.some((task) => !task || typeof task.id !== 'string') ||
          results.some((row) => !row || typeof row !== 'object')
        )
          return skipped('评测证据结构不完整。');
      } catch {
        return skipped('评测证据不可读或格式损坏。');
      }
      const ids = new Set(manifest.tasks.map((task) => task.id));
      const currentTasks = loadTasks(tasksDir).filter((task) => ids.has(task.id));
      if (currentTasks.length !== ids.size || ids.size !== manifest.tasks.length)
        return skipped('任务清单与可信评测资产不一致。');
      const dev = new Set(currentTasks.filter((task) => task.split === 'dev').map((task) => task.id));
      const devResults = results.filter((row) => dev.has(row.taskId));
      const evidenceKey = fingerprint({ contract: manifest.provenance?.contractHash, devResults });
      const previous = context.previousRuns.find((run) => run.job?.evidenceKey === evidenceKey);
      if (previous) {
        const result = skipped('相同证据已经处理，不重复消耗模型预算。', evidenceKey);
        result.evidence = previous.job?.evidence;
        result.artifacts.push(...(previous.job?.artifacts ?? []));
        return result;
      }
      const failures = new Set(
        results
          .filter(
            (row) =>
              dev.has(row.taskId) &&
              row.status === 'fail' &&
              row.endReason === 'done' &&
              !row.integrityError &&
              !(row.judge && 'error' in row.judge),
          )
          .map((row) => `${row.taskId}:${row.attempt}`),
      );
      if (failures.size < 2 || !manifest.provenance)
        return skipped('不足两条可靠 dev 失败，或缺少可比较的 provenance。', evidenceKey);
      if (context.config.runtime) {
        runtime = await createRuntime({ cwd: context.claim.task.cwd, home: context.home, config: context.config });
        lease = await runtime.acquireRun();
      }
      const provenance = createProvenance({
        tasks: currentTasks,
        tasksDir,
        evaluatorTemplate: loadPrompts(context.config.promptsDir).judge,
        config: context.config,
        model: resolveModel(context.config.model, context.config.models, context.config.provider),
        repeat: manifest.provenance.repeat,
        concurrency: manifest.provenance.concurrency,
        runtimeSnapshot: lease?.snapshot,
      });
      if (provenance.contractHash !== manifest.provenance.contractHash)
        return skipped('模型、任务、评分器、实现或执行环境合同已经改变。', evidenceKey);
      const result = await runEvolution({
        tasksDir,
        outputDir: join(context.outputDir, 'experiment'),
        config: context.config,
        runtimeSnapshot: lease?.snapshot,
        repeat: Math.max(2, manifest.provenance.repeat),
        maxRounds: 1,
        candidatesPerRound: 1,
        targets: ['system.md'],
        concurrency: 1,
        limits: {
          maxModelCalls: context.claim.task.limits.maxRunCalls,
          maxTokens: context.claim.task.limits.maxRunTokens,
          maxDurationSec: context.claim.task.limits.maxDurationSec,
        },
        providerFactory: () => context.provider,
        optimizerProviderFactory: () => context.provider,
        signal: context.signal,
      });
      const artifact = join(result.outputDir, 'prompt-artifact.json');
      let promptHash: string | undefined;
      try {
        promptHash = (JSON.parse(readFileSync(artifact, 'utf8')) as { hash: string }).hash;
      } catch {
        /* Inconclusive jobs need not produce a candidate. */
      }
      return {
        result: {
          reason: result.stopReason === 'aborted' ? 'aborted' : result.decision === 'inconclusive' ? 'error' : 'done',
          finalText: `进化结论：${result.decision}；独立审计：${result.audit.status}。\n停止原因：${result.stopReason}${result.error ? '\n' + result.error : ''}\n报告：${join(result.outputDir, 'report.md')}\n候选只生成报告与产物，尚未采用。`,
          usage: Object.values(result.resources.usage).reduce(addUsage, zeroUsage()),
          turns: 0,
        },
        verification:
          result.decision === 'recommend' && result.audit.status === 'passed'
            ? 'passed'
            : result.decision === 'reject'
              ? 'failed'
              : 'unknown',
        artifacts: [join(result.outputDir, 'report.md'), ...(promptHash ? [artifact] : [])],
        evidenceKey,
        evidence: { decision: result.decision, audit: result.audit.status, promptHash },
      };
    } finally {
      await lease?.release();
      await runtime?.close();
    }
  };
}
