import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';
import type { ModelRequest, Provider, StreamEvent } from '../../src/ai/index.ts';
import { openSession } from '../../src/session/index.ts';
import { scripted } from '../../test/helpers/fake-provider.ts';
import type { Connection, Snapshot } from '../contracts.ts';
import { DesktopController, type DesktopControllerOptions } from '../host/controller.ts';
import { readConnections, writeConnections } from '../host/credentials.ts';

const promptsDir = fileURLToPath(new URL('../../prompts/', import.meta.url));
for (const name of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']) delete process.env[name];
const baseConnection: Connection = {
  id: 'test-connection',
  name: '本地替身连接',
  provider: 'anthropic',
  model: 'fake-model',
  supportsThinking: true,
  supportsImages: false,
  contextWindow: 128000,
  maxOutputTokens: 8192,
};

function fixture(
  t: TestContext,
  factory: DesktopControllerOptions['providerFactory'] = () => scripted({ text: '完成' }),
  environment: Record<string, string> = {},
  storedConnections?: Connection[],
) {
  const root = mkdtempSync(join(tmpdir(), 'mh-desktop-test-'));
  const home = join(root, 'home'),
    project = join(root, '项目 with space');
  mkdirSync(home);
  mkdirSync(project);
  if (storedConnections) writeFileSync(join(home, 'desktop-connections.json'), JSON.stringify(storedConnections));
  const snapshots: Snapshot[] = [];
  const controller = new DesktopController({
    home,
    promptsDir,
    onSnapshot: (snapshot) => snapshots.push(snapshot),
    providerFactory: factory,
    credentialEnvironment: environment,
  });
  process.env.MH_HOME = home;
  t.after(async () => {
    await controller.handle({ method: 'shutdown' });
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(root.startsWith(join(tmpdir(), 'mh-desktop-test-')));
    rmSync(root, { recursive: true, force: true });
  });
  return { root, home, project, snapshots, controller };
}
async function configured(f: ReturnType<typeof fixture>, connection: Connection = baseConnection) {
  await f.controller.handle({ method: 'saveConnection', connection, apiKey: 'private-desktop-test-key' });
  const opened = await f.controller.handle({ method: 'openProject', path: f.project });
  return opened.project!.id;
}
async function until(
  controller: DesktopController,
  predicate: (snapshot: Snapshot) => boolean,
  timeout = 15000,
): Promise<Snapshot> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const snapshot = await controller.handle({ method: 'snapshot' });
    if (predicate(snapshot)) return snapshot;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error('Timed out waiting for desktop state.');
}
const ended = (snapshot: Snapshot) =>
  !!snapshot.run && ['completed', 'cancelled', 'failed'].includes(snapshot.run.status);
const start = (controller: DesktopController, projectId: string, sessionId?: string) =>
  controller.handle({
    method: 'startRun',
    input: { projectId, sessionId, prompt: '完成这个本地任务', modelId: baseConnection.id, thinking: 'high' },
  });

test('connections persist metadata only, require credentials, and reject invalid folders', async (t) => {
  const f = fixture(t);
  assert.deepEqual((await f.controller.handle({ method: 'snapshot' })).models, []);
  await f.controller.handle({ method: 'saveConnection', connection: baseConnection });
  assert.equal((await f.controller.handle({ method: 'snapshot' })).models[0]!.credentialReady, false);
  const project = await f.controller.handle({ method: 'openProject', path: f.project });
  await assert.rejects(start(f.controller, project.project!.id), /密钥/);
  await assert.rejects(f.controller.handle({ method: 'openProject', path: join(f.root, 'missing') }), /文件夹/);
  await configured(f);
  const saved = readFileSync(join(f.home, 'desktop-connections.json'), 'utf8');
  assert.ok(!saved.includes('private-desktop-test-key'));
  assert.ok(!JSON.stringify(f.snapshots).includes('private-desktop-test-key'));
  const reopened = new DesktopController({ home: f.home, promptsDir, onSnapshot() {} });
  assert.equal((await reopened.handle({ method: 'snapshot' })).models[0]!.credentialReady, false);
  await reopened.handle({ method: 'shutdown' });
  await assert.rejects(
    f.controller.handle({ method: 'saveConnection', connection: { ...baseConnection, apiKeyEnv: 'PATH' } }),
    /环境变量/,
  );
});

