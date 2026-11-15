/** Real Step acceptance. Credentials arrive only as stdin JSON {apiKey,resume?}. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, cp, readdir } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { AnthropicProvider, buildAnthropicBody } from '../../src/ai/anthropic.ts';
import { resolveModel } from '../../src/ai/models.ts';
import { defaultConfig } from '../../src/app/config.ts';
import { BackgroundStore } from '../../src/app/background/store.ts';
import { BackgroundWorker } from '../../src/app/background/worker.ts';
import { BackgroundApprovals } from '../../src/app/background/approvals.ts';
import { BackgroundOutbox } from '../../src/app/background/outbox.ts';
import { BackgroundTimers } from '../../src/app/background/timers.ts';
import { realPath, resolvePath } from '../../src/util/paths.ts';
import { dreamJob } from '../../src/app/background/jobs.ts';
import { memoryDir } from '../../src/memory/memory-dir.ts';
import { openSession } from '../../src/session/index.ts';

assert.equal(process.env.MH_LIVE, '1', 'Set MH_LIVE=1 only for an authorized paid acceptance.');
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
let inputText = '';
for await (const part of process.stdin) {
  inputText += String(part);
  assert.ok(inputText.length < 8192);
}
const input = JSON.parse(inputText.trim());
inputText = '';
let stepKey = input.apiKey;
delete input.apiKey;
assert.ok(typeof stepKey === 'string' && stepKey.length >= 8, 'A private stdin credential is required.');
for (const name of Object.keys(process.env))
  if (/(?:key|token|secret|password|credential|auth)/i.test(name)) delete process.env[name];
process.env.NoDefaultCurrentDirectoryInExePath ??= '1';
const limits = { httpRequests: 40, reportedTokens: 60000, durationMs: 600000 };
const redact = (text) => String(text).replaceAll(stepKey, '[credential-redacted]');
const sha = (value) => createHash('sha256').update(value).digest('hex');
let reportFile, report, store, worker, timer;
let clock = Date.now();
const controller = new AbortController();
const originalFetch = globalThis.fetch;
const config = defaultConfig();
config.provider = 'anthropic';
config.model = 'step-5-preview';
config.thinking = 'low';
config.models[config.model] = {
  provider: 'anthropic',
  baseUrl: 'https://api.stepfun.com/step_plan',
  contextWindow: 128000,
  maxOutputTokens: 2048,
  supportsThinking: true,
  supportsImages: false,
};

async function save() {
  await writeFile(reportFile, redact(JSON.stringify(report, null, 2)) + '\n');
}
async function check(name, run) {
  const started = Date.now();
  try {
    const detail = await run();
    report.checks.push({ name, passed: true, durationMs: Date.now() - started, detail });
    await save();
  } catch (error) {
    report.checks.push({ name, passed: false, error: redact(error.stack ?? error) });
    throw error;
  }
}
function reportedTokens() {
  return Object.values(report.usage).reduce((sum, value) => sum + value, 0);
}
function addUsage(usage) {
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite']) {
    const value = usage[key] ?? 0;
    assert.ok(typeof value === 'number' && Number.isFinite(value) && value >= 0, 'Invalid reported usage.');
    report.usage[key] += value;
  }
  assert.ok(reportedTokens() <= limits.reportedTokens, 'Cumulative reported live tokens exceeded the budget.');
}
function actualReadProof(run, status, actual) {
  const entries = openSession(report.home, report.project, run.sessionId).entries();
  const first = entries.findIndex(
    (entry) =>
      entry.type === 'trace' &&
      entry.name === 'runLifecycle' &&
      entry.data.runId === run.id &&
      entry.data.phase === 'started',
  );
  const last = entries.findLastIndex(
    (entry) =>
      entry.type === 'trace' &&
      entry.name === 'runLifecycle' &&
      entry.data.runId === run.id &&
      entry.data.phase === 'completed',
  );
  assert.ok(first >= 0 && last > first, 'The live run has no durable completion boundary.');
  const calls = new Map();
  for (let index = 0; index <= last; index++) {
    const entry = entries[index];
    if (entry.type !== 'message') continue;
    const message = entry.message;
    if (message.role === 'assistant')
      for (const block of message.content) if (block.type === 'toolCall') calls.set(block.id, block);
    if (index <= first || message.role !== 'toolResult' || message.toolName !== 'read' || message.isError) continue;
    const call = calls.get(message.toolCallId);
    if (
      !call ||
      call.name !== 'read' ||
      realPath(resolvePath(report.project, call.args.path)) !== realPath(join(report.project, 'check-result.json'))
    )
      continue;
    const text = message.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .split('\n')
      .map((line) => line.replace(/^\s*\d+\t/, ''))
      .join('\n');
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      continue;
    }
    if (value.status === status && value.expected === 42 && value.actual === actual)
      return { callId: call.id, status, actual, resultHash: sha(text) };
  }
  assert.fail('No actual successful read of the controlled artifact was persisted in this run.');
}
function fixtureCheck(project) {
  const result = spawnSync(process.execPath, ['--test', 'sum.test.cjs'], {
    cwd: project,
    windowsHide: true,
    encoding: 'utf8',
    timeout: 10000,
    env: { ...process.env, MH_HOME: report.home },
  });
  return { exitCode: result.status, output: redact((result.stdout ?? '') + (result.stderr ?? '')).slice(-3000) };
}
async function runOnce() {
  const result = await worker.runOnce(controller.signal);
  report.runs.push({
    id: result?.id,
    taskId: result?.taskId,
    state: result?.state,
    reason: result?.result?.reason,
    usage: result?.result?.usage,
  });
  await save();
  return result;
}
function open() {
  store = new BackgroundStore(report.home, () => clock);
  const base = new AnthropicProvider({ apiKey: stepKey });
  const provider = {
    id: base.id,
    async stream(request, signal, emit) {
      const wire = buildAnthropicBody(request);
      const upperEstimate = Buffer.byteLength(JSON.stringify(wire)) + wire.max_tokens + 1024;
      assert.ok(
        reportedTokens() + upperEstimate <= limits.reportedTokens,
        'Live token reservation exhausted before a new call.',
      );
      report.providerCalls++;
      await save();
      const message = await base.stream(request, signal, emit);
      addUsage(message.usage);
      report.responses.push({
        stopReason: message.stopReason,
        usage: message.usage,
        cache: message.cache,
        requestedModel: request.model.id,
      });
      if (
        message.stopReason === 'error' ||
        message.stopReason === 'aborted' ||
        message.usage.input + message.usage.cacheRead + message.usage.cacheWrite <= 0 ||
        message.usage.output <= 0
      ) {
        report.usageComplete = false;
        await save();
        throw new Error(redact(message.errorMessage || 'Incomplete live response; no further paid requests will run.'));
      }
      await save();
      return message;
    },
  };
  worker = new BackgroundWorker({ store, config, provider, handlers: { dream: dreamJob } });
}
async function close() {
  worker?.close();
  worker = undefined;
  store?.close();
  store = undefined;
}
async function requireDeferred(taskId) {
  const run = await runOnce();
  assert.equal(run.state, 'suspended');
  assert.equal(sha(await readFile(join(report.project, 'sum.js'))), report.beforeHash);
  const request = new BackgroundApprovals(store).list(taskId).find((item) => item.state === 'pending');
  assert.ok(request);
  report.pendingApproval = request.id;
  return { runId: run.id, approvalId: request.id, callHash: request.callHash, fileUnchanged: true };
}
async function supplementalMemory() {
  const task = store.createTask({
    cwd: report.project,
    goal: '整理受控已完成会话中的用户约定',
    kind: 'dream',
    limits: {
      maxRunCalls: 6,
      maxRunTokens: 30000,
      maxTaskCalls: 6,
      maxDayCalls: 6,
      maxDayRuns: 1,
      maxDurationSec: 180,
    },
  });
  store.enqueue({ taskId: task.id, source: 'acceptance-memory', sourceEventId: 'curate-' + task.id, payload: {} });
  const run = await runOnce();
  assert.equal(run.state, 'completed');
  const directory = memoryDir(report.home, report.project),
    index = await readFile(join(directory, 'MEMORY.md'), 'utf8');
  assert.ok(index.trim().length > 0 && Buffer.byteLength(index) <= 25000 && index.split('\n').length <= 200);
  const files = (await readdir(directory, { recursive: true })).filter(
    (file) => file.endsWith('.md') && !file.split(/[\\/]/).includes('.git'),
  );
  const notes = (await Promise.all(files.map((file) => readFile(join(directory, file), 'utf8')))).join('\n');
  assert.ok(notes.includes('BLUE_PAPER_42'), 'The controlled user convention was not retained.');
  report.memoryIndexHash = sha(index);
  report.memoryLive = 'passed';
  store.cancelTask(task.id);
  return {
    runId: run.id,
    indexHash: report.memoryIndexHash,
    data: 'controlled synthetic user convention, not personal memory',
  };
}

try {
  if (input.resume) {
    reportFile = resolve(input.resume);
    report = JSON.parse(await readFile(reportFile, 'utf8'));
    if (report.status === 'passed') {
      process.stdout.write(JSON.stringify({ alreadyCompleted: true, reportFile }) + '\n');
      stepKey = '';
      process.exit(0);
    }
    if (input.memoryOnly) {
      assert.equal(report.status, 'failed');
      assert.equal(
        report.checks.at(-1)?.name,
        'real Step dream curates a controlled user convention from completed sessions',
      );
      assert.ok(report.checks.slice(0, -1).every((item) => item.passed));
      assert.ok(report.providerCalls < limits.httpRequests && reportedTokens() < limits.reportedTokens);
      await cp(reportFile, join(report.output, 'report-memory-failed-' + report.processes.length + '.json'));
      report.attemptHistory = [
        ...(report.attemptHistory ?? []),
        {
          status: report.status,
          checks: report.checks,
          error: report.error,
          httpRequests: report.httpRequests,
          usage: { ...report.usage },
        },
      ];
      report.checks = report.checks.filter((item) => item.passed);
      delete report.error;
      report.status = 'running';
      report.memorySupplement = {
        startedAt: new Date().toISOString(),
        durationMs: 180000,
        reason: 'Repair isolated runner PATH for the already-installed Git; reuse all paid counters.',
      };
    } else if (input.retryProposal) {
      assert.equal(report.status, 'failed');
      assert.equal(report.checks.at(-1)?.name, 'real model defers a mutation before changing the approved file');
      await cp(reportFile, join(report.output, 'report-initial-failed.json'));
      report.attemptHistory = [
        ...(report.attemptHistory ?? []),
        {
          status: report.status,
          checks: report.checks,
          error: report.error,
          httpRequests: report.httpRequests,
          usage: { ...report.usage },
        },
      ];
      report.checks = report.checks.filter((item) => item.passed);
      delete report.error;
      report.status = 'running';
    } else assert.equal(report.status, 'awaiting-restart');
    report.processes.push({
      pid: process.pid,
      phase: input.memoryOnly ? 'memory-supplement' : input.retryProposal ? 'proposal-retry' : 'resume',
    });
  } else {
    const output = join(
      repository,
      '.codex/always-on-checks',
      'step-live-' + new Date().toISOString().replace(/[:.]/g, '-'),
    );
    await mkdir(output, { recursive: true });
    reportFile = join(output, 'report.json');
    const temporary = await mkdtemp(join(tmpdir(), 'mh-always-on-step-')),
      project = join(temporary, 'project');
    await mkdir(project);
    report = {
      v: 1,
      status: 'running',
      startedAt: new Date().toISOString(),
      output,
      temporary,
      project,
      home: join(temporary, 'home'),
      limits,
      model: config.model,
      endpoint: config.models[config.model].baseUrl,
      runtime: process.version,
      providerCalls: 0,
      httpRequests: 0,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      usageComplete: true,
      checks: [],
      responses: [],
      runs: [],
      approvals: [],
      processes: [{ pid: process.pid, phase: 'initial' }],
      fixture: { timersUseInjectedClock: true, modelResponsesAreReal: true, externalChannels: false },
    };
  }
  const remaining = input.memoryOnly ? 180000 : limits.durationMs - (Date.now() - Date.parse(report.startedAt));
  assert.ok(remaining > 0, 'Acceptance deadline expired.');
  timer = setTimeout(() => controller.abort(), remaining);
  timer.unref();
  globalThis.fetch = async (url, options) => {
    assert.equal(
      new URL(url instanceof URL ? url : typeof url === 'string' ? url : url.url).hostname,
      'api.stepfun.com',
      'Live requests must use the authorized Step host.',
    );
    assert.ok(report.httpRequests < limits.httpRequests, 'Live HTTP request limit reached.');
    report.httpRequests++;
    await save();
    return originalFetch(url, options);
  };
  if (input.memoryOnly) {
    open();
    assert.equal(sha(await readFile(join(report.project, 'sum.js'))), report.finalSourceHash);
    assert.equal(sha(await readFile(join(report.project, 'sum.test.cjs'))), report.checkerHash);
    await check('real Step dream curates a controlled user convention from completed sessions', supplementalMemory);
    await close();
    await cp(report.home, join(report.output, 'home'), { recursive: true });
    await cp(report.project, join(report.output, 'project'), { recursive: true });
    report.status = 'passed';
    report.finishedAt = new Date().toISOString();
    await save();
    process.stdout.write(
      JSON.stringify({
        status: report.status,
        reportFile,
        httpRequests: report.httpRequests,
        providerCalls: report.providerCalls,
        reportedTokens: reportedTokens(),
        checks: report.checks.length,
      }) + '\n',
    );
  } else if (input.retryProposal) {
    open();
    assert.equal(sha(await readFile(join(report.project, 'sum.js'))), report.beforeHash);
    assert.equal(new BackgroundApprovals(store).list(report.editTask).length, 0);
    store.enqueue({
      taskId: report.editTask,
      source: 'acceptance-operator',
      sourceEventId: 'clarify-proposal-1',
      payload: {
        message:
          '这是提案，不是批准。请直接调用 edit/write 形成准确工具提案；宿主会在执行前保存并挂起。不要只用文本询问。文件范围和原任务保持不变。',
      },
    });
    await check('real model defers a mutation before changing the approved file', () =>
      requireDeferred(report.editTask),
    );
    report.status = 'awaiting-restart';
    await close();
    await save();
    process.stdout.write(
      JSON.stringify({
        status: report.status,
        reportFile,
        httpRequests: report.httpRequests,
        reportedTokens: reportedTokens(),
      }) + '\n',
    );
  } else if (!input.resume) {
    await check('Step authentication and requested model preflight', async () => {
      const model = resolveModel(config.model, config.models, config.provider);
      const response = await fetch(model.baseUrl + '/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': stepKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: config.model,
          max_tokens: 32,
          messages: [{ role: 'user', content: 'Reply READY.' }],
        }),
        signal: controller.signal,
      });
      assert.equal(response.status, 200, 'Step preflight HTTP ' + response.status);
      const data = await response.json();
      assert.ok(
        typeof data.model === 'string' && data.model.startsWith('step-5'),
        'Step response model is unexpected.',
      );
      addUsage({
        input: data.usage?.input_tokens ?? 0,
        output: data.usage?.output_tokens ?? 0,
        cacheRead: data.usage?.cache_read_input_tokens ?? 0,
        cacheWrite: data.usage?.cache_creation_input_tokens ?? 0,
      });
      report.preflight = { model: data.model, usage: data.usage };
      return report.preflight;
    });
    await writeFile(
      join(report.project, 'check-result.json'),
      JSON.stringify({ status: 'failed', expected: 42, actual: 41 }, null, 2),
    );
    open();
    const task = store.createTask({
      cwd: report.project,
      goal: '只读跟进 check-result.json。每次处理必须重新使用 read 读取此文件，不设置 offset/limit；根据 status、expected、actual 用简短中文报告事实，不修改文件，不执行命令。相同事实无需重复通知。本受控项目的用户约定：报告先写 EXPECTED 再写 ACTUAL，约定标签 BLUE_PAPER_42；这条用户约定没有保存在仓库文件里。',
    });
    report.inspectionTask = task.id;
    store.enqueue({
      taskId: task.id,
      source: 'acceptance-ci',
      sourceEventId: 'first',
      payload: { artifact: 'check-result.json', status: 'failed' },
    });
    await check('real model handles an imported event and delivers its result', async () => {
      const run = await runOnce();
      assert.equal(run.state, 'completed');
      assert.equal(new BackgroundOutbox(store).messages(task.id).length, 1);
      return { runId: run.id, source: 'controlled check artifact', read: actualReadProof(run, 'failed', 41) };
    });
    new BackgroundTimers(store).create({ taskId: task.id, atUtc: clock + 1000 });
    clock += 1001;
    await check('timer follow-up observes unchanged evidence and stays quiet', async () => {
      const run = await runOnce();
      assert.equal(run.state, 'completed');
      const outcomes = new BackgroundOutbox(store).outcomes(task.id);
      assert.equal(outcomes.at(-1).decision, 'quiet');
      assert.equal(new BackgroundOutbox(store).messages(task.id).length, 1);
      return { runId: run.id, decision: 'quiet', read: actualReadProof(run, 'failed', 41) };
    });
    await writeFile(
      join(report.project, 'check-result.json'),
      JSON.stringify({ status: 'passed', expected: 42, actual: 42 }, null, 2),
    );
    store.enqueue({
      taskId: task.id,
      source: 'acceptance-ci',
      sourceEventId: 'changed',
      payload: { artifact: 'check-result.json', status: 'passed' },
    });
    await check('changed CI evidence generates a new notification', async () => {
      const run = await runOnce();
      assert.equal(run.state, 'completed');
      assert.equal(new BackgroundOutbox(store).messages(task.id).length, 2);
      return { runId: run.id, messages: 2, read: actualReadProof(run, 'passed', 42) };
    });
    store.cancelTask(task.id);
    await writeFile(join(report.project, 'sum.js'), 'exports.sum = (a, b) => a + b - 1;\n');
    await writeFile(
      join(report.project, 'sum.test.cjs'),
      "const test=require('node:test');const assert=require('node:assert/strict');test('sum is 42',()=>assert.equal(require('./sum.js').sum(19,23),42));\n",
    );
    report.checkerHash = sha(await readFile(join(report.project, 'sum.test.cjs')));
    report.beforeHash = sha(await readFile(join(report.project, 'sum.js')));
    report.initialCheck = fixtureCheck(report.project);
    assert.notEqual(report.initialCheck.exitCode, 0, 'The fixture must initially fail.');
    const edit = store.createTask({
      cwd: report.project,
      goal: '读取 sum.js 和 sum.test.cjs，修复 sum.js 中的 sum，使 sum(19,23) 等于42，保持 CommonJS 的 exports.sum。只修改这一行纯加法逻辑，不引入依赖、导入、动态执行或其他行为。检查由验收器独立运行，不要调用 bash。提出 edit/write 工具调用并等待准确审批，批准后完成修改并读回确认。',
      editablePaths: ['sum.js'],
    });
    report.editTask = edit.id;
    store.enqueue({
      taskId: edit.id,
      source: 'acceptance-edit',
      sourceEventId: 'fix',
      payload: { failingCheck: report.initialCheck.output },
    });
    await check('real model defers a mutation before changing the approved file', () => requireDeferred(edit.id));
    report.status = 'awaiting-restart';
    await close();
    await save();
    process.stdout.write(
      JSON.stringify({
        status: report.status,
        reportFile,
        httpRequests: report.httpRequests,
        reportedTokens: reportedTokens(),
      }) + '\n',
    );
  } else {
    open();
    await check('approval survives a real acceptance process restart', async () => {
      assert.notEqual(report.processes[0].pid, process.pid);
      const item = new BackgroundApprovals(store).get(report.pendingApproval);
      assert.equal(item.state, 'pending');
      assert.equal(sha(await readFile(join(report.project, 'sum.js'))), report.beforeHash);
      return { approvalId: item.id, processesDiffer: true, fileUnchanged: true };
    });
    let passed = false;
    for (let round = 0; round < 3 && !passed; round++) {
      for (let approval = 0; approval < 3; approval++) {
        const pending = new BackgroundApprovals(store).list(report.editTask).find((item) => item.state === 'pending');
        if (pending) {
          const call = pending.batch.calls[pending.batch.nextCallIndex];
          assert.ok(['write', 'edit'].includes(call.name));
          assert.equal(realPath(resolvePath(report.project, call.args.path)), realPath(join(report.project, 'sum.js')));
          new BackgroundApprovals(store).respond(pending.id, 'allow');
          assert.throws(() => new BackgroundApprovals(store).respond(pending.id, 'allow'));
          report.approvals.push({ id: pending.id, callHash: pending.callHash, target: 'sum.js' });
        }
        const run = await runOnce();
        assert.ok(run);
        if (run.state === 'completed') break;
        assert.equal(run.state, 'suspended');
      }
      assert.equal(
        sha(await readFile(join(report.project, 'sum.test.cjs'))),
        report.checkerHash,
        'The independent checker changed.',
      );
      const code = await readFile(join(report.project, 'sum.js'), 'utf8');
      assert.ok(
        !/\b(?:require|import|process|fetch|globalThis|eval|Function|constructor)\b/.test(code),
        'The fixture only authorizes a plain arithmetic export.',
      );
      report.finalCheck = fixtureCheck(report.project);
      passed = report.finalCheck.exitCode === 0;
      if (!passed)
        store.enqueue({
          taskId: report.editTask,
          source: 'acceptance-check',
          sourceEventId: 'retry-' + round,
          payload: { checkExitCode: report.finalCheck.exitCode, output: report.finalCheck.output },
        });
    }
    await check('resumed Step mutation passes the unchanged independent Node test', async () => {
      assert.equal(passed, true, report.finalCheck.output);
      return { ...report.finalCheck, checkerHash: report.checkerHash, approvals: report.approvals.length };
    });
    const beforeCalls = report.providerCalls;
    assert.equal(await worker.runOnce(controller.signal), undefined);
    assert.equal(report.providerCalls, beforeCalls);
    await check('an empty inbox neither replays tools nor calls the model', async () => ({
      additionalProviderCalls: report.providerCalls - beforeCalls,
    }));
    report.finalSourceHash = sha(await readFile(join(report.project, 'sum.js')));
    store.cancelTask(report.editTask);
    if (limits.reportedTokens - reportedTokens() >= 22000) {
      await check('real Step dream curates a controlled user convention from completed sessions', async () => {
        const task = store.createTask({
          cwd: report.project,
          goal: '整理受控已完成会话中的用户约定',
          kind: 'dream',
          limits: {
            maxRunCalls: 6,
            maxRunTokens: 30000,
            maxTaskCalls: 6,
            maxDayCalls: 6,
            maxDayRuns: 1,
            maxDurationSec: 180,
          },
        });
        store.enqueue({
          taskId: task.id,
          source: 'acceptance-memory',
          sourceEventId: 'curate-' + task.id,
          payload: {},
        });
        const run = await runOnce();
        assert.equal(run.state, 'completed');
        const directory = memoryDir(report.home, report.project),
          index = await readFile(join(directory, 'MEMORY.md'), 'utf8');
        assert.ok(index.trim().length > 0 && Buffer.byteLength(index) <= 25000 && index.split('\n').length <= 200);
        const noteFiles = (await readdir(directory, { recursive: true })).filter(
          (file) => file.endsWith('.md') && !file.split(/[\\/]/).includes('.git'),
        );
        const notes = (await Promise.all(noteFiles.map((file) => readFile(join(directory, file), 'utf8')))).join('\n');
        assert.ok(notes.includes('BLUE_PAPER_42'), 'The controlled user convention was not retained.');
        report.memoryIndexHash = sha(index);
        report.memoryLive = 'passed';
        store.cancelTask(task.id);
        return {
          runId: run.id,
          indexHash: report.memoryIndexHash,
          data: 'controlled synthetic user convention, not personal memory',
        };
      });
    } else report.memoryLive = 'notRunWithinInitialBudget';
    await close();
    await cp(report.home, join(report.output, 'home'), { recursive: true });
    await cp(report.project, join(report.output, 'project'), { recursive: true });
    report.status = 'passed';
    report.finishedAt = new Date().toISOString();
    await save();
    process.stdout.write(
      JSON.stringify({
        status: report.status,
        reportFile,
        httpRequests: report.httpRequests,
        providerCalls: report.providerCalls,
        reportedTokens: reportedTokens(),
        checks: report.checks.length,
      }) + '\n',
    );
  }
} catch (error) {
  if (report) {
    report.status = 'failed';
    report.error = redact(error.stack ?? error);
    report.finishedAt = new Date().toISOString();
    await save().catch(() => {});
  }
  process.stderr.write(redact(error.stack ?? error) + '\n');
  process.exitCode = 1;
} finally {
  await close().catch(() => {});
  clearTimeout(timer);
  globalThis.fetch = originalFetch;
  stepKey = '';
}
