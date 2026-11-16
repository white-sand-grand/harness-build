// Explicit live acceptance only. Bootstrap JSON arrives over stdin, never argv or a credential file.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, cp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { AnthropicProvider, resolveModel } from '../../src/ai/index.ts';
import { defaultConfig } from '../../src/app/config.ts';
import { runRalph } from '../../src/app/ralph.ts';
import { startRun } from '../../src/app/run.ts';
import { compactSession } from '../../src/app/compact.ts';
import { openSession } from '../../src/session/index.ts';
import { requestTokens } from '../../src/context/tokens.ts';
import { loadedImplementationHash } from '../../src/util/implementation.ts';
import { nonSecretEnvironment } from '../../src/util/process.ts';

assert.equal(process.env.MH_LIVE, '1', 'Explicit MH_LIVE=1 is required.');
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const bootstrap = JSON.parse(Buffer.concat(chunks).toString('utf8'));
let key = bootstrap.key;
delete bootstrap.key;
chunks.length = 0;
assert.ok(typeof key === 'string' && key.length > 10, 'Missing Step credential.');
process.env.STEP_ACCEPTANCE_KEY = key;
const output = resolve(bootstrap.output),
  canonical = resolve(bootstrap.canonical);
const phase = bootstrap.phase;
const project = join(output, 'project'),
  home = join(output, 'home');
const grader = fileURLToPath(new URL('./long-task-grader.mjs', import.meta.url));
const reportFile = join(output, 'report.json');
const sha = (value) => createHash('sha256').update(value).digest('hex');
const redact = (value) => String(value).split(key).join('[REDACTED]');
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
let limits = { modelCalls: 59, httpRequests: 89, reportedTokens: 299000, durationSec: 1200, ...bootstrap.limits };
for (const [name, cap] of Object.entries({
  modelCalls: 59,
  httpRequests: 89,
  reportedTokens: 299000,
  durationSec: 1200,
}))
  assert.ok(Number.isSafeInteger(limits[name]) && limits[name] > 0 && limits[name] <= cap);
