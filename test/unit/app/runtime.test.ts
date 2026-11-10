import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { defaultConfig, loadConfig } from '../../../src/app/config.ts';
import { defaultPromptsDir } from '../../../src/app/prompts.ts';
import { createRuntime, RuntimeManager } from '../../../src/app/runtime.ts';
import { startRun } from '../../../src/app/run.ts';
import { openSession } from '../../../src/session/index.ts';
import { validateConfig } from '../../../src/app/config-schema.ts';
import { readPromptSelection } from '../../../src/app/prompt-selection.ts';
import { writePromptArtifact } from '../../../src/eval/prompt-artifact.ts';
import { promptHash } from '../../../src/eval/candidate.ts';
import { scripted } from '../../helpers/fake-provider.ts';
import { withTmpDir } from '../../helpers/tmp.ts';

async function fixture(root: string) {
  const cwd = join(root, 'workspace'),
    home = join(root, 'home'),
    directory = join(root, 'plugin');
  await mkdir(cwd);
  await mkdir(home);
  await mkdir(directory);
  await writeFile(
    join(directory, 'mh-plugin.json'),
    JSON.stringify({ id: 'demo', version: '1', module: 'main.mjs', files: ['main.mjs'] }),
  );
  const update = async (version: string) =>
    writeFile(
      join(directory, 'main.mjs'),
      `
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
export default {id:'demo',version:'1',
 tools:[{name:'lookup',description:'Look up a value',readOnly:true,parameters:{type:'object',properties:{}},
  async execute(){return {content:[{type:'text',text:${JSON.stringify(version)}}]}}}],
 context:[{id:'facts',async provide(){return 'TRANSIENT_CONTEXT_${version}'}}],
 memory:[{id:'notes',async recall(){return 'RECALLED_${version}'},async remember(ctx){await writeFile(join(ctx.home,'remembered.txt'),'${version}')}}],
 prompts:{style:'STATIC_FRAGMENT_${version}'},
 hooks:[{id:'audit',async afterTool(call,tool,result){return {...result,content:[...result.content,{type:'text',text:'AUDITED'}]}}}]
};
`,
    );
  await update('v1');
  const config = defaultConfig();
  config.permissions.mode = 'yolo';
  config.runtime = {
    plugins: [directory],
    profile: 'custom',
    profiles: {
      custom: {
        tools: ['demo__lookup'],
        context: ['demo/facts'],
        memory: ['demo/notes'],
        prompts: ['demo/style'],
        hooks: ['demo/audit'],
        reducer: 'none',
        offload: false,
      },
      readonly: { tools: ['read'], memory: [], reducer: 'none' },
    },
  };
  return { cwd, home, directory, update, config };
}

test('profiles combine worker tools, temporary context, memory, prompts and hooks without changing history', async () =>
  withTmpDir(async (root) => {
    const f = await fixture(root),
      runtime = await createRuntime({ ...f, trustPlugins: true });
    try {
      const provider = scripted({ toolCalls: [{ name: 'demo__lookup', args: {} }] }, { text: 'finished' });
      const result = await startRun({ ...f, prompt: 'lookup', runtime, provider });
      assert.equal(result.reason, 'done');
      assert.deepEqual(
        provider.requests[0]!.tools.map((t) => t.name),
        ['demo__lookup'],
      );
      for (const request of provider.requests) {
        assert.match(request.system, /STATIC_FRAGMENT_v1/);
        assert.match(request.system, /TRANSIENT_CONTEXT_v1/);
        assert.match(request.system, /RECALLED_v1/);
      }
      assert.match(JSON.stringify(provider.requests[1]!.messages), /AUDITED/);
      assert.doesNotMatch(JSON.stringify(result.session.entries()), /TRANSIENT_CONTEXT|RECALLED/);
      assert.equal(await readFile(join(f.home, 'remembered.txt'), 'utf8'), 'v1');
      assert.deepEqual(
        openSession(f.home, f.cwd, result.session.id).context().messages,
        result.session.context().messages,
      );
      const record = result.session.entries().find((e) => e.type === 'trace' && e.name === 'runtime');
      assert.ok(record?.type === 'trace');
      assert.match(await readFile(String(record.data.file), 'utf8'), /STATIC_FRAGMENT_v1/);
      const reload = await runtime.reload('readonly');
      assert.equal(reload.ok, true);
      const next = scripted({ text: 'read only' });
      await startRun({ ...f, prompt: 'inspect', runtime, provider: next, session: result.session });
      assert.deepEqual(
        next.requests[0]!.tools.map((t) => t.name),
        ['read'],
      );
      assert.doesNotMatch(next.requests[0]!.system, /STATIC_FRAGMENT|TRANSIENT_CONTEXT|RECALLED/);
    } finally {
      await runtime.close();
    }
  }));

