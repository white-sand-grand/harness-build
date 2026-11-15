import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DesktopController } from '../host/controller.ts';
import type { Connection, Snapshot } from '../contracts.ts';
import { BackgroundStore } from '../../src/app/background/store.ts';
import { BackgroundWorker } from '../../src/app/background/worker.ts';
import { defaultConfig } from '../../src/app/config.ts';
import { scripted } from '../../test/helpers/fake-provider.ts';
import { disconnectedSnapshot } from '../main/disconnected.ts';

const promptsDir = fileURLToPath(new URL('../../prompts/', import.meta.url));
const connection: Connection = {
  id: 'background-model',
  name: 'Local test',
  provider: 'anthropic',
  model: 'fake',
  supportsThinking: false,
  supportsImages: false,
  contextWindow: 128000,
  maxOutputTokens: 8192,
};
const pause = () => new Promise((resolve) => setTimeout(resolve, 10));
async function idle(controller: DesktopController): Promise<Snapshot> {
  for (let i = 0; i < 1500; i++) {
    const snapshot = await controller.handle({ method: 'snapshot' });
    if (!snapshot.background?.running) return snapshot;
    await pause();
  }
  throw new Error('Background Host did not become idle.');
}

test('Desktop persists an exact approval across Host restart and resumes with private credentials', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mh-desktop-background-')),
    home = join(root, 'home'),
    cwd = join(root, '项目');
  await mkdir(cwd);
  await writeFile(join(cwd, 'a.txt'), 'original');
  let controller = new DesktopController({
    home,
    promptsDir,
    onSnapshot() {},
    providerFactory: () => scripted({ toolCalls: [{ name: 'write', args: { path: 'a.txt', content: 'changed' } }] }),
  });
  try {
    await controller.handle({ method: 'saveConnection', connection, apiKey: 'private-background-one' });
    const projectId = (await controller.handle({ method: 'openProject', path: cwd })).project!.id;
    let state = await controller.handle({
      method: 'backgroundCreate',
      projectId,
      goal: 'Update a.txt',
      editablePaths: ['a.txt'],
    });
    const taskId = state.background!.tasks[0]!.id;
    await controller.handle({ method: 'backgroundRun', projectId, taskId, modelId: connection.id, thinking: 'off' });
    state = await idle(controller);
    const approvalId = state.background!.approvals[0]!.id;
    assert.equal(state.background!.tasks[0]!.state, 'waitingApproval');
    assert.equal(await readFile(join(cwd, 'a.txt'), 'utf8'), 'original');
    assert.ok(!JSON.stringify(state).includes('private-background-one'));
    await controller.handle({ method: 'shutdown' });
    let requests = 0;
    controller = new DesktopController({
      home,
      promptsDir,
      onSnapshot() {},
      providerFactory: (_, credential) => {
        assert.equal(credential.apiKey, 'private-background-two');
        requests++;
        return scripted({ text: 'changed' });
      },
    });
    await controller.handle({ method: 'openProject', path: cwd });
    state = await controller.handle({ method: 'backgroundRefresh', projectId });
    assert.equal(state.background!.approvals[0]!.id, approvalId);
    await controller.handle({ method: 'backgroundApprove', projectId, approvalId, decision: 'allow' });
    await assert.rejects(
      controller.handle({ method: 'backgroundRun', projectId, taskId, modelId: connection.id, thinking: 'off' }),
      /密钥/,
    );
    await controller.handle({ method: 'saveConnection', connection, apiKey: 'private-background-two' });
    await controller.handle({ method: 'backgroundRun', projectId, taskId, modelId: connection.id, thinking: 'off' });
    state = await idle(controller);
    assert.equal(await readFile(join(cwd, 'a.txt'), 'utf8'), 'changed');
    assert.equal(requests, 1);
    assert.equal(state.background!.approvals[0]!.state, 'consumed');
    assert.ok(!JSON.stringify(state).includes('private-background-two'));
  } finally {
    await controller.handle({ method: 'shutdown' });
    await rm(root, { recursive: true, force: true });
  }
});

test('Desktop background controls filter projects and never process another project queue', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mh-desktop-background-')),
    home = join(root, 'home'),
    cwd = join(root, 'here'),
    other = join(root, 'other');
  await mkdir(cwd);
  await mkdir(other);
  const store = new BackgroundStore(home),
    foreign = store.createTask({ cwd: other, goal: 'foreign' });
  store.enqueue({ taskId: foreign.id, source: 'local', sourceEventId: 'foreign', payload: {} });
  store.close();
  const controller = new DesktopController({
    home,
    promptsDir,
    onSnapshot() {},
    providerFactory: () => scripted({ text: 'local' }),
  });
  try {
    await controller.handle({ method: 'saveConnection', connection, apiKey: 'private-key' });
    const projectId = (await controller.handle({ method: 'openProject', path: cwd })).project!.id;
    const state = await controller.handle({ method: 'backgroundCreate', projectId, goal: 'local', editablePaths: [] });
    assert.equal(state.background!.tasks.length, 1);
    assert.equal(state.background!.tasks[0]!.goal, 'local');
    await assert.rejects(
      controller.handle({
        method: 'backgroundRun',
        projectId,
        taskId: foreign.id,
        modelId: connection.id,
        thinking: 'off',
      }),
      /不属于/,
    );
    await assert.rejects(controller.handle({ method: 'backgroundCancel', projectId, taskId: foreign.id }), /不属于/);
    await controller.handle({
      method: 'backgroundRun',
      projectId,
      taskId: state.background!.tasks[0]!.id,
      modelId: connection.id,
      thinking: 'off',
    });
    await idle(controller);
    const reopened = new BackgroundStore(home);
    try {
      assert.equal(reopened.events(foreign.id)[0]!.status, 'pending');
      assert.ok(reopened.runs().every((run) => run.taskId !== foreign.id));
    } finally {
      reopened.close();
    }
  } finally {
    await controller.handle({ method: 'shutdown' });
    await rm(root, { recursive: true, force: true });
  }
});

