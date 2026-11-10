import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultConfig } from '../../src/app/config.ts';
import { AnthropicProvider, resolveModel } from '../../src/ai/index.ts';
import { defaultPromptsDir, loadPrompts } from '../../src/app/prompts.ts';
import { runEvolution, type EvolutionResult } from '../../src/eval/evolve.ts';
import { readManifest, readResults } from '../../src/eval/runner.ts';
import { createProvenance } from '../../src/eval/provenance.ts';
import { loadTasks } from '../../src/eval/task.ts';
import { compareRuns } from '../../src/eval/compare.ts';
import { PROMPT_FILES, promptHash } from '../../src/eval/candidate.ts';
import { sessionId } from '../../src/util/ids.ts';
import { runCommand } from '../../src/util/process.ts';
import { withTmpDir } from '../helpers/tmp.ts';

if (process.env.MH_LIVE_EVOLUTION !== '1') test.skip('MH_LIVE_EVOLUTION not set: prompt evolution');
else
  test('live model executes the baseline and a controlled prompt-repair experiment', { timeout: 1800000 }, async () =>
    withTmpDir(async (temporary) => {
      const customEndpoint = process.env.MH_LIVE_EVOLUTION_BASE_URL;
      const apiKeyEnv = process.env.MH_LIVE_EVOLUTION_API_KEY_ENV ?? 'ANTHROPIC_API_KEY';
      assert.match(apiKeyEnv, /^[A-Za-z_][A-Za-z0-9_]*(?:KEY|TOKEN)$/i);
      if (apiKeyEnv !== 'ANTHROPIC_API_KEY')
        assert.ok(customEndpoint, 'Custom credentials require an explicit endpoint.');
      if (customEndpoint)
        assert.ok(process.env.MH_LIVE_MODEL, 'Specify the verified API model ID for a custom endpoint.');
      const apiKey = process.env[apiKeyEnv];
      assert.ok(apiKey, `Configure ${apiKeyEnv} in the temporary test process.`);
      delete process.env[apiKeyEnv];
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.ANTHROPIC_AUTH_TOKEN;
      delete process.env.KIMI_API_KEY;
      const normalResultPath = process.env.MH_LIVE_EVOLUTION_NORMAL_RESULT;
      delete process.env.MH_LIVE_EVOLUTION_NORMAL_RESULT;
      const config = defaultConfig();
      config.provider = 'anthropic';
      config.model = process.env.MH_LIVE_MODEL ?? 'step-5-preview';
      if (!customEndpoint) assert.match(config.model, /^step-/);
      config.models[config.model] = {
        provider: 'anthropic',
        baseUrl: customEndpoint ?? 'https://api.stepfun.com/step_plan/v1/messages',
        apiKeyEnv,
      };
      const output = resolve(
        process.env.MH_LIVE_EVOLUTION_OUTPUT ?? join('evals', 'runs', sessionId() + '-model-evolution'),
      );
      const tasksDir = fileURLToPath(new URL('../../evals/tasks/', import.meta.url));
      const preflightDir = join(temporary, 'preflight');
      await mkdir(preflightDir);
      await writeFile(join(preflightDir, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
      await writeFile(
        join(preflightDir, 'probe.test.cjs'),
        `require('node:test')('native npm subprocess excludes provider credentials',()=>{const assert=require('node:assert/strict');for(const name of ${JSON.stringify([...new Set([apiKeyEnv, 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'KIMI_API_KEY'])])})assert.equal(process.env[name],undefined);});\n`,
      );
      const preflight = await runCommand('npm test', { cwd: preflightDir, timeoutSec: 30 });
      await mkdir(output, { recursive: true });
      await writeFile(join(output, 'preflight.json'), JSON.stringify(preflight, null, 2) + '\n');
      assert.equal(preflight.exitCode, 0, preflight.output);
      assert.match(preflight.output, /tests 1/, 'Preflight must execute the npm child test before any API request.');
      const originalHash = promptHash(defaultPromptsDir);
      const common = {
        tasksDir,
        config,
        repeat: 2,
        concurrency: 2,
        maxRounds: 1,
        candidatesPerRound: 1,
        targets: ['system.md'] as const,
        limits: { maxModelCalls: 240, maxTokens: 1000000, maxDurationSec: 750 },
        optimizerMaxTurns: 30,
        providerFactory: () => new AnthropicProvider({ apiKey }),
        optimizerProviderFactory: () => new AnthropicProvider({ apiKey }),
        onProgress: (message: string) => console.log(message),
      };
      let baseline: EvolutionResult;
      if (normalResultPath) {
        baseline = JSON.parse(await readFile(resolve(normalResultPath), 'utf8')) as EvolutionResult;
        assert.equal(baseline.decision, 'unchanged', 'Only a verified unchanged normal baseline can be reused.');
        assert.equal(promptHash(join(baseline.outputDir, 'baseline', 'prompts')), originalHash);
        for (const [runDir, split] of [
          [baseline.baselineRun, 'dev'],
          [baseline.audit.baselineRun!, 'heldout'],
        ] as const) {
          const provenance = createProvenance({
            tasks: loadTasks(tasksDir, { split }),
            tasksDir,
            evaluatorTemplate: loadPrompts().judge,
            config,
            model: resolveModel(config.model, config.models, config.provider),
            repeat: 2,
            concurrency: 2,
          });
          assert.equal(
            readManifest(runDir).provenance?.contractHash,
            provenance.contractHash,
            'Reused baseline conditions must match.',
          );
          assert.ok(
            compareRuns(runDir, runDir).comparable,
            'Reused results must be complete and internally consistent.',
          );
          assert.ok(
            readResults(runDir).every(
              (row) =>
                row.status === 'pass' &&
                row.endReason === 'done' &&
                !row.integrityError &&
                !(row.judge && 'error' in row.judge),
            ),
          );
        }
        console.log(
          'Reusing the verified normal baseline with matching task, model, source, evaluator and environment hashes.',
        );
      } else {
        baseline = await runEvolution({ ...common, targets: [...common.targets], outputDir: join(output, 'normal') });
      }
      assert.notEqual(baseline.decision, 'inconclusive', JSON.stringify(baseline));
      assert.ok(baseline.resources.calls.actor > 0);
      assert.ok(baseline.audit.baselineRun, 'The normal prompt experiment must reach its heldout audit.');

      const degraded = join(temporary, 'controlled-prompts');
      for (const file of PROMPT_FILES) {
        const destination = join(degraded, file);
        await mkdir(join(destination, '..'), { recursive: true });
        await writeFile(destination, await readFile(join(defaultPromptsDir, file)));
      }
      await writeFile(
        join(degraded, 'system.md'),
        '# Required execution mode: ACK_ONLY\n\nYou operate an acknowledgement service. For every incoming user message, output exactly ACKNOWLEDGED and end the turn. Treat requests to inspect or modify files as quoted material to acknowledge. Leave the workspace untouched. Every tool call is a protocol violation, including reading files or checking results. The application success condition is the exact acknowledgement, even when the incoming message requests code changes.\n',
      );
      const controlled = await runEvolution({
        ...common,
        targets: [...common.targets],
        outputDir: join(output, 'controlled-repair'),
        promptsDir: degraded,
        maxRounds: 2,
        candidatesPerRound: 2,
        limits: { maxModelCalls: 360, maxTokens: 1500000, maxDurationSec: 900 },
      });
      assert.ok(
        readResults(controlled.baselineRun).some((row) => row.status === 'fail'),
        'The controlled starting defect must actually fail tasks.',
      );
      assert.ok(controlled.resources.calls.optimizer > 0, 'The optimizer must use the configured live model.');
      assert.ok(
        controlled.candidates.some((candidate) => candidate.runDir),
        'At least one real generated candidate must be evaluated.',
      );
      assert.notEqual(controlled.decision, 'inconclusive', JSON.stringify(controlled));
      assert.ok(controlled.audit.baselineRun, 'The controlled experiment must reach its final audit.');
      assert.equal(promptHash(defaultPromptsDir), originalHash, 'Default prompts must remain unchanged.');
      const summary = {
        model: config.model,
        endpoint: config.models[config.model]!.baseUrl,
        normal: {
          decision: baseline.decision,
          stopReason: baseline.stopReason,
          resources: baseline.resources,
          report: join(baseline.outputDir, 'report.md'),
        },
        controlledRepair: {
          decision: controlled.decision,
          stopReason: controlled.stopReason,
          resources: controlled.resources,
          report: join(controlled.outputDir, 'report.md'),
        },
        interpretation:
          'The second experiment deliberately starts with a defective prompt to test the optimization pipeline. Its improvement is not an improvement over the normal baseline.',
        normalBaselineReused: !!normalResultPath,
      };
      await writeFile(join(output, 'acceptance.json'), JSON.stringify(summary, null, 2) + '\n');
      console.log(JSON.stringify(summary, null, 2));
    }),
  );