test('real write/read tools stream events, normalize unsupported thinking and recover JSONL messages', async (t) => {
  const provider = scripted(
    {
      text: '先写入再读取。',
      toolCalls: [
        { name: 'write', args: { path: '中文.txt', content: '实际工具内容' } },
        { name: 'read', args: { path: '中文.txt' } },
      ],
    },
    { text: '文件已经实际写入并读取。' },
  );
  const streamed: Provider = {
    id: 'anthropic',
    async stream(request, signal, emit) {
      const events: StreamEvent[] = [];
      const message = await provider.stream(request, signal, (event) => events.push(event));
      for (const event of events) {
        emit(event);
        await new Promise((resolveChunk) => setTimeout(resolveChunk, 12));
      }
      return message;
    },
  };
  const f = fixture(t, () => streamed);
  const projectId = await configured(f, { ...baseConnection, supportsThinking: false });
  const launched = await start(f.controller, projectId);
  assert.equal(launched.run!.thinking, 'off');
  const result = await until(f.controller, ended);
  assert.equal(result.run!.status, 'completed');
  assert.equal(result.run!.verification, 'notConfigured');
  assert.equal(readFileSync(join(f.project, '中文.txt'), 'utf8'), '实际工具内容');
  assert.deepEqual(
    result.activities.map((activity) => activity.status),
    ['completed', 'completed'],
  );
  assert.ok(f.snapshots.some((snapshot) => snapshot.streamingText.includes('写入')));
  assert.ok(f.snapshots.every((snapshot, index) => index === 0 || snapshot.seq > f.snapshots[index - 1]!.seq));
  assert.equal(provider.requests[0]!.thinking, 'off');
  const sessionId = result.selectedSessionId!;
  await f.controller.handle({ method: 'newSession', projectId });
  const restored = await f.controller.handle({ method: 'openSession', projectId, sessionId });
  assert.ok(restored.messages.some((message) => message.text.includes('实际写入')));
  assert.equal(restored.run!.verification, 'notConfigured');
  assert.equal(restored.activities.length, 0);
  assert.ok(restored.sessions.some((item) => item.id === sessionId));
});

test('busy project/session switches are rejected and cancel waits for real shell cleanup', async (t) => {
  const f = fixture(t, () =>
    scripted({
      toolCalls: [
        { name: 'bash', args: { command: 'node -e "process.stdout.write(\'started\');setTimeout(()=>{},30000)"' } },
      ],
    }),
  );
  const projectId = await configured(f);
  const launched = await start(f.controller, projectId);
  const runId = launched.run!.id;
  await until(f.controller, (snapshot) => snapshot.activities.some((activity) => activity.output.includes('started')));
  await assert.rejects(f.controller.handle({ method: 'openProject', path: f.project }), /运行/);
  await assert.rejects(f.controller.handle({ method: 'newSession', projectId }), /运行/);
  await assert.rejects(
    f.controller.handle({ method: 'openSession', projectId, sessionId: launched.selectedSessionId! }),
    /运行/,
  );
  await assert.rejects(start(f.controller, projectId), /运行/);
  const cancelled = await f.controller.handle({ method: 'cancel', runId });
  assert.equal(cancelled.run!.status, 'cancelled');
  assert.ok(f.snapshots.some((snapshot) => snapshot.run?.status === 'cancelling'));
  assert.ok(cancelled.activities.every((activity) => activity.status !== 'running'));
  assert.equal((await f.controller.handle({ method: 'cancel', runId })).run!.status, 'cancelled');
});

