import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { inspectPlugin, loadPlugin } from '../../../src/app/plugin-loader.ts';
import type { PluginContext } from '../../../src/app/plugin-types.ts';
import { withTmpDir } from '../../helpers/tmp.ts';

async function fixture(root: string, source: string, extra: Record<string, string> = {}, module = 'plugin.mjs') {
  const directory = join(root, 'plugin');
  await mkdir(directory, { recursive: true });
  for (const [file, content] of Object.entries({ [module]: source, ...extra })) {
    const target = join(directory, file);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, content);
  }
  await writeFile(
    join(directory, 'mh-plugin.json'),
    JSON.stringify({ id: 'demo', version: '1', module, files: [module, ...Object.keys(extra)] }),
  );
  return directory;
}
const base = `export default { id: 'demo', version: '1' };`;
const tool = (body = `return { content: [{ type: 'text', text: 'ok' }] };`, name = 'echo') =>
  `{ name: '${name}', description: 'Echo', parameters: { type: 'object' }, readOnly: true, async execute(args, ctx) { ${body} } }`;
const context = (root: string, signal = new AbortController().signal): PluginContext => ({
  cwd: root,
  home: root,
  sessionDir: root,
  prompt: 'hello',
  messages: [],
  signal,
});

test('worker plugins reject process creation APIs before they can leave orphaned processes', async () => {
  for (const source of [
    `import {spawn} from 'node:child_process'; ${base}`,
    `import {createRequire} from 'node:module';createRequire(import.meta.url)('child_process'); ${base}`,
    `process.getBuiltinModule('child_process'); ${base}`,
    `import cluster from 'node:cluster'; ${base}`,
  ])
    await withTmpDir(async (root) => {
      const directory = await fixture(root, source);
      await assert.rejects(
        loadPlugin({ directory, cwd: root, home: root, authorize: async () => true }),
        /cannot create subprocesses/,
      );
    });
});

test('plugin authorization happens before module execution and fingerprints declared resources', async () => {
  await withTmpDir(async (root) => {
    const marker = join(root, 'executed');
    const directory = await fixture(
      root,
      `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'yes'); ${base}`,
      { 'note.txt': 'original' },
    );
    const before = inspectPlugin(directory);
    assert.ok(before.files.includes('mh-plugin.json'));
    assert.equal(existsSync(marker), false);
    await assert.rejects(
      loadPlugin({ directory, cwd: root, home: root, authorize: async () => false }),
      /authorization denied/,
    );
    assert.equal(existsSync(marker), false);
    await writeFile(join(directory, 'note.txt'), 'changed');
    assert.notEqual(inspectPlugin(directory).fingerprint, before.fingerprint);
    const plugin = await loadPlugin({
      directory,
      cwd: root,
      home: root,
      authorize: async () => {
        assert.equal(existsSync(marker), false);
        return true;
      },
    });
    try {
      assert.equal(await readFile(marker, 'utf8'), 'yes');
    } finally {
      await plugin.dispose?.();
    }
  });
});

test('plugin snapshots refresh dependencies and preserve the previous worker version', async () => {
  await withTmpDir(async (root) => {
    const directory = await fixture(
      root,
      `import { text } from './lib/value.ts'; export default { id: 'demo', version: '1', tools: [${tool(`return { content: [{ type: 'text', text }] };`)}] };`,
      { 'lib/value.ts': `export const text: string = 'old';` },
      'plugin.ts',
    );
    const old = await loadPlugin({ directory, cwd: root, home: root, authorize: async () => true });
    try {
      await writeFile(join(directory, 'lib/value.ts'), `export const text: string = 'new';`);
      const current = await loadPlugin({ directory, cwd: root, home: root, authorize: async () => true });
      try {
        assert.notEqual(old.fingerprint, current.fingerprint);
        assert.equal((await old.tools![0]!.execute({}, context(root))).content[0]!.type, 'text');
        assert.deepEqual((await old.tools![0]!.execute({}, context(root))).content, [{ type: 'text', text: 'old' }]);
        assert.deepEqual((await current.tools![0]!.execute({}, context(root))).content, [
          { type: 'text', text: 'new' },
        ]);
      } finally {
        await current.dispose?.();
      }
    } finally {
      await old.dispose?.();
    }
  });
});

