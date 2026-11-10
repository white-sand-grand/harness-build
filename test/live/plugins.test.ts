import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AnthropicProvider, addUsage, zeroUsage, type Provider, type Usage } from '../../src/ai/index.ts';
import type { AgentEvent } from '../../src/agent/index.ts';
import { defaultConfig } from '../../src/app/config.ts';
import { startRun, type StartRunResult } from '../../src/app/run.ts';
import { createRuntime, type RuntimeManager } from '../../src/app/runtime.ts';
import { createSession, type SessionStore } from '../../src/session/index.ts';
import { sessionId } from '../../src/util/ids.ts';
import { runCommand } from '../../src/util/process.ts';

const credentialNames = [
  'MH_LIVE_PLUGINS_API_KEY',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'MOONSHOT_API_KEY',
  'KIMI_API_KEY',
  'OPENAI_API_KEY',
];
type CaseResult = {
  name: string;
  status: 'running' | 'passed' | 'failed';
  durationMs?: number;
  reason?: string;
  turns?: number;
  usage?: Usage;
  modelCalls?: number;
  tracePath?: string;
  entryStart?: number;
  entryEnd?: number;
  tools?: string[];
  error?: string;
};
type Tokens = { context: string; memory: string; prompt: string; result: string };

function pluginSource(version: string, tokens: Tokens) {
  return `import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isMainThread } from 'node:worker_threads';
const version = ${JSON.stringify(version)};
const tokens = ${JSON.stringify(tokens)};
export default {
  id: 'liveprobe', version,
  prompts: { workflow: 'For each verification request, call liveprobe__check with the exact current contextToken, memoryToken and promptToken. The current promptToken is ' + tokens.prompt + '. Then report the returned marker verbatim. Never reuse earlier tokens or answer without a new tool call.' },
  context: [{ id: 'current', async provide(ctx) { return 'Current contextToken: ' + tokens.context + '. Active plugin version: ' + version + '. Current conversation messages: ' + ctx.messages.length; } }],
  memory: [{ id: 'notes',
    async recall(ctx) { return 'Current memoryToken: ' + readFileSync(join(ctx.home, 'recall-' + version + '.txt'), 'utf8'); },
    async remember(ctx, reason) { appendFileSync(join(ctx.home, 'remember.jsonl'), JSON.stringify({ version, reason }) + '\\n'); }
  }],
  tools: [{ name: 'check', description: 'Verify the exact contextToken, memoryToken and promptToken from the current runtime, and return a unique version marker.',
    parameters: { type: 'object', properties: { contextToken: {type:'string'}, memoryToken: {type:'string'}, promptToken: {type:'string'} }, required: ['contextToken','memoryToken','promptToken'], additionalProperties: false },
    readOnly: false,
    async execute(args, ctx) {
      if (isMainThread) throw new Error('The plugin must execute in its worker.');
      if (${JSON.stringify(credentialNames)}.some(name => process.env[name] !== undefined)) throw new Error('Provider credentials reached the plugin worker.');
      if (args.contextToken !== tokens.context || args.memoryToken !== tokens.memory || args.promptToken !== tokens.prompt) throw new Error('Current context, memory and prompt tokens were not composed correctly.');
      if (version === '1') {
        const deadline = Date.now() + 8000;
        while (!existsSync(join(ctx.cwd, 'reload-ready'))) {
          ctx.signal.throwIfAborted();
          if (Date.now() > deadline) throw new Error('The replacement runtime did not become ready.');
          await new Promise(resolve => setTimeout(resolve, 20));
        }
      }
      appendFileSync(join(ctx.cwd, 'plugin-calls.jsonl'), JSON.stringify({version, worker:true, credentialsAbsent:true, tokensValidated:true}) + '\\n');
      return { content: [{type:'text',text:tokens.result}], details: {version,worker:true,tokensValidated:true} };
    }
  }]
};\n`;
}