test('approval identity is bound to its run, cancellation denies pending work and old approvals cannot be reused', async (t) => {
  const f = fixture(t, () =>
    scripted(
      { toolCalls: [{ name: 'write', args: { path: join(f.root, 'outside.txt'), content: 'must not write' } }] },
      { text: '已收到拒绝。' },
    ),
  );
  const projectId = await configured(f);
  const first = await start(f.controller, projectId);
  const waiting = await until(f.controller, (snapshot) => snapshot.approvals.length === 1);
  const approvalId = waiting.approvals[0]!.id;
  await assert.rejects(
    f.controller.handle({ method: 'approve', runId: 'wrong-run', approvalId, decision: 'once' }),
    /运行 ID/,
  );
  await f.controller.handle({ method: 'cancel', runId: first.run!.id });
  assert.equal(existsSync(join(f.root, 'outside.txt')), false);
  const second = await start(f.controller, projectId, first.selectedSessionId);
  const next = await until(f.controller, (snapshot) => snapshot.approvals.length === 1);
  await assert.rejects(
    f.controller.handle({ method: 'approve', runId: second.run!.id, approvalId, decision: 'once' }),
    /审批/,
  );
  await f.controller.handle({
    method: 'approve',
    runId: second.run!.id,
    approvalId: next.approvals[0]!.id,
    decision: 'deny',
  });
  const result = await until(f.controller, ended);
  assert.equal(result.run!.status, 'completed');
  assert.equal(result.run!.verification, 'notConfigured');
  assert.equal(existsSync(join(f.root, 'outside.txt')), false);
});

test('steering keeps the active configuration and private credential snapshot', async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((resolveGate) => {
    release = resolveGate;
  });
  const scriptedProvider = scripted({ text: '第一轮回复。' }, { text: '补充要求已经消费。' });
  let calls = 0;
  const provider: Provider = {
    id: 'anthropic',
    async stream(request, signal, emit) {
      if (!calls++)
        await Promise.race([
          gate,
          new Promise<void>((resolveAbort) => signal.addEventListener('abort', () => resolveAbort(), { once: true })),
        ]);
      return scriptedProvider.stream(request, signal, emit);
    },
  };
  let credential = '';
  const f = fixture(t, (_connection, key) => {
    credential = key.apiKey!;
    return provider;
  });
  const projectId = await configured(f);
  const launched = await start(f.controller, projectId);
  await f.controller.handle({
    method: 'saveConnection',
    connection: { ...baseConnection, model: 'next-model', name: '下一轮连接' },
    apiKey: 'next-private-key',
  });
  await f.controller.handle({ method: 'steer', runId: launched.run!.id, text: '追加一个真实上下文要求' });
  release();
  const finished = await until(f.controller, ended);
  assert.equal(credential, 'private-desktop-test-key');
  assert.ok(
    scriptedProvider.requests.every((request) => request.model.id === 'fake-model' && request.thinking === 'high'),
  );
  assert.ok(
    scriptedProvider.requests[1]!.messages.some(
      (message) => message.role === 'user' && JSON.stringify(message.content).includes('追加一个真实上下文要求'),
    ),
  );
  assert.equal(finished.run!.modelName, '本地替身连接');
});

test('project hook denial ignores checks, once approval runs checks only once and never persists trust', async (t) => {
  const f = fixture(t);
  mkdirSync(join(f.project, '.mh'));
  writeFileSync(
    join(f.project, '.mh', 'config.json'),
    JSON.stringify({
      hooks: { onStop: [{ command: "node -e \"require('node:fs').writeFileSync('hook-ran.txt','yes')\"" }] },
    }),
  );
  const projectId = await configured(f);
  const first = await start(f.controller, projectId);
  let approval = (await until(f.controller, (snapshot) => snapshot.approvals.length === 1)).approvals[0]!;
  await f.controller.handle({ method: 'approve', runId: first.run!.id, approvalId: approval.id, decision: 'deny' });
  assert.equal((await until(f.controller, ended)).run!.verification, 'notConfigured');
  assert.equal(existsSync(join(f.project, 'hook-ran.txt')), false);
  const second = await start(f.controller, projectId, first.selectedSessionId);
  approval = (await until(f.controller, (snapshot) => snapshot.approvals.length === 1)).approvals[0]!;
  await f.controller.handle({ method: 'approve', runId: second.run!.id, approvalId: approval.id, decision: 'once' });
  assert.equal((await until(f.controller, ended)).run!.verification, 'passed');
  assert.equal(readFileSync(join(f.project, 'hook-ran.txt'), 'utf8'), 'yes');
  assert.equal(existsSync(join(f.home, 'trusted.json')), false);
  unlinkSync(join(f.project, 'hook-ran.txt'));
  const third = await start(f.controller, projectId, first.selectedSessionId);
  await until(f.controller, (snapshot) => snapshot.approvals.length === 1);
  await f.controller.handle({ method: 'cancel', runId: third.run!.id });
  assert.equal(existsSync(join(f.project, 'hook-ran.txt')), false);
});

