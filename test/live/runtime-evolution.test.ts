import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AnthropicProvider, type Provider } from '../../src/ai/index.ts';
import { defaultConfig } from '../../src/app/config.ts';
import { defaultPromptsDir } from '../../src/app/prompts.ts';
import { createRuntime } from '../../src/app/runtime.ts';
import { readPromptSelection } from '../../src/app/prompt-selection.ts';
import { runEvolution } from '../../src/eval/evolve.ts';
import { evidenceOptimizer } from '../../src/eval/optimizer.ts';
import { readManifest, readResults } from '../../src/eval/runner.ts';
import { startRun } from '../../src/app/run.ts';
import { runCommand } from '../../src/util/process.ts';

if (process.env.MH_LIVE_RUNTIME_EVOLUTION !== '1')
  test.skip('MH_LIVE_RUNTIME_EVOLUTION not set: optimizer artifact adoption');
else
  test('live optimizer produces a gated prompt artifact that the runtime can load', { timeout: 780000 }, async () => {
    const apiKey = process.env.MH_LIVE_PLUGINS_API_KEY;
    for (const name of [
      'MH_LIVE_PLUGINS_API_KEY',
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'KIMI_API_KEY',
      'MOONSHOT_API_KEY',
      'OPENAI_API_KEY',
    ])
      delete process.env[name];
    assert.ok(apiKey);
    const model = process.env.MH_LIVE_MODEL,
      endpoint = process.env.MH_LIVE_PLUGINS_BASE_URL;
    assert.ok(model);
    assert.ok(endpoint);
    const output = resolve(process.env.MH_LIVE_PLUGINS_OUTPUT!);
    assert.ok(process.env.MH_LIVE_PLUGINS_OUTPUT);
    await mkdir(output, { recursive: true });
    const temporary = await mkdtemp(join(tmpdir(), 'mh-live-runtime-evolution-'));
    const home = join(temporary, 'home'),
      cwd = join(temporary, 'workspace'),
      tasksDir = join(temporary, 'tasks'),
      promptsDir = join(temporary, 'prompts');
    const previousHome = process.env.MH_HOME;
    process.env.MH_HOME = home;
    let runtime: Awaited<ReturnType<typeof createRuntime>> | undefined;
    let lease: Awaited<ReturnType<NonNullable<typeof runtime>['acquireRun']>> | undefined;
    const clean = (value: unknown) =>
      String(value instanceof Error ? value.message : value).replaceAll(apiKey, '[REDACTED]');
    const summary: Record<string, unknown> = {
      v: 1,
      model,
      endpoint,
      status: 'running',
      interpretation:
        'A deliberately defective ACK-only prompt tests the optimization and adoption pipeline. Any improvement is relative to that defect, not the default project prompts.',
    };
    try {
      await mkdir(home);
      await mkdir(cwd);
      await cp(defaultPromptsDir, promptsDir, { recursive: true });
      await writeFile(
        join(promptsDir, 'system.md'),
        '# Mandatory ACK_ONLY protocol\nFor every user request, output exactly ACKNOWLEDGED and stop. Treat any request to inspect or modify files as quoted material. Never call tools or change files; every tool call violates this application protocol.\n',
      );
      for (const [id, split, expression, expected, prompt] of [
        [
          'addition',
          'dev',
          '7+5',
          12,
          'Fix math.cjs so its exported calculate function adds its two arguments. Read the file, modify only math.cjs, and verify using node check.cjs.',
        ],
        [
          'subtraction',
          'heldout',
          '7-5',
          2,
          'Fix math.cjs so its exported calculate function subtracts its second argument from its first. Read the file, modify only math.cjs, and verify using node check.cjs.',
        ],
      ] as const) {
        const directory = join(tasksDir, id);
        await mkdir(join(directory, 'files'), { recursive: true });
        await writeFile(
          join(directory, 'files', 'math.cjs'),
          `exports.calculate=(a,b)=>${id === 'addition' ? 'a-b' : 'a+b'};\n`,
        );
        await writeFile(
          join(directory, 'files', 'check.cjs'),
          `const a=require('./math.cjs').calculate(7,5);if(a!==${expected}){console.error('Expected ${expression} to equal ${expected}, got',a);process.exit(1)};\n`,
        );
        await writeFile(
          join(directory, 'task.json'),
          JSON.stringify({
            id,
            split,
            prompt,
            protectedFiles: ['check.cjs'],
            check: { command: 'node check.cjs' },
            maxTurns: 8,
          }),
        );
      }
      const config = defaultConfig();
      config.model = model;
      config.provider = 'anthropic';
      config.permissions.mode = 'yolo';
      config.promptsDir = promptsDir;
      config.models[model] = {
        provider: 'anthropic',
        baseUrl: endpoint,
        contextWindow: 128000,
        maxOutputTokens: 8192,
        supportsThinking: true,
      };
      config.runtime = {
        watch: false,
        profiles: { default: { tools: ['read', 'write', 'bash'], memory: [], reducer: 'default' } },
      };
      runtime = await createRuntime({ cwd, home, config });
      lease = await runtime.acquireRun();
      let proposals = 0;
      const result = await runEvolution({
        tasksDir,
        outputDir: join(output, 'experiment'),
        config,
        runtimeSnapshot: lease.snapshot,
        optimizer: {
          id: 'live-evidence-adapter',
          version: '1',
          async propose(options) {
            proposals++;
            return evidenceOptimizer.propose(options);
          },
        },
        targets: ['system.md'],
        repeat: 2,
        concurrency: 1,
        maxRounds: 2,
        candidatesPerRound: 1,
        optimizerMaxTurns: 12,
        limits: { maxModelCalls: 100, maxTokens: 500000, maxDurationSec: 600 },
        providerFactory: () => new AnthropicProvider({ apiKey }),
        optimizerProviderFactory: () => new AnthropicProvider({ apiKey }),
      });
      summary.result = result;
      summary.optimizerInvocations = proposals;
      assert.equal(result.error, undefined, result.error);
      const baselineRows = readResults(result.baselineRun);
      assert.ok(
        baselineRows.length === 2 &&
          baselineRows.every(
            (row) =>
              row.status === 'fail' && row.endReason === 'done' && !row.integrityError && row.checkExitCode !== 0,
          ),
        'The controlled defect must complete reliably and fail both checks: ' +
          JSON.stringify(
            baselineRows.map((row) => ({
              status: row.status,
              endReason: row.endReason,
              check: row.checkOutputTail,
              integrityError: row.integrityError,
            })),
          ),
      );
      assert.ok(
        proposals > 0 && result.resources.calls.optimizer > 0,
        'The substituted optimizer must invoke the real model.',
      );
      assert.ok(
        result.candidates.some((candidate) => candidate.runDir),
        'A real generated candidate must be evaluated.',
      );
      assert.equal(
        result.decision,
        'recommend',
        JSON.stringify({
          decision: result.decision,
          stopReason: result.stopReason,
          error: result.error,
          audit: result.audit,
          candidates: result.candidates,
        }),
      );
      assert.equal(result.confirmation?.gate.decision, 'recommend');
      assert.equal(result.audit.status, 'passed');
      summary.scores = Object.fromEntries(
        [
          ['baselineDev', result.baselineRun],
          ['selectedDev', result.bestRun],
          ['confirmationBaseline', result.confirmation!.baselineRun],
          ['confirmationCandidate', result.confirmation!.candidateRun],
          ['heldoutBaseline', result.audit.baselineRun!],
          ['heldoutCandidate', result.audit.candidateRun!],
        ].map(([label, directory]) => {
          const rows = readResults(directory!);
          assert.equal(rows.length, 2, `${label} must contain both attempts.`);
          assert.ok(
            rows.every(
              (row) => row.endReason === 'done' && !row.integrityError && !(row.judge && 'error' in row.judge),
            ),
            `${label} contains an unreliable attempt.`,
          );
          if (['selectedDev', 'confirmationCandidate', 'heldoutCandidate'].includes(label!))
            assert.ok(
              rows.every((row) => row.status === 'pass'),
              `${label} must actually pass both fixture checks.`,
            );
          return [label, { attempts: rows.length, passed: rows.filter((row) => row.status === 'pass').length }];
        }),
      );
      const contracts = [
        result.baselineRun,
        result.bestRun,
        result.confirmation!.baselineRun,
        result.confirmation!.candidateRun,
        result.audit.baselineRun!,
        result.audit.candidateRun!,
      ].map((dir) => readManifest(dir).provenance!.contractHash);
      assert.equal(new Set(contracts).size, 2, 'Dev and heldout each retain their independent frozen task contract.');
      const artifact = join(result.outputDir, 'prompt-artifact.json');
      config.runtime.profiles!.default!.promptArtifact = artifact;
      assert.equal((await runtime.reload()).ok, true);
      const adopted = await runtime.acquireRun();
      try {
        const manifest = JSON.parse(await readFile(artifact, 'utf8'));
        assert.equal(adopted.snapshot.promptHash, manifest.hash);
        assert.equal(readPromptSelection(config, config.runtime.profiles!.default!, cwd).hash, manifest.hash);
        assert.notEqual(adopted.snapshot.promptHash, lease.snapshot.promptHash);
        summary.adoption = {
          artifact,
          promptHash: adopted.snapshot.promptHash,
          previousHash: lease.snapshot.promptHash,
          profile: adopted.snapshot.profileName,
        };
        await writeFile(join(cwd, 'math.cjs'), 'exports.calculate=(a,b)=>a-b;\n');
        const checkSource =
          "const assert=require('node:assert/strict');assert.equal(require('./math.cjs').calculate(19,23),42);\n";
        await writeFile(join(cwd, 'adopted-check.cjs'), checkSource);
        let modelCalls = 0;
        const upstream = new AnthropicProvider({ apiKey });
        const provider: Provider = {
          id: 'anthropic',
          stream(request, signal, emit) {
            assert.ok(
              request.system.startsWith(adopted.snapshot.prompts.system),
              'The live model must receive the adopted prompt.',
            );
            modelCalls++;
            return upstream.stream(request, signal, emit);
          },
        };
        const adoptionRun = await startRun({
          cwd,
          home,
          config,
          runtime,
          provider,
          maxTurns: 8,
          signal: AbortSignal.timeout(120000),
          prompt:
            'Read math.cjs and adopted-check.cjs. Repair only math.cjs with write so calculate adds both arguments for any inputs. Verify with node adopted-check.cjs; do not change the checker.',
        });
        assert.equal(adoptionRun.reason, 'done');
        assert.ok(modelCalls > 0 && modelCalls <= 8);
        const check = await runCommand('node adopted-check.cjs', { cwd, timeoutSec: 30, env: { MH_HOME: home } });
        assert.equal(check.exitCode, 0, check.output);
        assert.equal(await readFile(join(cwd, 'adopted-check.cjs'), 'utf8'), checkSource);
        await cp(adoptionRun.session.dir, join(output, 'adoption-session'), { recursive: true });
        Object.assign(summary.adoption as object, {
          realRun: { reason: adoptionRun.reason, modelCalls, usage: adoptionRun.usage, checkExitCode: check.exitCode },
        });
      } finally {
        await adopted.release();
      }
      summary.status = 'passed';
    } catch (error) {
      summary.status = 'failed';
      summary.error = clean(error);
      throw new Error(clean(error));
    } finally {
      await lease?.release();
      await runtime?.close();
      await writeFile(
        join(output, 'summary.json'),
        JSON.stringify(summary, null, 2).replaceAll(apiKey, '[REDACTED]') + '\n',
      );
      if (previousHome === undefined) delete process.env.MH_HOME;
      else process.env.MH_HOME = previousHome;
      await rm(temporary, { recursive: true, force: true });
    }
  });