test('reload keeps in-flight generations alive, switches the next run, and releases old workers', async () =>
  withTmpDir(async (root) => {
    const f = await fixture(root),
      runtime = await createRuntime({ ...f, trustPlugins: true, ask: async () => 'once' });
    const old = await runtime.acquireRun();
    try {
      await f.update('v2');
      assert.equal((await runtime.reload()).ok, true);
      assert.equal(runtime.status().generations, 2);
      const first = scripted({ toolCalls: [{ name: 'demo__lookup', args: {} }] }, { text: 'old' });
      await startRun({ ...f, prompt: 'old leased request', runtimeSnapshot: old.snapshot, provider: first });
      assert.match(JSON.stringify(first.requests[1]!.messages), /v1/);
      assert.match(first.requests[0]!.system, /STATIC_FRAGMENT_v1/);
      const second = scripted({ toolCalls: [{ name: 'demo__lookup', args: {} }] }, { text: 'new' });
      await startRun({ ...f, prompt: 'next run', runtime, provider: second });
      assert.match(JSON.stringify(second.requests[1]!.messages), /v2/);
      assert.match(second.requests[0]!.system, /STATIC_FRAGMENT_v2/);
      await old.release();
      assert.equal(runtime.status().generations, 1);
      await assert.rejects(
        old.snapshot.tools[0]!.execute(
          {},
          { cwd: f.cwd, home: f.home, sessionDir: root, signal: new AbortController().signal },
        ),
        /disposed/,
      );
    } finally {
      await old.release();
      await runtime.close();
    }
  }));

test('changed executable content requires fresh authorization and a failed reload preserves the usable generation', async () =>
  withTmpDir(async (root) => {
    const f = await fixture(root),
      runtime = await createRuntime({ ...f, trustPlugins: true });
    try {
      const previous = runtime.status().id;
      await f.update('v2');
      const denied = await runtime.reload();
      assert.equal(denied.ok, false);
      assert.match(denied.error!, /authorization denied/);
      assert.equal(runtime.status().id, previous);
      assert.equal(runtime.status().generations, 1);
      const provider = scripted({ text: 'still usable' });
      await startRun({ ...f, prompt: 'continue', runtime, provider });
      assert.match(provider.requests[0]!.system, /STATIC_FRAGMENT_v1/);
      assert.equal((await runtime.reload('missing')).ok, false);
      assert.equal(runtime.status().profile, 'custom');
    } finally {
      await runtime.close();
    }
  }));

test('source prompts stay frozen until a successful reload and rebuild the same session system together', async () =>
  withTmpDir(async (root) => {
    const cwd = join(root, 'workspace'),
      home = join(root, 'home'),
      prompts = join(root, 'prompts');
    await mkdir(cwd);
    await mkdir(home);
    await cp(defaultPromptsDir, prompts, { recursive: true });
    await writeFile(join(prompts, 'system.md'), 'SYSTEM_BEFORE');
    const config = defaultConfig();
    config.promptsDir = prompts;
    config.runtime = { profiles: { default: { tools: [], memory: [] } } };
    const runtime = await createRuntime({ cwd, home, config });
    try {
      const first = await startRun({ cwd, home, config, runtime, prompt: 'one', provider: scripted({ text: 'one' }) });
      await writeFile(join(prompts, 'system.md'), 'SYSTEM_AFTER');
      const before = scripted({ text: 'two' });
      await startRun({ cwd, home, config, runtime, prompt: 'two', provider: before, session: first.session });
      assert.match(before.requests[0]!.system, /SYSTEM_BEFORE/);
      assert.equal((await runtime.reload()).ok, true);
      const after = scripted({ text: 'three' });
      await startRun({ cwd, home, config, runtime, prompt: 'three', provider: after, session: first.session });
      assert.match(after.requests[0]!.system, /SYSTEM_AFTER/);
      assert.equal(first.session.entries().filter((e) => e.type === 'trace' && e.name === 'runtime').length, 2);
    } finally {
      await runtime.close();
    }
  }));