test('done with exhausted checks is failed verification, while cancelled checks remain incomplete', async (t) => {
  const f = fixture(t);
  writeFileSync(
    join(f.home, 'config.json'),
    JSON.stringify({ hooks: { onStop: [{ command: 'node -e "process.exit(1)"' }], maxStopContinuations: 0 } }),
  );
  const projectId = await configured(f);
  await start(f.controller, projectId);
  const failedChecks = await until(f.controller, ended);
  assert.equal(failedChecks.run!.status, 'completed');
  assert.equal(failedChecks.run!.verification, 'failed');
  writeFileSync(
    join(f.home, 'config.json'),
    JSON.stringify({
      hooks: {
        onStop: [
          { command: "node -e \"require('node:fs').writeFileSync('checking.txt','yes');setTimeout(()=>{},30000)\"" },
        ],
        maxStopContinuations: 0,
      },
    }),
  );
  const checking = await start(f.controller, projectId);
  await until(f.controller, () => existsSync(join(f.project, 'checking.txt')));
  const cancelled = await f.controller.handle({ method: 'cancel', runId: checking.run!.id });
  assert.equal(cancelled.run!.status, 'cancelled');
  assert.equal(cancelled.run!.verification, 'incomplete');
});

test('custom environment credentials are captured privately and cannot reach real tool subprocesses', async (t) => {
  const name = 'MH_DESKTOP_CUSTOM_PROVIDER_KEY';
  process.env[name] = 'custom-private-environment-key';
  let privateKey = '';
  const f = fixture(t, (_connection, credential) => {
    privateKey = credential.apiKey!;
    return scripted(
      {
        toolCalls: [
          {
            name: 'bash',
            args: {
              command:
                "node -e \"require('node:fs').writeFileSync('tool-env.json',JSON.stringify({key:process.env.MH_DESKTOP_CUSTOM_PROVIDER_KEY,standard:process.env.ANTHROPIC_API_KEY}))\"",
            },
          },
        ],
      },
      { text: '已检查环境。' },
    );
  });
  t.after(() => {
    delete process.env[name];
  });
  await f.controller.handle({ method: 'saveConnection', connection: { ...baseConnection, apiKeyEnv: name } });
  const project = await f.controller.handle({ method: 'openProject', path: f.project });
  assert.equal(process.env[name], undefined);
  assert.equal(project.models[0]!.credentialReady, true);
  await start(f.controller, project.project!.id);
  await until(f.controller, ended);
  assert.equal(privateKey, 'custom-private-environment-key');
  assert.deepEqual(JSON.parse(readFileSync(join(f.project, 'tool-env.json'), 'utf8')), {});
  assert.ok(!JSON.stringify(f.snapshots).includes(privateKey));
  assert.ok(!readFileSync(join(f.home, 'desktop-connections.json'), 'utf8').includes(privateKey));
});

test('project model definitions merge and read-only review includes staged and untracked names', async (t) => {
  const f = fixture(t);
  mkdirSync(join(f.project, '.mh'));
  writeFileSync(
    join(f.project, '.mh', 'config.json'),
    JSON.stringify({
      provider: 'openai',
      model: 'configured-model',
      models: { 'configured-model': { supportsThinking: false, baseUrl: 'http://127.0.0.1:34567/v1' } },
    }),
  );
  const projectId = await configured(f);
  const snapshot = await f.controller.handle({ method: 'snapshot' });
  const imported = snapshot.models.find((model) => model.source === 'project')!;
  assert.equal(imported.model, 'configured-model');
  assert.equal(imported.provider, 'openai');
  assert.equal(imported.baseUrl, 'http://127.0.0.1:34567/v1');
  assert.equal(imported.credentialReady, false);
  execFileSync('git', ['init', '-q', f.project], { windowsHide: true });
  writeFileSync(join(f.project, 'staged.txt'), 'staged change');
  execFileSync('git', ['-C', f.project, 'add', 'staged.txt'], { windowsHide: true });
  writeFileSync(join(f.project, 'untracked.txt'), 'untracked content');
  const reviewed = await f.controller.handle({ method: 'review', projectId });
  assert.equal(reviewed.review!.available, true);
  assert.equal(reviewed.review!.scope, 'workingTree');
  assert.ok(reviewed.review!.summary.includes('untracked.txt'));
  assert.ok(reviewed.review!.diff.includes('staged change'));
  assert.ok(readdirSync(f.project).includes('untracked.txt'));
});