test('Desktop shutdown awaits background cancellation and releases its supervisor owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mh-desktop-background-')),
    home = join(root, 'home'),
    cwd = join(root, 'project');
  await mkdir(cwd);
  let started = false;
  const controller = new DesktopController({
    home,
    promptsDir,
    onSnapshot() {},
    providerFactory: () => ({
      id: 'anthropic',
      async stream(request, signal) {
        started = true;
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener('abort', () => resolve(), { once: true });
        });
        return {
          role: 'assistant',
          content: [],
          stopReason: 'aborted',
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          model: request.model.id,
          provider: 'anthropic',
        };
      },
    }),
  });
  try {
    await controller.handle({ method: 'saveConnection', connection, apiKey: 'private-key' });
    const projectId = (await controller.handle({ method: 'openProject', path: cwd })).project!.id;
    const state = await controller.handle({ method: 'backgroundCreate', projectId, goal: 'wait', editablePaths: [] });
    await controller.handle({
      method: 'backgroundRun',
      projectId,
      taskId: state.background!.tasks[0]!.id,
      modelId: connection.id,
      thinking: 'off',
    });
    for (let i = 0; !started && i < 1500; i++) await pause();
    assert.equal(started, true);
    await assert.rejects(controller.handle({ method: 'newSession', projectId }), /仍在运行/);
    const ended = await controller.handle({ method: 'shutdown' });
    assert.equal(ended.background?.running, false);
    const store = new BackgroundStore(home),
      worker = new BackgroundWorker({ store, config: defaultConfig() });
    worker.close();
    store.close();
  } finally {
    await controller.handle({ method: 'shutdown' }).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test('Host disconnect clears transient background running state while retaining saved approval display', () => {
  const previous: Snapshot = {
    protocolVersion: 1,
    seq: 1,
    sessions: [],
    messages: [],
    activities: [],
    streamingText: '',
    approvals: [],
    models: [],
    background: {
      running: true,
      tasks: [],
      messages: [],
      approvals: [{ id: 'p', taskId: 't', detail: 'write', state: 'pending', expiresAt: 123 }],
    },
  };
  const next = disconnectedSnapshot(previous);
  assert.equal(next.background?.running, false);
  assert.equal(next.background?.approvals[0]?.id, 'p');
  assert.equal(previous.background?.running, true);
});

test('Desktop task creation and its first event are atomic when enqueue fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mh-desktop-background-')),
    home = join(root, 'home'),
    cwd = join(root, 'project');
  await mkdir(cwd);
  const controller = new DesktopController({ home, promptsDir, onSnapshot() {} });
  try {
    const projectId = (await controller.handle({ method: 'openProject', path: cwd })).project!.id;
    const store = new BackgroundStore(home);
    store.db.exec(
      "CREATE TRIGGER fail_event BEFORE INSERT ON inbox BEGIN SELECT RAISE(ABORT,'injected event failure'); END;",
    );
    store.close();
    await assert.rejects(
      controller.handle({ method: 'backgroundCreate', projectId, goal: 'Atomic task', editablePaths: [] }),
      /injected event failure/,
    );
    const check = new BackgroundStore(home);
    try {
      assert.equal(check.tasks().length, 0);
      assert.equal(check.events().length, 0);
    } finally {
      check.close();
    }
  } finally {
    await controller.handle({ method: 'shutdown' });
    await rm(root, { recursive: true, force: true });
  }
});

test('Desktop delegates maintenance kinds to the CLI without starting or blocking those jobs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mh-desktop-background-')),
    home = join(root, 'home'),
    cwd = join(root, 'project');
  await mkdir(cwd);
  let providers = 0;
  const controller = new DesktopController({
    home,
    promptsDir,
    onSnapshot() {},
    providerFactory: () => {
      providers++;
      return scripted();
    },
  });
  try {
    await controller.handle({ method: 'saveConnection', connection, apiKey: 'private-key' });
    const projectId = (await controller.handle({ method: 'openProject', path: cwd })).project!.id;
    const store = new BackgroundStore(home),
      task = store.createTask({ cwd, goal: 'Curate', kind: 'dream' });
    store.close();
    await assert.rejects(
      controller.handle({
        method: 'backgroundRun',
        projectId,
        taskId: task.id,
        modelId: connection.id,
        thinking: 'off',
      }),
      /CLI/,
    );
    const check = new BackgroundStore(home);
    try {
      assert.equal(check.task(task.id).state, 'active');
      assert.equal(providers, 0);
    } finally {
      check.close();
    }
  } finally {
    await controller.handle({ method: 'shutdown' });
    await rm(root, { recursive: true, force: true });
  }
});