test('watch detects atomic saves and malformed config keeps the previous snapshot until repair', async () =>
  withTmpDir(async (root) => {
    const cwd = join(root, 'workspace'),
      home = join(root, 'home');
    await mkdir(join(cwd, '.mh'), { recursive: true });
    await mkdir(home);
    const path = join(cwd, '.mh', 'config.json');
    await writeFile(
      path,
      JSON.stringify({ runtime: { watch: true, profiles: { default: { tools: ['read'], memory: [] } } } }),
    );
    const readConfig = () => loadConfig({ cwd, home }),
      runtime = await createRuntime({ cwd, home, config: readConfig(), readConfig });
    try {
      const id = runtime.status().id;
      await writeFile(path, '{');
      await delay(600);
      assert.equal(runtime.status().dirty, true);
      const retained = await runtime.acquireRun();
      await retained.release();
      assert.equal(runtime.status().id, id);
      assert.match(runtime.status().error!, /Invalid config/);
      await writeFile(
        path + '.tmp',
        JSON.stringify({ runtime: { watch: true, profiles: { default: { tools: [], memory: [] } } } }),
      );
      await rename(path + '.tmp', path);
      const next = await runtime.acquireRun();
      assert.deepEqual(next.snapshot.profile.tools, []);
      assert.notEqual(next.snapshot.id, id);
      await next.release();
    } finally {
      await runtime.close();
    }
  }));

test('close waits for outstanding leases and refuses additional runs', async () =>
  withTmpDir(async (root) => {
    const f = await fixture(root),
      runtime = await createRuntime({ ...f, trustPlugins: true });
    const lease = await runtime.acquireRun();
    let closed = false;
    const closing = runtime.close().then(() => {
      closed = true;
    });
    await delay(10);
    assert.equal(closed, false);
    await assert.rejects(runtime.acquireRun(), /not available/);
    await lease.release();
    await closing;
    assert.equal(closed, true);
    assert.equal(runtime.status().generations, 0);
  }));

test('restricted maintenance runs do not initialize configured external capabilities', async () =>
  withTmpDir(async (root) => {
    const config = defaultConfig();
    config.runtime = { plugins: [join(root, 'not-a-plugin')] };
    const provider = scripted({ text: 'maintenance' });
    await startRun({
      cwd: root,
      home: join(root, 'home'),
      config,
      prompt: 'maintain',
      toolsFilter: ['read'],
      systemOverride: 'MAINTENANCE',
      provider,
    });
    assert.deepEqual(
      provider.requests[0]!.tools.map((t) => t.name),
      ['read'],
    );
  }));

test('runtime config rejects unknown profile fields and duplicate selections before activation', async () =>
  withTmpDir(async (root) => {
    assert.throws(
      () => validateConfig({ runtime: { profiles: { default: { mystery: true } } } }, 'test'),
      /unknown property/,
    );
    const config = defaultConfig();
    config.runtime = { profiles: { default: { memory: ['file-index', 'file-index'] } } };
    await assert.rejects(createRuntime({ cwd: root, home: join(root, 'home'), config }), /Duplicate memory/);
  }));