test('private bootstrap environment supports custom key references and Anthropic Bearer without persisting either', async (t) => {
  const seen: { apiKey?: string; authToken?: string }[] = [];
  const f = fixture(
    t,
    (_connection, credential) => {
      seen.push(credential);
      return scripted({ text: '完成' });
    },
    {
      CUSTOM_PROVIDER_REFERENCE: 'bootstrap-custom-private-key',
      ANTHROPIC_AUTH_TOKEN: 'bootstrap-bearer-private-token',
    },
  );
  await f.controller.handle({
    method: 'saveConnection',
    connection: { ...baseConnection, apiKeyEnv: 'CUSTOM_PROVIDER_REFERENCE' },
  });
  const project = await f.controller.handle({ method: 'openProject', path: f.project });
  assert.equal(project.models[0]!.credentialReady, true);
  await start(f.controller, project.project!.id);
  await until(f.controller, ended);
  assert.deepEqual(seen[0], { apiKey: 'bootstrap-custom-private-key' });
  await f.controller.handle({ method: 'saveConnection', connection: baseConnection });
  await start(f.controller, project.project!.id);
  await until(f.controller, ended);
  assert.deepEqual(seen[1], { authToken: 'bootstrap-bearer-private-token' });
  assert.equal(process.env.ANTHROPIC_AUTH_TOKEN, undefined);
  const persisted = readFileSync(join(f.home, 'desktop-connections.json'), 'utf8');
  assert.ok(
    !persisted.includes('bootstrap-custom-private-key') && !persisted.includes('bootstrap-bearer-private-token'),
  );
  assert.ok(!JSON.stringify(f.snapshots).includes('bootstrap-bearer-private-token'));
});

test('session hook approval caches only the exact hook fingerprint for the same open session', async (t) => {
  const f = fixture(t);
  mkdirSync(join(f.project, '.mh'));
  const file = join(f.project, '.mh', 'config.json');
  writeFileSync(file, JSON.stringify({ hooks: { onStop: [{ command: 'node -e "process.exit(0)"' }] } }));
  const projectId = await configured(f);
  const first = await start(f.controller, projectId);
  const approval = (await until(f.controller, (snapshot) => snapshot.approvals.length === 1)).approvals[0]!;
  await f.controller.handle({ method: 'approve', runId: first.run!.id, approvalId: approval.id, decision: 'session' });
  await until(f.controller, ended);
  const priorApprovals = f.snapshots.filter((snapshot) => snapshot.approvals.length).length;
  await start(f.controller, projectId, first.selectedSessionId);
  const second = await until(f.controller, ended);
  assert.equal(second.run!.verification, 'passed');
  assert.equal(f.snapshots.filter((snapshot) => snapshot.approvals.length).length, priorApprovals);
  writeFileSync(file, JSON.stringify({ hooks: { onStop: [{ command: 'node -e "process.exit(1)"' }] } }));
  const changed = await start(f.controller, projectId, first.selectedSessionId);
  await until(f.controller, (snapshot) => snapshot.approvals.length === 1);
  await f.controller.handle({ method: 'cancel', runId: changed.run!.id });
  assert.equal(existsSync(join(f.home, 'trusted.json')), false);
});

test('a later interrupted CLI input does not restore an older desktop success as the latest run', async (t) => {
  const f = fixture(t);
  const projectId = await configured(f);
  await start(f.controller, projectId);
  const completed = await until(f.controller, ended);
  const session = openSession(f.home, f.project, completed.selectedSessionId!);
  session.append({
    type: 'message',
    message: { role: 'user', content: [{ type: 'text', text: 'CLI 下一轮刚开始便退出' }] },
  });
  const restored = await f.controller.handle({ method: 'openSession', projectId, sessionId: session.id });
  assert.equal(restored.run, undefined);
  assert.ok(restored.warning?.includes('没有完整结束记录'));
});

