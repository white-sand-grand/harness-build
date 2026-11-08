import { mkdtemp, cp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { loadTasks } from '../src/eval/task.ts';
import { runCommand } from '../src/util/process.ts';
const root = resolve('evals/tasks'),
  tasks = loadTasks(root);
assert.equal(tasks.length, 8);
for (const task of tasks) {
  const dir = await mkdtemp(join(tmpdir(), 'mh-task-validation-'));
  try {
    await cp(join(root, task.id, 'files'), dir, { recursive: true });
    for (const args of [
      ['init'],
      ['add', '-A'],
      [
        '-c',
        'user.name=mini-harness',
        '-c',
        'user.email=mini-harness@localhost',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-m',
        'init',
      ],
    ])
      assert.equal(spawnSync('git', args, { cwd: dir, stdio: 'ignore', windowsHide: true }).status, 0);
    if (task.setup) assert.equal((await runCommand(task.setup, { cwd: dir })).exitCode, 0);
    const initial = await runCommand(task.check.command, { cwd: dir });
    if (task.id === 'explain-no-edit') {
      assert.ok(task.judge);
      assert.equal(initial.exitCode, 0);
      await writeFile(join(dir, 'normalize.cjs'), 'changed');
      assert.notEqual((await runCommand(task.check.command, { cwd: dir })).exitCode, 0);
      await cp(join(root, task.id, 'files/normalize.cjs'), join(dir, 'normalize.cjs'));
    } else assert.notEqual(initial.exitCode, 0, `${task.id} must fail before a fix`);
    const rewrite = async (path: string, fn: (s: string) => string) =>
      writeFile(join(dir, path), fn(await readFile(join(dir, path), 'utf8')));
    switch (task.id) {
      case 'fix-off-by-one':
        await rewrite('sum.cjs', (s) => s.replace('values.length - 1', 'values.length'));
        break;
      case 'add-cli-flag':
        await writeFile(
          join(dir, 'cli.cjs'),
          "const args=process.argv.slice(2);const text=args.filter(a=>a!=='--upper').join(' ');console.log(args.includes('--upper')?text.toUpperCase():text);\n",
        );
        break;
      case 'rename-across-files':
        for (const path of ['src/model.cjs', 'src/service.cjs', 'src/index.cjs'])
          await rewrite(path, (s) => s.replaceAll('getUsr', 'getUser'));
        break;
      case 'find-in-big-log':
        await writeFile(
          join(dir, 'answer.txt'),
          (await readFile(join(dir, 'server.log'), 'utf8')).split('\n').find((l) => l.includes('ERROR'))!,
        );
        break;
      case 'crlf-edit':
        await rewrite('settings.cjs', (s) => s.replace('timeout = 10', 'timeout = 20'));
        break;
      case 'json-config-migrate':
        await writeFile(
          join(dir, 'config.json'),
          JSON.stringify({
            version: 2,
            server: { host: '127.0.0.1', port: 3000 },
            retry: { maxAttempts: 3 },
            ui: { theme: 'dark' },
          }),
        );
        break;
      case 'recover-from-error':
        await rewrite('package.json', (s) => {
          const p = JSON.parse(s);
          p.scripts.test = 'node --test';
          return JSON.stringify(p);
        });
        break;
    }
    const fixed = await runCommand(task.check.command, { cwd: dir });
    assert.equal(fixed.exitCode, 0, task.id + ' reference fix failed:\n' + fixed.output);
    process.stdout.write(
      `PASS ${task.id}: initial ${task.id === 'explain-no-edit' ? 'read-only check + edit rejection' : 'failure'} and reference end state verified\n`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