test('runtime accepts a verified optimization artifact and refuses a modified prompt', async () =>
  withTmpDir(async (root) => {
    const directory = join(root, 'bundle', 'prompts');
    await cp(defaultPromptsDir, directory, { recursive: true });
    writePromptArtifact({
      outputDir: join(root, 'bundle'),
      promptsDir: directory,
      parentHash: promptHash(directory),
      decision: 'recommend',
      optimizer: { id: 'evidence', version: '1' },
    });
    const profile = { promptArtifact: join(root, 'bundle', 'prompt-artifact.json') };
    assert.equal(readPromptSelection(defaultConfig(), profile, root).hash, promptHash(directory));
    await writeFile(join(directory, 'system.md'), 'changed after selection');
    assert.throws(() => readPromptSelection(defaultConfig(), profile, root), /artifact changed/);
  }));

test('successful reload updates watch enablement in both directions', async () =>
  withTmpDir(async (root) => {
    const config = defaultConfig();
    config.runtime = { watch: false, profiles: { default: { tools: ['read'], memory: [] } } };
    const runtime = await createRuntime({ cwd: root, home: join(root, 'home'), config, readConfig: () => config });
    try {
      config.runtime.watch = true;
      assert.equal((await runtime.reload()).ok, true);
      config.runtime.profiles!.default!.tools = [];
      const watched = await runtime.acquireRun();
      assert.deepEqual(watched.snapshot.profile.tools, []);
      await watched.release();
      config.runtime.watch = false;
      assert.equal((await runtime.reload()).ok, true);
      config.runtime.profiles!.default!.tools = ['read'];
      const unwatched = await runtime.acquireRun();
      assert.deepEqual(unwatched.snapshot.profile.tools, []);
      await unwatched.release();
    } finally {
      await runtime.close();
    }
  }));

test('closing during initialization never publishes a worker generation after close', async () =>
  withTmpDir(async (root) => {
    const f = await fixture(root);
    const path = join(f.directory, 'main.mjs');
    await writeFile(path, 'await new Promise(r=>setTimeout(r,100));\n' + (await readFile(path, 'utf8')));
    const runtime = new RuntimeManager({ ...f, trustPlugins: true });
    const initializing = runtime.initialize(),
      rejected = assert.rejects(initializing, /closed/);
    await delay(20);
    await runtime.close();
    await rejected;
    assert.equal(runtime.status().generations, 0);
    await assert.rejects(runtime.acquireRun(), /not available/);
  }));

test('a failing run releases its runtime lease', async () =>
  withTmpDir(async (root) => {
    const f = await fixture(root),
      runtime = await createRuntime({ ...f, trustPlugins: true });
    try {
      await assert.rejects(startRun({ ...f, runtime, prompt: 'fail', provider: scripted() }), /no more steps/);
      assert.equal(runtime.status().activeRuns, 0);
    } finally {
      await runtime.close();
    }
  }));

test('memory writeback failure records an error terminal event and releases the lease', async () =>
  withTmpDir(async (root) => {
    const f = await fixture(root),
      path = join(f.directory, 'main.mjs');
    await writeFile(
      path,
      (await readFile(path, 'utf8')).replace(
        "await writeFile(join(ctx.home,'remembered.txt'),'v1')",
        "throw new Error('remember failed')",
      ),
    );
    const runtime = await createRuntime({ ...f, trustPlugins: true });
    const events: import('../../../src/agent/index.ts').AgentEvent[] = [];
    try {
      await assert.rejects(
        startRun({
          ...f,
          runtime,
          prompt: 'store',
          provider: scripted({ text: 'model finished' }),
          onEvent: (event) => events.push(event),
        }),
        /remember failed/,
      );
      assert.deepEqual(
        events.filter((event) => event.type === 'agentEnd').map((event) => event.type === 'agentEnd' && event.reason),
        ['error'],
      );
      const session = openSession(f.home, f.cwd, 'latest');
      assert.deepEqual(
        session
          .entries()
          .filter((event) => event.type === 'trace' && event.name === 'agentEnd')
          .map((event) => event.type === 'trace' && event.data.reason),
        ['error'],
      );
      assert.equal(runtime.status().activeRuns, 0);
    } finally {
      await runtime.close();
    }
  }));