test('desktop connections never inherit a same-name project gateway, key reference or compatibility flags', async (t) => {
  const requests: ModelRequest[] = [];
  const f = fixture(
    t,
    () =>
      scripted((request) => {
        requests.push(structuredClone(request));
        return { text: '完成' };
      }),
    {
      PROJECT_GATEWAY_KEY: 'project-gateway-private-key',
    },
  );
  mkdirSync(join(f.project, '.mh'));
  const gateway = {
    baseUrl: 'http://127.0.0.1:34567/project-gateway',
    apiKeyEnv: 'PROJECT_GATEWAY_KEY',
    compat: { includeEncryptedReasoning: false, promptCache: false },
  };
  writeFileSync(
    join(f.project, '.mh', 'config.json'),
    JSON.stringify({
      provider: 'openai',
      model: baseConnection.model,
      models: { [baseConnection.model]: gateway },
    }),
  );
  const projectId = await configured(f);
  await start(f.controller, projectId);
  await until(f.controller, ended);
  assert.equal(requests[0]!.model.baseUrl, undefined);
  assert.equal(requests[0]!.model.apiKeyEnv, undefined);
  assert.equal(requests[0]!.model.compat, undefined);
  const imported = (await f.controller.handle({ method: 'snapshot' })).models.find(
    (model) => model.source === 'project',
  )!;
  await f.controller.handle({
    method: 'startRun',
    input: { projectId, prompt: '使用项目连接', modelId: imported.id, thinking: 'off' },
  });
  await until(f.controller, ended);
  assert.equal(requests[1]!.model.baseUrl, gateway.baseUrl);
  assert.equal(requests[1]!.model.apiKeyEnv, gateway.apiKeyEnv);
  assert.deepEqual(requests[1]!.model.compat, gateway.compat);
});

test('editing an imported project connection replaces its ID rather than duplicating model options', async (t) => {
  const f = fixture(t);
  mkdirSync(join(f.project, '.mh'));
  writeFileSync(join(f.project, '.mh', 'config.json'), JSON.stringify({ provider: 'openai', model: 'same-model' }));
  await configured(f);
  const imported = (await f.controller.handle({ method: 'snapshot' })).models.find(
    (model) => model.source === 'project',
  )!;
  const { source: _source, credentialReady: _ready, ...connection } = imported;
  const saved = await f.controller.handle({
    method: 'saveConnection',
    connection: { ...connection, name: '编辑后的连接' },
    apiKey: 'edited-private-key',
  });
  const matches = saved.models.filter((model) => model.id === imported.id);
  assert.equal(matches.length, 1);
  assert.equal(matches[0]!.source, 'desktop');
  assert.equal(matches[0]!.name, '编辑后的连接');
});

test('an explicit OpenAI key reference never falls back to the default key but an injected key wins', async (t) => {
  const credentials: { apiKey?: string; authToken?: string }[] = [];
  const f = fixture(
    t,
    (_connection, credential) => {
      credentials.push(credential);
      return scripted({ text: '完成' });
    },
    {
      OPENAI_API_KEY: 'default-openai-private-key',
      ANTHROPIC_API_KEY: 'default-anthropic-private-key',
    },
  );
  const openai: Connection = {
    ...baseConnection,
    provider: 'openai',
    apiKeyEnv: 'MISSING_EXPLICIT_PROVIDER_REFERENCE',
  };
  await f.controller.handle({ method: 'saveConnection', connection: openai });
  const project = await f.controller.handle({ method: 'openProject', path: f.project });
  assert.equal(project.models[0]!.credentialReady, false);
  await assert.rejects(start(f.controller, project.project!.id), /密钥/);
  assert.equal(credentials.length, 0);
  await f.controller.handle({ method: 'saveConnection', connection: openai, apiKey: 'explicit-openai-private-key' });
  await start(f.controller, project.project!.id);
  await until(f.controller, ended);
  assert.deepEqual(credentials[0], { apiKey: 'explicit-openai-private-key' });
  await f.controller.handle({
    method: 'saveConnection',
    connection: { ...baseConnection, apiKeyEnv: 'MISSING_EXPLICIT_PROVIDER_REFERENCE' },
  });
  // This is the existing Anthropic environment chain, tested in a new connection without a private override.
  const anthropic = await f.controller.handle({
    method: 'saveConnection',
    connection: { ...baseConnection, id: 'anthropic-env-chain', apiKeyEnv: 'MISSING_EXPLICIT_PROVIDER_REFERENCE' },
  });
  assert.equal(anthropic.models.find((model) => model.id === 'anthropic-env-chain')!.credentialReady, true);
});