test('plugin contributions are namespaced and all RPC operations retain their inputs', async () => {
  await withTmpDir(async (root) => {
    const directory = await fixture(
      root,
      `export default {
        id: 'demo', version: '1',
        tools: [${tool(`ctx.onUpdate('partial'); return { content: [{ type: 'text', text: args.text + ':' + ctx.cwd + ':' + ctx.signal.aborted }] };`)}],
        context: [{ id: 'files', async provide(ctx) { return ctx.prompt; } }],
        memory: [{ id: 'notes', async recall(ctx) { return ctx.messages.length + ':notes'; }, async remember(ctx, reason) { if (reason !== 'done') throw new Error('wrong reason'); } }],
        prompts: { guide: 'Be precise' },
        hooks: [{ id: 'policy', async beforeTool(call, metadata) { if (metadata.execute !== undefined) throw new Error('function leaked'); return { action: call.args.deny ? 'deny' : 'allow', reason: 'denied' }; },
          async afterTool(call, metadata, result) { return { ...result, details: metadata.name }; },
          async onStop(last) { return { action: 'continue', message: last.model }; } }]
      };`,
    );
    const plugin = await loadPlugin({ directory, cwd: root, home: root, authorize: async () => true });
    try {
      const external = plugin.tools![0]!;
      assert.equal(external.name, 'demo__echo');
      assert.deepEqual((external as typeof external & { external: unknown }).external, {
        pluginId: 'demo',
        fingerprint: plugin.fingerprint,
      });
      const updates: string[] = [];
      const result = await external.execute(
        { text: 'yes' },
        { ...context(root), onUpdate: (text) => updates.push(text) },
      );
      assert.deepEqual(result.content, [{ type: 'text', text: 'yes:' + root + ':false' }]);
      assert.deepEqual(updates, ['partial']);
      assert.equal(plugin.context![0]!.id, 'demo/files');
      assert.equal(await plugin.context![0]!.provide(context(root)), 'hello');
      assert.equal(plugin.memory![0]!.id, 'demo/notes');
      assert.equal(await plugin.memory![0]!.recall(context(root)), '0:notes');
      await plugin.memory![0]!.remember!(context(root), 'done');
      assert.deepEqual(plugin.prompts, { 'demo/guide': 'Be precise' });
      assert.equal(plugin.hooks![0]!.id, 'demo/policy');
      const call = { type: 'toolCall' as const, id: 'call', name: external.name, args: { deny: true } };
      assert.deepEqual(await plugin.hooks![0]!.beforeTool!(call, external), { action: 'deny', reason: 'denied' });
      assert.equal((await plugin.hooks![0]!.afterTool!(call, external, result)).details, external.name);
      assert.deepEqual(
        await plugin.hooks![0]!.onStop!({
          role: 'assistant',
          content: [],
          stopReason: 'end',
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          model: 'fake',
          provider: 'anthropic',
        }),
        { action: 'continue', message: 'fake' },
      );
    } finally {
      await plugin.dispose?.();
    }
  });
});