let report;
const actualFetch = globalThis.fetch;
const controller = new AbortController();
let timer;
const save = () => writeFile(reportFile, redact(JSON.stringify(report, null, 2)) + '\n');
const totalTokens = () => Object.values(report.usage).reduce((sum, n) => sum + n, 0);
async function hashes() {
  const files = [
    grader,
    fileURLToPath(import.meta.url),
    ...['forth', 'react', 'sgf-parsing'].map((name) => join(canonical, name, 'canonical-data.json')),
  ];
  return Object.fromEntries(await Promise.all(files.map(async (file) => [file, sha(await readFile(file))])));
}
function check() {
  const child = spawnSync(process.execPath, [grader, project, canonical], {
    cwd: project,
    encoding: 'utf8',
    timeout: 30000,
    env: nonSecretEnvironment(process.env),
    maxBuffer: 2 * 1024 * 1024,
  });
  if (child.error || !child.stdout.trim()) throw child.error ?? new Error('The grader produced no result.');
  return { exitCode: child.status, ...JSON.parse(child.stdout) };
}
try {
  await mkdir(output, { recursive: true });
  if (phase === 'start') {
    await mkdir(project, { recursive: true });
    await mkdir(home, { recursive: true });
    const initialized = spawnSync('git', ['init', project], {
      encoding: 'utf8',
      env: nonSecretEnvironment(process.env),
    });
    assert.equal(initialized.status, 0, 'The isolated fixture needs its own Git root.');
    await cp(canonical, join(project, 'specs'), { recursive: true });
    await writeFile(
      join(project, 'forth.mjs'),
      "export class Forth { constructor(){this.stack=[]} evaluate(){throw new Error('not implemented')} }\n",
    );
    await writeFile(
      join(project, 'react.mjs'),
      "export class InputCell { constructor(){throw new Error('not implemented')} }\nexport class ComputeCell {}\n",
    );
    await writeFile(join(project, 'sgf.mjs'), "export function parse(){throw new Error('not implemented')}\n");
    report = {
      v: 1,
      startedAt: new Date().toISOString(),
      limits,
      runtime: {
        mode: 'ralph',
        contextWindow: 24000,
        maxOutputTokens: 4096,
        clearAtRatio: 0.14,
        compactAtRatio: 0.32,
        keepRecentTokens: 1400,
        startMaxTurns: 1,
        ...bootstrap.runtime,
      },
      output,
      project,
      home,
      model: 'step-5-preview',
      endpoint: 'https://api.stepfun.com/step_plan/v1/messages',
      implementationHash: loadedImplementationHash,
      modelCalls: 0,
      httpRequests: 0,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      calls: [],
      phases: [],
      processes: [],
      frozen: await hashes(),
      initial: check(),
    };
    assert.equal(report.initial.total, 93);
    assert.equal(report.initial.passed, 0, 'All untouched stubs must fail.');
  } else {
    report = JSON.parse(await readFile(reportFile, 'utf8'));
    limits = report.limits;
    assert.equal(report.implementationHash, loadedImplementationHash, 'Core implementation changed between phases.');
    assert.deepEqual(await hashes(), report.frozen, 'Frozen grader or canonical cases changed.');
  }
  report.processes.push({ phase, pid: process.pid, startedAt: new Date().toISOString() });
  const remaining = limits.durationSec * 1000 - (Date.now() - Date.parse(report.startedAt));
  assert.ok(remaining > 0, 'Acceptance time budget exhausted.');
  timer = setTimeout(() => controller.abort(), remaining);
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert.equal(url.href, report.endpoint, 'Unexpected network endpoint.');
    if (report.httpRequests >= limits.httpRequests || controller.signal.aborted)
      throw new Error('Acceptance HTTP/time budget exhausted.');
    report.httpRequests++;
    return actualFetch(input, {
      ...init,
      signal: AbortSignal.any([controller.signal, ...(init?.signal ? [init.signal] : [])]),
    });
  };
  const underlying = new AnthropicProvider();
  const provider = {
    id: 'anthropic',
    async stream(request, signal, emit) {
      if (
        report.modelCalls >= limits.modelCalls ||
        totalTokens() +
          requestTokens(request.messages, request) +
          (request.maxOutputTokens ?? request.model.maxOutputTokens) >
          limits.reportedTokens
      )
        throw new Error('Acceptance model/token budget exhausted.');
      report.modelCalls++;
      const started = Date.now();
      const message = await underlying.stream(request, signal, emit);
      for (const name of Object.keys(report.usage)) report.usage[name] += message.usage[name];
      report.calls.push({
        phase,
        kind: request.system.includes('ContinuationSummaryV1') ? 'summary' : 'agent',
        stopReason: message.stopReason,
        usage: message.usage,
        ms: Date.now() - started,
        error: message.errorMessage ? redact(message.errorMessage) : undefined,
      });
      await save();
      return message;
    },
  };
  const config = defaultConfig();
  config.model = 'step-5-preview';
  config.models[config.model] = {
    provider: 'anthropic',
    apiKeyEnv: 'STEP_ACCEPTANCE_KEY',
    baseUrl: report.endpoint,
    contextWindow: report.runtime.contextWindow,
    maxOutputTokens: report.runtime.maxOutputTokens,
    supportsImages: false,
    supportsThinking: false,
  };
  config.compaction = {
    enabled: true,
    clearAtRatio: report.runtime.clearAtRatio,
    compactAtRatio: report.runtime.compactAtRatio,
    keepRecentTokens: report.runtime.keepRecentTokens,
  };
  const goal = `Build a dependency-free offline JavaScript library implementing three published Exercism exercises. Read specs/<exercise>/description.md and canonical-data.json, one exercise at a time, and implement the algorithms. After reading one exercise, WRITE its implementation before exploring the next exercise. Do not repeatedly re-read the same material. The API below is complete: do not inspect the external grader or anything outside this project. Do not hardcode examples or expected results. Keep the specs unchanged. Do not use network, install packages, run git commits or alter the grader. Write only the three modules and your progress notes.
1. forth.mjs exports class Forth. A new instance has stack=[]; evaluate(source) executes one source string and preserves its stack and word dictionary across calls. Errors must use the exact canonical error strings. Cover integer arithmetic, stack operations, case-insensitive words, definitions and definition-time binding.
2. react.mjs exports InputCell(initialValue) and ComputeCell(inputs, compute). Both expose .value. InputCell.setValue(value) updates dependent cells. compute receives the array of current input values. ComputeCell.addCallback(fn) and removeCallback(fn) manage callbacks receiving the final numeric value. Notify once only when the stable value changed, including diamond dependencies.
3. sgf.mjs exports parse(encoded), returning {properties: object of string arrays, children: node arrays}. Support sequences, branching, multiple values, escaping and Text whitespace rules; throw exact canonical error strings.
Implement all three. Work incrementally; read the relevant specification before changing a module. You may create small temporary local tests, but remove your temporary test files before finishing. The host independently checks all 93 canonical cases and reports failures between iterations. Maintain concise progress notes for the next session. Preserve the module names and exported API exactly.`;
  if (phase === 'start') {
    const model = resolveModel(config.model, config.models, config.provider);
    const preflight = await provider.stream(
      {
        model,
        system: 'Reply OK.',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Connection check.' }] }],
        tools: [],
        maxOutputTokens: 256,
        thinking: 'off',
      },
      controller.signal,
      () => {},
    );
    assert.equal(preflight.stopReason, 'end', preflight.errorMessage);
    report.preflight = { stopReason: preflight.stopReason, model: preflight.model, usage: preflight.usage };
  }
  const options = {
    cwd: project,
    home,
    config,
    provider,
    prompt: phase === 'start' ? goal : '',
    checkpointSessionId: phase === 'start' ? undefined : report.checkpointSessionId,
    checkCommand: [process.execPath, grader, project, canonical].map(quote).join(' '),
    maxIterations: phase === 'start' ? 1 : 4,
    maxTurns: phase === 'start' ? report.runtime.startMaxTurns : 12,
    protectedPaths: [join(project, 'specs')],
    signal: controller.signal,
  };
  let result;
  if (report.runtime.mode === 'session') {
    const run = await startRun({
      ...options,
      session: phase === 'start' ? undefined : openSession(home, project, report.checkpointSessionId),
      prompt:
        phase === 'start'
          ? goal
          : 'Continue the original task from the compressed session. Implement the remaining modules and verify them; the canonical checker is unchanged.',
    });
    result = {
      ...run,
      sessionIds: [run.session.id],
      checkpointSessionId: run.session.id,
      iterations: 1,
      verification: 'notRun',
    };
    if (phase === 'start') {
      report.beforeCompaction = check();
      report.forcedCompaction = await compactSession({ ...options, session: run.session, prompt: '' });
      assert.equal(report.forcedCompaction, true, 'The real summary must be accepted before restart.');
    }
  } else result = await runRalph(options);
  report.checkpointSessionId = result.checkpointSessionId;
  report.phases.push({
    phase,
    pid: process.pid,
    reason: result.reason,
    verification: result.verification,
    iterations: result.iterations,
    checkpointFile: result.checkpointFile,
  });
  report.final = check();
  assert.deepEqual(await hashes(), report.frozen, 'Grader/canonical assets changed.');
  assert.equal(
    sha(await readFile(join(project, 'specs/forth/canonical-data.json'))),
    sha(await readFile(join(canonical, 'forth/canonical-data.json'))),
  );
  const entries = result.sessionIds.flatMap((id) => openSession(home, project, id).entries());
  report.mechanisms = {
    compactions: entries.filter((entry) => entry.type === 'compaction').length,
    clearings: entries.filter((entry) => entry.type === 'clearing').length,
    structuredSummaries: entries.filter((entry) => entry.type === 'compaction' && entry.continuation).length,
    budgetObservations: entries.filter((entry) => entry.type === 'trace' && entry.data.hook === 'contextBudget').length,
    sessions: result.sessionIds,
  };
  report.status =
    phase === 'start'
      ? 'awaiting-restart'
      : ['passed', 'done', 'maxTurns'].includes(result.reason) && report.final.passed === 93
        ? 'passed'
        : 'incomplete';
  if (phase !== 'start') {
    assert.notEqual(report.processes[0].pid, process.pid, 'A real process restart is required.');
    assert.equal(report.final.passed, 93, 'The unchanged independent canonical checker did not pass.');
    assert.ok(report.mechanisms.compactions > 0, 'No actual compaction occurred.');
  }
  report.updatedAt = new Date().toISOString();
  await save();
  process.stdout.write(
    JSON.stringify({
      status: report.status,
      phase,
      passed: report.final.passed,
      total: report.final.total,
      modelCalls: report.modelCalls,
      httpRequests: report.httpRequests,
      reportedTokens: totalTokens(),
      mechanisms: report.mechanisms,
      reportFile,
    }) + '\n',
  );
} catch (error) {
  if (report) {
    report.status = 'failed';
    report.error = redact(error.stack ?? error);
    await save();
  }
  process.stderr.write(redact(error.stack ?? error) + '\n');
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  globalThis.fetch = actualFetch;
  delete process.env.STEP_ACCEPTANCE_KEY;
  key = '';
}