test('project connection identities bind project and endpoint, so an override cannot pollute another project', async (t) => {
  const f = fixture(t);
  const secondPath = join(f.root, 'second-project');
  mkdirSync(join(f.project, '.mh'));
  mkdirSync(join(secondPath, '.mh'), { recursive: true });
  const writeProject = (path: string, baseUrl: string) =>
    writeFileSync(
      join(path, '.mh', 'config.json'),
      JSON.stringify({
        provider: 'openai',
        model: 'shared-model',
        models: { 'shared-model': { baseUrl, apiKeyEnv: 'SAME_ENV_REFERENCE' } },
      }),
    );
  writeProject(f.project, 'http://127.0.0.1:34567/project-a');
  writeProject(secondPath, 'http://127.0.0.1:34568/project-b');
  await configured(f);
  const first = (await f.controller.handle({ method: 'snapshot' })).models.find((model) => model.source === 'project')!;
  const { source: _source, credentialReady: _ready, ...connection } = first;
  await f.controller.handle({
    method: 'saveConnection',
    connection: { ...connection, name: 'Project A override' },
    apiKey: 'project-a-private-key',
  });
  const second = await f.controller.handle({ method: 'openProject', path: secondPath });
  const imported = second.models.find((model) => model.source === 'project')!;
  assert.notEqual(imported.id, first.id);
  assert.equal(imported.baseUrl, 'http://127.0.0.1:34568/project-b');
  assert.equal(imported.credentialReady, false);
  assert.ok(!first.id.includes('127.0.0.1') && !first.id.includes('SAME_ENV_REFERENCE'));
  writeProject(secondPath, 'http://127.0.0.1:34569/project-b-new');
  const changed = await f.controller.handle({ method: 'openProject', path: secondPath });
  assert.notEqual(changed.models.find((model) => model.source === 'project')!.id, imported.id);
});

test('invalid connection field values are rejected without being persisted or echoed in errors', async (t) => {
  const f = fixture(t);
  await configured(f);
  const metadataPath = join(f.home, 'desktop-connections.json');
  const before = readFileSync(metadataPath, 'utf8');
  const url = 'https://api.example.invalid/v1/messages';
  await assert.rejects(
    f.controller.handle({ method: 'saveConnection', connection: { ...baseConnection, model: url } }),
    (error: Error) => /模型 ID.*Base URL/.test(error.message) && !error.message.includes(url),
  );
  const secret = 'sk-fake-key-entered-into-env-name-123';
  await assert.rejects(
    f.controller.handle({ method: 'saveConnection', connection: { ...baseConnection, apiKeyEnv: secret } }),
    (error: Error) =>
      error.message.includes('STEP_API_KEY') && error.message.includes('API Key') && !error.message.includes(secret),
  );
  assert.equal(readFileSync(metadataPath, 'utf8'), before);
});

test('legacy URL model metadata can be opened for repair but is not ready or runnable until corrected', async (t) => {
  let calls = 0;
  const environmentName = 'LEGACY_CUSTOM_PROVIDER_REFERENCE';
  process.env[environmentName] = 'legacy-private-only-test-key';
  t.after(() => {
    delete process.env[environmentName];
  });
  const legacy = { ...baseConnection, model: 'https://api.example.invalid/v1/messages', apiKeyEnv: environmentName };
  const f = fixture(
    t,
    () => {
      calls++;
      return scripted({ text: '修正后的连接正常运行。' });
    },
    {
      ANTHROPIC_API_KEY: 'legacy-fake-private-api-key',
    },
    [legacy],
  );
  const snapshot = await f.controller.handle({ method: 'snapshot' });
  assert.equal(process.env[environmentName], undefined);
  assert.equal(snapshot.models[0]!.credentialReady, false);
  assert.ok(snapshot.models[0]!.configurationIssue?.includes('模型 ID'));
  const project = await f.controller.handle({ method: 'openProject', path: f.project });
  await assert.rejects(start(f.controller, project.project!.id), /模型 ID.*Base URL/);
  assert.equal(calls, 0);
  const fixed = await f.controller.handle({
    method: 'saveConnection',
    connection: { ...baseConnection, model: 'org/valid-model' },
  });
  assert.equal(fixed.models[0]!.configurationIssue, undefined);
  assert.equal(fixed.models[0]!.credentialReady, true);
  await start(f.controller, project.project!.id);
  const completed = await until(f.controller, ended);
  assert.equal(completed.run!.status, 'completed');
  assert.equal(calls, 1);
  assert.equal(JSON.parse(readFileSync(join(f.home, 'desktop-connections.json'), 'utf8'))[0].model, 'org/valid-model');
});

