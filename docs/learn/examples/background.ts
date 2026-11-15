import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig } from '../../../src/app/config.ts';
import { BackgroundStore } from '../../../src/app/background/store.ts';
import { BackgroundWorker } from '../../../src/app/background/worker.ts';
import { BackgroundTimers } from '../../../src/app/background/timers.ts';
import { BackgroundOutbox } from '../../../src/app/background/outbox.ts';
import { BackgroundApprovals } from '../../../src/app/background/approvals.ts';
import { scripted } from './scripted.ts';

const directory = await mkdtemp(join(tmpdir(), 'mh-learn-background-')),
  cwd = join(directory, 'project'),
  home = join(directory, 'home');
await mkdir(cwd);
await writeFile(join(cwd, 'evidence.txt'), 'expected42 actual41');
let now = Date.now();
const store = new BackgroundStore(home, () => now),
  config = defaultConfig();
config.model = 'offline-background';
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {
  throw new Error('The offline example must not use the network.');
};
let worker: BackgroundWorker | undefined;
try {
  const task = store.createTask({ cwd, goal: '检查 evidence.txt，有变化再通知' });
  const read = { calls: [{ name: 'read', args: { path: 'evidence.txt' } }] };
  worker = new BackgroundWorker({
    store,
    config,
    provider: scripted(read, { text: '发现检查失败：41不等于42。' }, read, { text: '检查结果仍相同。' }),
  });
  const event = { taskId: task.id, source: 'demo', sourceEventId: 'check-1', payload: { artifact: 'evidence.txt' } };
  store.enqueue(event);
  assert.equal(store.enqueue(event).duplicate, true);
  await worker.runOnce();
  console.log('[1] 相同来源事件去重，真实读取后投递一次。');
  new BackgroundTimers(store).create({ taskId: task.id, atUtc: now + 1000 });
  now += 1001;
  await worker.runOnce();
  assert.deepEqual(
    new BackgroundOutbox(store).outcomes(task.id).map((row) => row.decision),
    ['send', 'quiet'],
  );
  console.log('[2] 到期进入同一个Inbox；相同证据保持安静。');
  worker.close();
  const edit = store.createTask({ cwd, goal: '写入 answer.txt=42', editablePaths: ['answer.txt'] });
  store.enqueue({ taskId: edit.id, source: 'demo', sourceEventId: 'edit-1', payload: {} });
  const provider = scripted(
    { calls: [{ name: 'write', args: { path: 'answer.txt', content: '42\n' } }] },
    { text: '修改已完成；没有执行额外检查。' },
  );
  worker = new BackgroundWorker({ store, config, provider });
  assert.equal((await worker.runOnce())?.state, 'suspended');
  worker.close();
  const approvals = new BackgroundApprovals(store),
    request = approvals.list(edit.id)[0]!;
  approvals.respond(request.id, 'allow');
  worker = new BackgroundWorker({ store, config, provider });
  assert.equal((await worker.runOnce())?.state, 'completed');
  assert.equal(await readFile(join(cwd, 'answer.txt'), 'utf8'), '42\n');
  assert.equal(approvals.get(request.id).state, 'consumed');
  console.log('[3] 准确批准后，新run恢复原调用，文件实际写入42。');
  console.log('[4] 模型回复固定；持久化、工具、审批和去重使用真实实现。');
} finally {
  worker?.close();
  store.close();
  globalThis.fetch = originalFetch;
  await rm(directory, { recursive: true, force: true });
}
