import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import { defaultConfig, type Config } from '../../../src/app/config.ts';
import { createRuntime } from '../../../src/app/runtime.ts';
import { parseCLI } from '../../../src/cli/args.ts';
import { handleCommand } from '../../../src/cli/commands.ts';
import { runREPL } from '../../../src/cli/repl.ts';
import type { Provider } from '../../../src/ai/index.ts';
import type { Asker } from '../../../src/hooks/permission.ts';
import { scripted } from '../../helpers/fake-provider.ts';
import { anthropicFixture, withSSEServer } from '../../helpers/sse-server.ts';
import { withTmpDir } from '../../helpers/tmp.ts';

const entry = fileURLToPath(new URL('../../../src/cli/main.ts', import.meta.url));
async function runCLI(cwd: string, home: string, args: string[]) {
  const child = spawn(process.execPath, [entry, ...args], {
    cwd,
    env: { MH_HOME: home, MH_CLI_FIXTURE_KEY: 'offline-fixture' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    signal: AbortSignal.timeout(10000),
  });
  let stdout = '',
    stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  return { code, stdout, stderr };
}
async function writeConfig(cwd: string, value: Partial<Config>) {
  await mkdir(join(cwd, '.mh'), { recursive: true });
  await writeFile(join(cwd, '.mh', 'config.json'), JSON.stringify(value));
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

test('CLI profile and watch overrides retain configured profiles and close the runtime after plugins status', async () =>
  withTmpDir(async (cwd) => {
    const home = join(cwd, 'home');
    await writeConfig(cwd, {
      runtime: { profile: 'missing', profiles: { read: { tools: ['read'], memory: [] } } },
    });
    const result = await runCLI(cwd, home, ['plugins', '--profile', 'read', '--watch', '--json']);
    assert.equal(result.code, 0, result.stderr);
    const status = JSON.parse(result.stdout);
    assert.equal(status.profile, 'read');
    assert.equal(status.activeRuns, 0);
    assert.deepEqual(status.plugins, []);
  }));

test('maintenance CLI commands do not inspect or load configured external plugins', async () =>
  withTmpDir(async (cwd) => {
    const home = join(cwd, 'home');
    await writeConfig(cwd, { runtime: { profile: 'missing', plugins: ['./missing-plugin'] } });
    for (const [args, expected] of [
      [['memory', 'path'], 0],
      [['sessions'], 0],
      [['analyze'], 2],
      [['dream', '--dry-run'], 1],
      [['ralph'], 2],
      [['trace', 'missing'], 1],
      [['eval', 'compare', 'missing-a', 'missing-b'], 0],
    ] as const) {
      const result = await runCLI(cwd, home, [...args]);
      assert.equal(result.code, expected, JSON.stringify(result));
      assert.doesNotMatch(result.stderr, /Unknown runtime profile|mh-plugin|Plugin authorization/);
    }
  }));

test('CLI trust applies to exact plugin contents and always disposes loaded workers on exit', async () =>
  withTmpDir(async (cwd) => {
    const home = join(cwd, 'home'),
      plugin = join(cwd, 'plugin'),
      marker = join(cwd, 'marker.txt');
    await mkdir(plugin);
    await writeFile(
      join(plugin, 'mh-plugin.json'),
      JSON.stringify({
        id: 'marker',
        version: '1',
        module: 'index.mjs',
        files: ['index.mjs'],
      }),
    );
    const source = (value: string) => `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(marker)}, ${JSON.stringify(value)});
export default { id: 'marker', version: '1', async dispose() { writeFileSync(${JSON.stringify(marker)}, 'disposed'); } };`;
    await writeFile(join(plugin, 'index.mjs'), source('loaded'));
    await writeConfig(cwd, { runtime: { plugins: ['./plugin'] } });
    const denied = await runCLI(cwd, home, ['plugins', '--json']);
    assert.equal(denied.code, 1);
    assert.match(denied.stderr, /Plugin authorization denied/);
    await assert.rejects(() => access(marker));
    const trusted = await runCLI(cwd, home, ['plugins', '--json', '--trust-project']);
    assert.equal(trusted.code, 0, trusted.stderr);
    assert.equal(JSON.parse(trusted.stdout).plugins[0].id, 'marker');
    assert.equal(await readFile(marker, 'utf8'), 'disposed');
    await writeFile(join(plugin, 'index.mjs'), source('modified-code'));
    const changed = await runCLI(cwd, home, ['plugins', '--json']);
    assert.equal(changed.code, 1);
    assert.match(changed.stderr, /Plugin authorization denied/);
    assert.equal(await readFile(marker, 'utf8'), 'disposed');
  }));

test('print CLI uses the selected runtime tool composition with a local fixture provider', async () =>
  withTmpDir(async (cwd) => {
    const requests: Record<string, unknown>[] = [];
    await withSSEServer(
      (body) => {
        requests.push(body as Record<string, unknown>);
        return { chunks: anthropicFixture([{ type: 'text', text: '' }]) };
      },
      async (url) => {
        await writeConfig(cwd, {
          model: 'fixture',
          models: { fixture: { provider: 'anthropic', baseUrl: url, apiKeyEnv: 'MH_CLI_FIXTURE_KEY' } },
          runtime: { profiles: { read: { tools: ['read'], memory: [], reducer: 'none' } } },
        });
        const result = await runCLI(cwd, join(cwd, 'home'), ['-p', 'explain this', '--profile', 'read']);
        assert.equal(result.code, 0, result.stderr);
        assert.equal(result.stdout.trim(), 'hello');
      },
    );
    assert.equal(requests.length, 1);
    assert.deepEqual(
      (requests[0]?.tools as { name: string }[]).map((tool) => tool.name),
      ['read'],
    );
  }));

test('eval and evolve CLI commands pass a frozen snapshot and release their lease on failure', async () =>
  withTmpDir(async (cwd) => {
    const config: Config = { ...defaultConfig(), runtime: {} };
    const runtime = await createRuntime({ cwd, home: join(cwd, 'home'), config });
    try {
      for (const [args, error] of [
        [['eval', 'run'], /No evaluation tasks matched/],
        [['evolve'], /Evolution requires development tasks/],
      ] as const) {
        await assert.rejects(
          () =>
            handleCommand(parseCLI([...args, '--tasks', 'no-such-cli-fixture', '--output', join(cwd, 'output')]), {
              cwd,
              home: join(cwd, 'home'),
              config,
              runtime,
            }),
          error,
        );
        assert.equal(runtime.status().activeRuns, 0);
      }
    } finally {
      await runtime.close();
    }
  }));

test(
  'busy REPL runtime commands never reach the model while steering retains the current lease',
  { timeout: 5000 },
  async (t) =>
    withTmpDir(async (cwd) => {
      const input = new PassThrough(),
        started = deferred(),
        proceed = deferred();
      t.mock.getter(process, 'stdin', () => input as unknown as typeof process.stdin);
      const logs: string[] = [];
      t.mock.method(console, 'log', (...args: unknown[]) => {
        const text = args.map(String).join(' ');
        logs.push(text);
        if (text.startsWith('tokens ')) input.end();
      });
      const config: Config = {
        ...defaultConfig(),
        runtime: { profile: 'read', profiles: { read: { tools: ['read'], memory: [] } } },
      };
      const runtime = await createRuntime({ cwd, home: join(cwd, 'home'), config });
      const reload = t.mock.method(runtime, 'reload');
      const scriptedProvider = scripted({ text: 'first' }, { text: 'second' });
      const activeRuns: number[] = [];
      const provider: Provider = {
        id: 'anthropic',
        async stream(request, signal, emit) {
          activeRuns.push(runtime.status().activeRuns);
          started.resolve();
          await proceed.promise;
          return scriptedProvider.stream(request, signal, emit);
        },
      };
      t.after(() => {
        proceed.resolve();
        input.end();
      });
      const repl = runREPL({ cwd, home: join(cwd, 'home'), config, runtime, provider }, 'first task');
      await started.promise;
      input.write('/reload\n/profile read\n/plugins\nordinary steering\n');
      proceed.resolve();
      await repl;
      assert.equal(reload.mock.callCount(), 0);
      assert.equal(logs.filter((line) => line.includes('after the current run finishes')).length, 3);
      assert.deepEqual(activeRuns, [1, 1]);
      assert.equal(scriptedProvider.requests.length, 2);
      assert.match(JSON.stringify(scriptedProvider.requests[1]?.messages), /ordinary steering/);
      assert.doesNotMatch(JSON.stringify(scriptedProvider.requests[1]?.messages), /\/reload|\/profile|\/plugins/);
      assert.equal(runtime.status().activeRuns, 0);
      assert.equal(runtime.status().generations, 0);
    }),
);

test(
  'idle REPL profile and reload commands read fresh configuration and report plugin status',
  { timeout: 5000 },
  async (t) =>
    withTmpDir(async (cwd) => {
      const input = new PassThrough(),
        switched = deferred(),
        reloaded = deferred();
      t.mock.getter(process, 'stdin', () => input as unknown as typeof process.stdin);
      const logs: string[] = [];
      let count = 0;
      t.mock.method(console, 'log', (...args: unknown[]) => {
        const text = args.map(String).join(' ');
        logs.push(text);
        if (text.startsWith('Runtime reloaded:')) {
          if (++count === 1) switched.resolve();
          else reloaded.resolve();
        }
      });
      const home = join(cwd, 'home');
      let latest: Config = {
        ...defaultConfig(),
        runtime: { profiles: { read: { tools: ['read'], memory: [] } } },
      };
      const runtime = await createRuntime({ cwd, home, config: latest, readConfig: () => latest });
      t.after(() => input.end());
      const repl = runREPL({ cwd, home, config: latest, runtime });
      input.write('/profile read\n');
      await switched.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      latest = { ...latest, runtime: { profiles: { read: { tools: [], memory: [] } } } };
      input.write('/reload\n');
      await reloaded.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      const lease = await runtime.acquireRun();
      assert.deepEqual(lease.snapshot.profile.tools, []);
      await lease.release();
      input.write('/plugins\n/profile\n/exit\n');
      await repl;
      assert.equal(runtime.status().profile, 'read');
      assert.ok(logs.some((line) => line.includes('"plugins": []')));
      assert.ok(logs.includes('read'));
      assert.equal(runtime.status().activeRuns, 0);
      assert.equal(runtime.status().generations, 0);
    }),
);

test(
  'REPL reuses its asker for changed plugin fingerprints and retains the old generation on denial',
  { timeout: 5000 },
  async (t) =>
    withTmpDir(async (cwd) => {
      const input = new PassThrough(),
        asked = deferred(),
        rejected = deferred();
      t.mock.getter(process, 'stdin', () => input as unknown as typeof process.stdin);
      t.mock.method(console, 'log', () => {});
      t.mock.method(console, 'error', (message: unknown) => {
        if (String(message).includes('previous runtime retained')) rejected.resolve();
      });
      const home = join(cwd, 'home'),
        plugin = join(cwd, 'plugin');
      await mkdir(plugin);
      await writeFile(
        join(plugin, 'mh-plugin.json'),
        JSON.stringify({
          id: 'reloadable',
          version: '1',
          module: 'index.mjs',
          files: ['index.mjs'],
        }),
      );
      await writeFile(join(plugin, 'index.mjs'), "export default { id: 'reloadable', version: '1' };\n");
      const config: Config = { ...defaultConfig(), runtime: { plugins: ['./plugin'] } };
      let activeAsk: Asker | undefined;
      const runtime = await createRuntime({
        cwd,
        home,
        config,
        trustPlugins: true,
        ask: (question) => {
          asked.resolve();
          return activeAsk?.(question) ?? Promise.resolve('deny');
        },
      });
      const original = runtime.status().id;
      t.after(() => input.end());
      const repl = runREPL({
        cwd,
        home,
        config,
        runtime,
        onAsker: (ask) => {
          activeAsk = ask;
        },
      });
      await writeFile(join(plugin, 'index.mjs'), "export default { id: 'reloadable', version: '1' };\n// changed\n");
      input.write('/reload\n');
      await asked.promise;
      input.write('d\n');
      await rejected.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(runtime.status().id, original);
      input.write('/exit\n');
      await repl;
      assert.equal(runtime.status().activeRuns, 0);
      assert.equal(runtime.status().generations, 0);
    }),
);