test('multiple legacy URL models can be repaired one at a time while adding valid connections', async (t) => {
  const first = { ...baseConnection, id: 'legacy-one', model: 'https://api.example.invalid/one' };
  const second = { ...baseConnection, id: 'legacy-two', model: 'https://api.example.invalid/two' };
  const f = fixture(t, undefined, {}, [first, second]);
  const file = join(f.home, 'desktop-connections.json');
  const repaired = await f.controller.handle({
    method: 'saveConnection',
    connection: { ...first, model: 'step-5-preview' },
  });
  assert.equal(repaired.models.find((model) => model.id === first.id)!.configurationIssue, undefined);
  assert.ok(repaired.models.find((model) => model.id === second.id)!.configurationIssue);
  assert.deepEqual(
    JSON.parse(readFileSync(file, 'utf8')).find((row: Connection) => row.id === second.id),
    second,
  );
  await f.controller.handle({
    method: 'saveConnection',
    connection: { ...baseConnection, id: 'new-valid', model: 'org/valid-model' },
  });
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).length, 3);
  const completed = await f.controller.handle({
    method: 'saveConnection',
    connection: { ...second, model: 'another/valid-model' },
  });
  assert.ok(completed.models.every((model) => !model.configurationIssue));
  assert.equal(readConnections(f.home).length, 3);
});

test('legacy preservation ignores property order but rejects changed or new URL models without altering metadata', async (t) => {
  const legacy = { ...baseConnection, model: 'https://api.example.invalid/legacy' };
  const f = fixture(t, undefined, {}, [legacy]);
  const file = join(f.home, 'desktop-connections.json');
  const reordered = Object.fromEntries(Object.entries(readConnections(f.home)[0]!).reverse()) as Connection;
  writeConnections(f.home, [reordered]);
  const before = readFileSync(file, 'utf8');
  assert.deepEqual(JSON.parse(before), [legacy]);
  assert.throws(
    () => writeConnections(f.home, [{ ...reordered, model: 'https://api.example.invalid/changed' }]),
    /模型 ID/,
  );
  assert.equal(readFileSync(file, 'utf8'), before);
  assert.throws(() => writeConnections(f.home, [reordered, { ...legacy, id: 'new-invalid' }]), /模型 ID/);
  assert.equal(readFileSync(file, 'utf8'), before);
  await assert.rejects(
    f.controller.handle({ method: 'saveConnection', connection: { ...legacy, name: 'changed legacy row' } }),
    /模型 ID/,
  );
  assert.equal(readFileSync(file, 'utf8'), before);
});

test('project connections never fall back to ambient provider keys', async (t) => {
  const f = fixture(t, () => scripted({ text: '完成' }), { ANTHROPIC_API_KEY: 'ambient-default-key' });
  mkdirSync(join(f.project, '.mh'));
  writeFileSync(
    join(f.project, '.mh', 'config.json'),
    JSON.stringify({ provider: 'anthropic', model: 'project-model' }),
  );
  const projectId = await configured(f);
  const imported = (await f.controller.handle({ method: 'snapshot' })).models.find(
    (model) => model.source === 'project',
  )!;
  assert.equal(imported.credentialReady, false, 'no ambient key fallback for project-sourced connections');
  await assert.rejects(
    f.controller.handle({
      method: 'startRun',
      input: { projectId, prompt: '不应启动', modelId: imported.id, thinking: 'off' },
    }),
    /尚无可用密钥/,
  );
});