if (process.env.MH_LIVE_PLUGINS !== '1') test.skip('MH_LIVE_PLUGINS not set: runtime plugins end to end');
else
  test(
    'live model composes plugin capabilities, reloads between runs, and executes built-in tools',
    { timeout: 600000 },
    async (t) => {
      const apiKey = process.env.MH_LIVE_PLUGINS_API_KEY;
      for (const name of credentialNames) delete process.env[name];
      assert.ok(apiKey, 'Set MH_LIVE_PLUGINS_API_KEY in the isolated live-test process.');
      const model = process.env.MH_LIVE_MODEL,
        endpoint = process.env.MH_LIVE_PLUGINS_BASE_URL;
      assert.ok(model, 'Set the exact verified model ID in MH_LIVE_MODEL.');
      assert.ok(endpoint, 'Set the verified Anthropic-compatible base URL in MH_LIVE_PLUGINS_BASE_URL.');
      const url = new URL(endpoint);
      assert.equal(url.protocol, 'https:');
      assert.equal(
        url.username + url.password + url.search + url.hash,
        '',
        'The endpoint must not contain credentials.',
      );
      const output = resolve(process.env.MH_LIVE_PLUGINS_OUTPUT ?? join('evals', 'runs', sessionId() + '-plugins'));
      await mkdir(output, { recursive: true });
      const summaryPath = join(output, 'summary.json'),
        cases: CaseResult[] = [];
      const summary = {
        v: 1,
        model,
        endpoint,
        status: 'running',
        limits: {
          caseDurationSec: 120,
          maxTurnsPerRun: 8,
          maxModelCalls: 32,
          reportedTokenBudget: 250000,
          totalDurationSec: 600,
        },
        cases,
        modelCalls: 0,
        usage: zeroUsage(),
        error: undefined as string | undefined,
      };
      await writeFile(summaryPath, JSON.stringify(summary, null, 2) + '\n', { flag: 'wx' });
      const clean = (error: unknown) =>
        (error instanceof Error ? error.message : String(error)).replaceAll(apiKey, '[REDACTED]');
      const temporary = await mkdtemp(join(tmpdir(), 'mh-live-plugins-')),
        home = join(temporary, 'home'),
        workspace = join(temporary, 'workspace'),
        pluginDir = join(temporary, 'plugin'),
        previousHome = process.env.MH_HOME;
      process.env.MH_HOME = home;
      let runtime: RuntimeManager | undefined,
        pluginSession: SessionStore | undefined,
        smokeSession: SessionStore | undefined,
        reloadPromise: Promise<{ ok: boolean; error?: string }> | undefined,
        reloadError: unknown;
      const wholeRun = new AbortController(),
        liveProvider = new AnthropicProvider({ apiKey });
      const provider: Provider = {
        id: 'anthropic',
        async stream(request, signal, emit) {
          assert.equal(request.model.id, model);
          assert.equal(request.model.baseUrl, endpoint);
          assert.ok(summary.modelCalls < summary.limits.maxModelCalls, 'Live model-call budget exhausted.');
          assert.ok(
            Object.values(summary.usage).reduce((sum, value) => sum + value, 0) < summary.limits.reportedTokenBudget,
            'Live reported-token budget exhausted.',
          );
          summary.modelCalls++;
          const message = await liveProvider.stream(request, signal, emit);
          if (message.errorMessage) message.errorMessage = clean(message.errorMessage);
          summary.usage = addUsage(summary.usage, message.usage);
          return message;
        },
      };
      async function runCase<T>(
        name: string,
        action: (signal: AbortSignal, abort: () => void, record: CaseResult) => Promise<T>,
      ): Promise<T> {
        const controller = new AbortController(),
          started = Date.now(),
          callsBefore = summary.modelCalls,
          record: CaseResult = { name, status: 'running' };
        cases.push(record);
        const timer = setTimeout(() => controller.abort(), 120000),
          signal = AbortSignal.any([controller.signal, wholeRun.signal, t.signal]);
        try {
          const result = await action(signal, () => controller.abort(), record);
          signal.throwIfAborted();
          record.status = 'passed';
          return result;
        } catch (error) {
          record.status = 'failed';
          record.error = clean(error);
          throw new Error(record.error);
        } finally {
          clearTimeout(timer);
          controller.abort();
          record.durationMs = Date.now() - started;
          record.modelCalls = summary.modelCalls - callsBefore;
          await writeFile(summaryPath, JSON.stringify(summary, null, 2) + '\n');
        }
      }
      function recordRun(
        record: CaseResult,
        result: StartRunResult,
        events: AgentEvent[],
        start: number,
        kind: string,
      ) {
        record.reason = result.reason;
        record.turns = result.turns;
        record.usage = result.usage;
        record.tracePath = join(output, 'sessions', kind, 'session.jsonl');
        record.entryStart = start;
        record.entryEnd = result.session.entries().length;
        record.tools = events.filter((event) => event.type === 'toolStart').map((event) => event.call.name);
        assert.equal(result.reason, 'done', `The live run ended with ${result.reason}; inspect ${record.tracePath}.`);
        assert.ok(result.turns <= 8);
      }
      const tokens = Object.fromEntries(
        ['1', '2'].map((version) => [
          version,
          {
            context: 'CTX_' + randomUUID(),
            memory: 'MEM_' + randomUUID(),
            prompt: 'PROMPT_' + randomUUID(),
            result: 'PLUGIN_RESULT_V' + version + '_' + randomUUID(),
          },
        ]),
      ) as Record<'1' | '2', Tokens>;
      const writePlugin = (version: '1' | '2') => {
        writeFileSync(join(pluginDir, 'plugin.mjs'), pluginSource(version, tokens[version]));
        writeFileSync(
          join(pluginDir, 'mh-plugin.json'),
          JSON.stringify({ id: 'liveprobe', version, module: 'plugin.mjs', files: ['plugin.mjs'] }),
        );
        writeFileSync(join(home, 'recall-' + version + '.txt'), tokens[version].memory);
      };
      const config = defaultConfig();
      config.provider = 'anthropic';
      config.model = model;
      config.models[model] = {
        provider: 'anthropic',
        baseUrl: endpoint,
        contextWindow: 1000000,
        maxOutputTokens: 8192,
      };
      config.runtime = {
        profile: 'plugins',
        plugins: [pluginDir],
        watch: false,
        profiles: {
          plugins: {
            tools: ['liveprobe__check'],
            context: ['liveprobe/current'],
            memory: ['liveprobe/notes'],
            prompts: ['liveprobe/workflow'],
            reducer: 'none',
            offload: false,
          },
          smoke: {
            tools: ['read', 'write', 'bash'],
            context: [],
            memory: [],
            prompts: [],
            reducer: 'none',
            offload: false,
          },
        },
      };
      try {
        await Promise.all([mkdir(home), mkdir(workspace), mkdir(pluginDir)]);
        const preflightDir = join(temporary, 'preflight');
        await mkdir(preflightDir);
        await writeFile(
          join(preflightDir, 'credential-boundary.test.cjs'),
          `const test=require('node:test'); const assert=require('node:assert/strict'); const fs=require('node:fs'); test('provider credentials stay outside tool subprocesses',()=>{ for(const name of ${JSON.stringify(credentialNames)}) assert.equal(process.env[name],undefined); fs.writeFileSync('proof.json',JSON.stringify({home:process.env.MH_HOME,executed:true})); });\n`,
        );
        const preflight = await runCommand('node --test credential-boundary.test.cjs', {
          cwd: preflightDir,
          timeoutSec: 30,
          signal: t.signal,
        });
        assert.equal(preflight.exitCode, 0, clean(preflight.output));
        assert.match(preflight.output, /\btests\s+1\b/, 'The preflight must execute an actual Node child test.');
        assert.deepEqual(JSON.parse(await readFile(join(preflightDir, 'proof.json'), 'utf8')), {
          home,
          executed: true,
        });
        await writeFile(
          join(output, 'preflight.json'),
          JSON.stringify({ exitCode: preflight.exitCode, executedTests: 1, credentialsAbsent: true }, null, 2) + '\n',
        );
        writePlugin('1');
        runtime = await createRuntime({ cwd: workspace, home, config, ask: async () => 'once', trustPlugins: true });
        pluginSession = createSession(home, workspace);
        async function pluginCase(name: string, version: '1' | '2', reloadDuringTool = false) {
          await runCase(name, async (signal, abort, record) => {
            const events: AgentEvent[] = [],
              start = pluginSession?.entries().length ?? 0;
            const result = await startRun({
              cwd: workspace,
              home,
              config,
              runtime,
              session: pluginSession,
              provider,
              ask: async () => 'once',
              signal,
              maxTurns: 8,
              prompt: `Perform a new runtime verification now. Use the current dynamic context, recalled memory, and active workflow prompt to call liveprobe__check, even if an earlier turn already used it. Report the returned marker verbatim. Verification request: ${randomUUID()}.`,
              onEvent(event) {
                events.push(event);
                if (
                  reloadDuringTool &&
                  event.type === 'toolStart' &&
                  event.call.name === 'liveprobe__check' &&
                  !reloadPromise
                ) {
                  writePlugin('2');
                  reloadPromise = runtime!
                    .reload()
                    .then((reloaded) => {
                      assert.equal(reloaded.ok, true, reloaded.error);
                      assert.equal(
                        runtime!.status().activeRuns,
                        1,
                        'The old generation must remain leased during replacement.',
                      );
                      writeFileSync(join(workspace, 'reload-ready'), 'ready');
                      return reloaded;
                    })
                    .catch((error) => {
                      reloadError = error;
                      abort();
                      return { ok: false, error: clean(error) };
                    });
                }
              },
            });
            pluginSession = result.session;
            recordRun(record, result, events, start, 'plugin');
            if (reloadDuringTool) {
              assert.ok(reloadPromise, 'The real model must invoke the custom worker tool.');
              await reloadPromise;
              if (reloadError) throw reloadError;
            }
            const calls = events.filter((event) => event.type === 'toolEnd' && event.call.name === 'liveprobe__check');
            assert.ok(calls.length > 0, 'The real model must call the worker tool.');
            for (const event of calls)
              if (event.type === 'toolEnd') {
                assert.equal(!!event.result.isError, false);
                assert.deepEqual(event.result.details, { version, worker: true, tokensValidated: true });
                assert.ok(
                  event.result.content.some((block) => block.type === 'text' && block.text === tokens[version].result),
                );
              }
            assert.ok(
              result.finalText.includes(tokens[version].result),
              'The model must receive and report the worker result.',
            );
            const remembered = readFileSync(join(home, 'remember.jsonl'), 'utf8')
              .trim()
              .split('\n')
              .map((line) => JSON.parse(line));
            assert.deepEqual(remembered.at(-1), { version, reason: 'done' });
            assert.equal(remembered.length, version === '1' ? 1 : name.includes('rollback') ? 3 : 2);
            await cp(result.session.dir, join(output, 'sessions', 'plugin'), { recursive: true });
          });
        }
        await pluginCase('v1-in-flight-reload-retains-current-tools-and-memory', '1', true);
        assert.equal(runtime.status().plugins[0]?.version, '2');
        await pluginCase('same-session-next-run-uses-v2', '2');
        const previousId = runtime.status().id,
          rejected = await runtime.reload('missing-profile');
        assert.equal(rejected.ok, false);
        assert.match(rejected.error ?? '', /Unknown runtime profile/);
        assert.equal(runtime.status().id, previousId);
        assert.equal(runtime.status().plugins[0]?.version, '2');
        await pluginCase('failed-profile-reload-rollback-still-uses-v2', '2');
        await runCase('built-in-read-write-bash-repairs-and-runs-a-real-node-test', async (signal, _abort, record) => {
          assert.equal((await runtime!.reload('smoke')).ok, true);
          const smokeDir = join(workspace, 'smoke');
          await mkdir(smokeDir);
          await writeFile(join(smokeDir, 'math.cjs'), 'exports.add=(a,b)=>a-b;\n');
          const testSource =
            "const test=require('node:test');const assert=require('node:assert/strict');test('addition',()=>{const actual=require('./math.cjs').add(7,5);assert.equal(actual,12);require('node:fs').writeFileSync('node-test-proof.json',JSON.stringify({executed:true,actual}));});\n";
          await writeFile(join(smokeDir, 'math.test.cjs'), testSource);
          const baseline = await runCommand('node --test math.test.cjs', { cwd: smokeDir, timeoutSec: 30, signal });
          assert.notEqual(baseline.exitCode, 0, 'The smoke fixture must fail before repair.');
          assert.match(baseline.output, /\btests\s+1\b/);
          const events: AgentEvent[] = [];
          smokeSession = createSession(home, workspace);
          const result = await startRun({
            cwd: workspace,
            home,
            config,
            runtime,
            session: smokeSession,
            provider,
            ask: async () => 'once',
            signal,
            maxTurns: 8,
            prompt:
              'Use read to inspect smoke/math.cjs and smoke/math.test.cjs. Repair only smoke/math.cjs with write so add(7,5) is 12. Use bash to execute node --test smoke/math.test.cjs, and finish only after that actual test passes. Do not change the test file. The test writes node-test-proof.json in the current working directory.',
            onEvent: (event) => events.push(event),
          });
          smokeSession = result.session;
          recordRun(record, result, events, 0, 'smoke');
          for (const name of ['read', 'write', 'bash'])
            assert.ok(record.tools!.includes(name), `The real model must use ${name}.`);
          assert.ok(
            events.some(
              (event) =>
                event.type === 'toolEnd' &&
                event.call.name === 'bash' &&
                /\btests\s+1\b/.test(JSON.stringify(event.result.content)) &&
                (event.result.details as { exitCode?: number })?.exitCode === 0,
            ),
            'The model must run a successful Node test subprocess.',
          );
          assert.equal(await readFile(join(smokeDir, 'math.test.cjs'), 'utf8'), testSource);
          const verified = await runCommand('node --test math.test.cjs', { cwd: smokeDir, timeoutSec: 30, signal });
          assert.equal(verified.exitCode, 0, clean(verified.output));
          assert.match(verified.output, /\btests\s+1\b/);
          assert.deepEqual(JSON.parse(await readFile(join(smokeDir, 'node-test-proof.json'), 'utf8')), {
            executed: true,
            actual: 12,
          });
          await cp(result.session.dir, join(output, 'sessions', 'smoke'), { recursive: true });
        });
        summary.status = 'passed';
      } catch (error) {
        summary.status = 'failed';
        summary.error = clean(error);
        throw new Error(summary.error);
      } finally {
        wholeRun.abort();
        await reloadPromise?.catch(() => {});
        try {
          await runtime?.close();
          for (const [kind, session] of [
            ['plugin', pluginSession],
            ['smoke', smokeSession],
          ] as const)
            if (session) await cp(session.dir, join(output, 'sessions', kind), { recursive: true });
          for (const [source, target] of [
            [join(home, 'remember.jsonl'), 'remember.jsonl'],
            [join(workspace, 'plugin-calls.jsonl'), 'plugin-calls.jsonl'],
          ] as const)
            try {
              await writeFile(join(output, target), await readFile(source));
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            }
        } catch (error) {
          summary.status = 'failed';
          summary.error = clean(error);
          throw new Error(summary.error);
        } finally {
          await writeFile(summaryPath, JSON.stringify(summary, null, 2) + '\n');
          if (previousHome === undefined) delete process.env.MH_HOME;
          else process.env.MH_HOME = previousHome;
          await rm(temporary, { recursive: true, force: true });
        }
      }
    },
  );