test('plugin manifests reject escapes, duplicates, unlisted modules and symlinks without executing', async () => {
  await withTmpDir(async (root) => {
    const directory = await fixture(root, base);
    const manifest = join(directory, 'mh-plugin.json');
    for (const files of [['../outside.mjs'], ['plugin.mjs', './plugin.mjs'], ['resource.txt']]) {
      await writeFile(manifest, JSON.stringify({ id: 'demo', version: '1', module: 'plugin.mjs', files }));
      assert.throws(() => inspectPlugin(directory), /escapes|Duplicate|included/);
    }
    await writeFile(
      manifest,
      JSON.stringify({ id: 'demo', version: '1', module: 'linked/plugin.mjs', files: ['linked/plugin.mjs'] }),
    );
    await symlink(directory, join(directory, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => inspectPlugin(directory), /symlinks/);
  });
});

test('plugin changes during authorization and tampered immutable snapshots are rejected', async () => {
  await withTmpDir(async (root) => {
    const directory = await fixture(root, base);
    await assert.rejects(
      loadPlugin({
        directory,
        cwd: root,
        home: root,
        authorize: async () => {
          await writeFile(join(directory, 'plugin.mjs'), base + '\n// changed');
          return true;
        },
      }),
      /changed during authorization/,
    );
    const plugin = await loadPlugin({ directory, cwd: root, home: root, authorize: async () => true });
    await plugin.dispose?.();
    await writeFile(join(root, 'runtime', 'plugins', plugin.fingerprint, 'plugin.mjs'), base + '\n// tampered');
    await assert.rejects(
      loadPlugin({ directory, cwd: root, home: root, authorize: async () => true }),
      /authorized fingerprint/,
    );
  });
});

test('plugin snapshots reject undeclared files added to an existing generation', async () => {
  await withTmpDir(async (root) => {
    const directory = await fixture(root, base, {}, 'plugin.js');
    const plugin = await loadPlugin({ directory, cwd: root, home: root, authorize: async () => true });
    await plugin.dispose?.();
    await writeFile(join(root, 'runtime', 'plugins', plugin.fingerprint, 'undeclared.js'), 'export default 1;');
    await assert.rejects(
      loadPlugin({ directory, cwd: root, home: root, authorize: async () => true }),
      /outside its authorized manifest/,
    );
  });
});

test('plugin validation rejects unsupported fields, duplicate contributions and built-in tool names', async () => {
  await withTmpDir(async (root) => {
    for (const addition of [
      `unexpected: true`,
      `tools: [${tool('', 'read')}]`,
      `tools: [${tool()}, ${tool()}]`,
      `hooks: [{ id: 'bad', beforeModel() {} }]`,
      `tools: [{ ...${tool()}, parameters: { type: 'object', inventedKeyword: true } }]`,
      `context: [{ id: 'same', provide() {} }, { id: 'same', provide() {} }]`,
    ]) {
      const directory = await fixture(root, `export default { id: 'demo', version: '1', ${addition} };`);
      await assert.rejects(
        loadPlugin({ directory, cwd: root, home: root, authorize: async () => true }),
        /Unsupported|Reserved|Duplicate/,
      );
    }
    const directory = await fixture(root, `export default { id: 'other', version: '1' };`);
    await assert.rejects(loadPlugin({ directory, cwd: root, home: root, authorize: async () => true }), /must match/);
  });
});

test('plugin initialization errors, timeouts and premature exits release their workers', async () => {
  await withTmpDir(async (root) => {
    for (const [source, expected] of [
      [`throw new Error('load failure');`, /load failure/],
      [`await new Promise(() => {}); ${base}`, /initialization timed out|exited unexpectedly/],
      [`process.exit(2); ${base}`, /exited unexpectedly/],
    ] as const) {
      const directory = await fixture(root, source);
      await assert.rejects(
        loadPlugin({ directory, cwd: root, home: root, authorize: async () => true, timeoutMs: 300 }),
        expected,
      );
    }
  });
});

test('plugin initialization can be aborted while a module is awaiting', async () => {
  await withTmpDir(async (root) => {
    const directory = await fixture(root, `await new Promise(() => {}); ${base}`);
    const controller = new AbortController();
    const loading = loadPlugin({
      directory,
      cwd: root,
      home: root,
      authorize: async () => true,
      signal: controller.signal,
    });
    const timer = setTimeout(() => controller.abort(), 100);
    try {
      await assert.rejects(loading, /aborted/);
    } finally {
      clearTimeout(timer);
    }
  });
});

test('plugin RPC propagates errors and aborts and bounds unresponsive operations', async () => {
  await withTmpDir(async (root) => {
    const directory = await fixture(
      root,
      `export default { id: 'demo', version: '1', tools: [${tool(`
      if (args.fail) throw new Error('execution failure');
      if (args.hang) return await new Promise(() => {});
      return await new Promise(resolve => ctx.signal.addEventListener('abort', () => resolve({ content: [{ type: 'text', text: 'cancelled' }] }), { once: true }));
    `)}] };`,
    );
    const plugin = await loadPlugin({ directory, cwd: root, home: root, authorize: async () => true, timeoutMs: 300 });
    try {
      await assert.rejects(plugin.tools![0]!.execute({ fail: true }, context(root)), /execution failure/);
      const controller = new AbortController();
      const pending = plugin.tools![0]!.execute({}, context(root, controller.signal));
      controller.abort();
      await assert.rejects(pending, /aborted/);
      await assert.rejects(plugin.tools![0]!.execute({ hang: true }, context(root)), /timed out/);
    } finally {
      await plugin.dispose?.();
    }
  });
});

test('plugin dispose runs cleanup, terminates timers and remains idempotent after failures', async () => {
  await withTmpDir(async (root) => {
    const marker = join(root, 'disposed');
    const directory = await fixture(
      root,
      `import { writeFileSync } from 'node:fs'; setInterval(() => {}, 1000);
      export default { id: 'demo', version: '1', tools: [${tool()}], async dispose() { writeFileSync(${JSON.stringify(marker)}, 'done'); throw new Error('dispose failure'); } };`,
    );
    const plugin = await loadPlugin({ directory, cwd: root, home: root, authorize: async () => true });
    await assert.rejects(plugin.dispose!(), /dispose failure/);
    assert.equal(await readFile(marker, 'utf8'), 'done');
    await plugin.dispose?.();
    await assert.rejects(plugin.tools![0]!.execute({}, context(root)), /disposed/);
  });
});

test('plugin output and request sizes are bounded without forwarding plugin stdout to the terminal', async () => {
  await withTmpDir(async (root) => {
    const directory = await fixture(
      root,
      `export default { id: 'demo', version: '1', tools: [${tool(`
      process.stdout.write('x'.repeat(1024 * 1024 + 1));
      await new Promise(() => {});
    `)}] };`,
    );
    const plugin = await loadPlugin({ directory, cwd: root, home: root, authorize: async () => true });
    try {
      await assert.rejects(
        plugin.tools![0]!.execute({ text: 'x'.repeat(1024 * 1024) }, context(root)),
        /request exceeds/,
      );
      await assert.rejects(plugin.tools![0]!.execute({}, context(root)), /stdout\/stderr exceeded/);
    } finally {
      await plugin.dispose?.();
    }
  });
});

test('plugin pending operation limits still permit forced disposal and settle every caller', async () => {
  await withTmpDir(async (root) => {
    const directory = await fixture(
      root,
      `export default { id: 'demo', version: '1', tools: [${tool(`await new Promise(() => {});`)}] };`,
    );
    const plugin = await loadPlugin({ directory, cwd: root, home: root, authorize: async () => true });
    const pending = Array.from({ length: 64 }, () => plugin.tools![0]!.execute({}, context(root)));
    const settled = Promise.allSettled(pending);
    await assert.rejects(plugin.tools![0]!.execute({}, context(root)), /too many pending/);
    await assert.rejects(plugin.dispose!(), /too many pending/);
    assert.equal(
      (await settled).every((result) => result.status === 'rejected'),
      true,
    );
  });
});
