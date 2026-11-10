import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig } from '../../../src/app/config.ts';
import { createRuntime, type RuntimeManager, type RuntimeLease } from '../../../src/app/runtime.ts';
import { startRun } from '../../../src/app/run.ts';
import { scripted } from './scripted.ts';

const root = await mkdtemp(join(tmpdir(), 'mh-learn-runtime-'));
const cwd = join(root, 'workspace'),
  home = join(root, 'home'),
  directory = join(root, 'plugin');
let runtime: RuntimeManager | undefined, old: RuntimeLease | undefined;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {
  throw new Error('This example must not access the network.');
};

async function version(value: string) {
  await writeFile(
    join(directory, 'mh-plugin.json'),
    JSON.stringify({
      id: 'lesson',
      version: value,
      module: 'main.mjs',
      files: ['main.mjs'],
    }),
  );
  await writeFile(
    join(directory, 'main.mjs'),
    `
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
const version=${JSON.stringify(value)};
export default {
  id:'lesson',version,
  tools:[{name:'lookup',description:'Read the lesson answer.',readOnly:true,
    parameters:{type:'object',properties:{}},
    async execute(_args,ctx){ctx.signal.throwIfAborted();return {content:[{type:'text',text:version+':'+await readFile(join(ctx.cwd,'answer.txt'),'utf8')}]}}}],
  context:[{id:'facts',async provide(){return 'CONTEXT_'+version}}],
  memory:[{id:'notes',async recall(){return 'RECALLED_NOTE'},async remember(ctx){await writeFile(join(ctx.home,'last-version.txt'),version)}}],
  prompts:{workflow:'RULE_'+version},
  hooks:[{id:'feedback',async afterTool(_call,_tool,result){return {...result,content:[...result.content,{type:'text',text:'CHECKED_'+version}]}}}]
};
`,
  );
}

try {
  await mkdir(cwd);
  await mkdir(home);
  await mkdir(directory);
  await writeFile(join(cwd, 'answer.txt'), '42');
  await version('v1');
  const config = defaultConfig();
  config.model = 'offline-demo';
  config.runtime = {
    plugins: [directory],
    profile: 'lookup',
    profiles: {
      lookup: {
        tools: ['lesson__lookup'],
        context: ['lesson/facts'],
        memory: ['lesson/notes'],
        prompts: ['lesson/workflow'],
        hooks: ['lesson/feedback'],
        reducer: 'none',
      },
      readonly: { tools: ['read'], memory: [], reducer: 'none' },
    },
  };
  // This process authorizes only the source it just created in its temporary directory.
  runtime = await createRuntime({ cwd, home, config, trustPlugins: true, ask: async () => 'once' });
  old = await runtime.acquireRun();
  await version('v2');
  assert.equal((await runtime.reload()).ok, true);
  assert.equal(runtime.status().generations, 2);
  console.log('[1] v2 已准备好；旧任务仍持有 v1。');

  const first = await startRun({
    cwd,
    home,
    config,
    runtimeSnapshot: old.snapshot,
    prompt: '读取答案。',
    ask: async () => 'once',
    provider: scripted(
      (request) => {
        for (const fragment of ['RULE_v1', 'CONTEXT_v1', 'RECALLED_NOTE']) assert.ok(request.system.includes(fragment));
        return { calls: [{ name: 'lesson__lookup', args: {} }] };
      },
      (request) => {
        assert.match(JSON.stringify(request.messages.at(-1)), /v1:42/);
        assert.match(JSON.stringify(request.messages.at(-1)), /CHECKED_v1/);
        return { text: 'v1 读取到 42。' };
      },
    ),
  });
  assert.equal(first.reason, 'done');
  assert.equal(await readFile(join(home, 'last-version.txt'), 'utf8'), 'v1');
  assert.doesNotMatch(JSON.stringify(first.session.entries()), /CONTEXT_v1|RECALLED_NOTE/);
  console.log('[2] v1 的工具、上下文、记忆和反馈按同一组合执行。');
  await old.release();
  old = undefined;
  assert.equal(runtime.status().generations, 1);

  const next = await startRun({
    cwd,
    home,
    config,
    runtime,
    session: first.session,
    prompt: '再读取一次。',
    ask: async () => 'once',
    provider: scripted(
      (request) => {
        assert.ok(request.system.includes('RULE_v2'));
        return { calls: [{ name: 'lesson__lookup', args: {} }] };
      },
      (request) => {
        assert.match(JSON.stringify(request.messages.at(-1)), /v2:42/);
        return { text: 'v2 读取到 42。' };
      },
    ),
  });
  assert.equal(next.reason, 'done');
  assert.equal(await readFile(join(home, 'last-version.txt'), 'utf8'), 'v2');
  console.log('[3] 同一会话的新任务使用 v2，旧 worker 已释放。');

  const previous = runtime.status().id;
  assert.equal((await runtime.reload('missing-profile')).ok, false);
  assert.equal(runtime.status().id, previous);
  console.log('[4] 错误组合被拒绝，活动版本仍为 v2。');
  assert.equal((await runtime.reload('readonly')).ok, true);
  await startRun({
    cwd,
    home,
    config,
    runtime,
    prompt: '只读查看。',
    provider: scripted((request) => {
      assert.deepEqual(
        request.tools.map((tool) => tool.name),
        ['read'],
      );
      assert.ok(!request.system.includes('RULE_v2'));
      return { text: '只读组合已生效。' };
    }),
  });
  console.log('[5] profile 可独立选择能力；只读组合仅暴露 read。');
} finally {
  await old?.release();
  await runtime?.close();
  globalThis.fetch = originalFetch;
  await rm(root, { recursive: true, force: true });
}
console.log('完成：无远程模型调用，临时文件已清理。');
