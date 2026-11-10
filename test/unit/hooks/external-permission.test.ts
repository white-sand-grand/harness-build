import test from 'node:test';
import assert from 'node:assert/strict';
import type { Tool } from '../../../src/agent/index.ts';
import { runAgent } from '../../../src/agent/index.ts';
import { resolveModel } from '../../../src/ai/index.ts';
import { composeHooks } from '../../../src/hooks/compose.ts';
import { permissionHook } from '../../../src/hooks/permission.ts';
import { scripted } from '../../helpers/fake-provider.ts';
import { withTmpDir } from '../../helpers/tmp.ts';

const external: Tool = {
  name: 'lookup',
  description: 'A plugin tool claiming to be read-only',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  readOnly: true,
  external: { pluginId: 'research', fingerprint: 'version-one' },
  async execute() {
    return { content: [] };
  },
};
const call = (name = external.name) => ({ type: 'toolCall' as const, id: 'call', name, args: {} });

test('external readOnly declarations do not bypass approval while built-in readOnly behavior is preserved', async () =>
  withTmpDir(async (root) => {
    const hook = permissionHook({ mode: 'ask', root, allowedDirs: [], extraPatterns: [] });
    const denied = await hook.beforeTool!(call(), external);
    assert.equal(denied.action, 'deny');
    assert.match(denied.action === 'deny' ? denied.reason : '', /external tools require approval.*no user/i);
    assert.equal((await hook.beforeTool!(call(), { ...external, external: undefined })).action, 'allow');
  }));

test('once approval is requested again and the prompt identifies the external implementation', async () =>
  withTmpDir(async (root) => {
    const prompts: { title: string; detail: string }[] = [];
    const approvals = new Set<string>();
    const hook = permissionHook({
      mode: 'ask',
      root,
      allowedDirs: [],
      extraPatterns: [],
      approvals,
      ask: async (prompt) => {
        prompts.push(prompt);
        return 'once';
      },
    });
    assert.equal((await hook.beforeTool!(call(), external)).action, 'allow');
    assert.equal((await hook.beforeTool!(call(), external)).action, 'allow');
    assert.equal(prompts.length, 2);
    assert.match(prompts[0]?.title ?? '', /lookup/);
    assert.match(prompts[0]?.detail ?? '', /research.*version-one/s);
    assert.equal(approvals.size, 0);
  }));

test('session approval is shared only for the same plugin fingerprint and tool name', async () =>
  withTmpDir(async (root) => {
    const approvals = new Set<string>();
    let asked = 0;
    const options = {
      mode: 'ask' as const,
      root,
      allowedDirs: [],
      extraPatterns: [],
      approvals,
      ask: async () => {
        asked++;
        return 'session' as const;
      },
    };
    assert.equal((await permissionHook(options).beforeTool!(call(), external)).action, 'allow');
    assert.equal((await permissionHook(options).beforeTool!(call(), external)).action, 'allow');
    assert.equal(asked, 1);
    for (const tool of [
      { ...external, external: { pluginId: 'research', fingerprint: 'version-two' } },
      { ...external, name: 'other' },
      { ...external, external: { pluginId: 'different', fingerprint: 'version-one' } },
    ])
      assert.equal((await permissionHook(options).beforeTool!(call(tool.name), tool)).action, 'allow');
    assert.equal(asked, 4);
    assert.equal(
      (await permissionHook({ ...options, approvals: new Set(), ask: undefined }).beforeTool!(call(), external)).action,
      'deny',
    );
  }));

test('external tools are denied in every restricted operation before yolo or saved approvals', async () =>
  withTmpDir(async (root) => {
    const approvals = new Set<string>();
    const options = {
      mode: 'ask' as const,
      root,
      allowedDirs: [],
      extraPatterns: [],
      approvals,
      ask: async () => 'session' as const,
    };
    await permissionHook(options).beforeTool!(call(), external);
    let asked = false;
    for (const restrictions of [{ strictReadRoots: [] }, { strictWriteRoots: [root] }, { strictWritePaths: [] }]) {
      const hook = permissionHook({
        ...options,
        ...restrictions,
        mode: 'yolo',
        ask: async () => {
          asked = true;
          return 'once';
        },
      });
      for (const tool of [external, { ...external, name: 'read' }]) {
        const decision = await hook.beforeTool!(call(tool.name), tool);
        assert.equal(decision.action, 'deny');
        assert.match(decision.action === 'deny' ? decision.reason : '', /restricted operations/);
      }
    }
    assert.equal(asked, false);
  }));

test('yolo permits unrestricted external tools without requesting approval', async () =>
  withTmpDir(async (root) => {
    const hook = permissionHook({ mode: 'yolo', root, allowedDirs: [], extraPatterns: [] });
    assert.equal((await hook.beforeTool!(call(), external)).action, 'allow');
  }));

test('a denied external tool cannot be revived by a later permissive hook', async () =>
  withTmpDir(async (root) => {
    let executed = false;
    let laterCalled = false;
    const provider = scripted({ toolCalls: [{ name: external.name, args: {} }] }, { text: 'denied safely' });
    const messages: import('../../../src/ai/index.ts').Message[] = [];
    const reason = await runAgent(
      {
        provider,
        model: resolveModel('test', {}, 'anthropic'),
        system: 'system',
        tools: [{ ...external, execute: async () => ((executed = true), { content: [] }) }],
        hooks: composeHooks(
          permissionHook({
            mode: 'ask',
            root,
            allowedDirs: [],
            extraPatterns: [],
            ask: async () => 'deny',
          }),
          {
            async beforeTool() {
              laterCalled = true;
              return { action: 'allow' };
            },
          },
        ),
      },
      messages,
      { signal: new AbortController().signal, onEvent: () => {} },
    );
    assert.equal(reason, 'done');
    assert.equal(executed, false);
    assert.equal(laterCalled, false);
    assert.ok(messages.some((message) => message.role === 'toolResult' && message.isError));
    assert.match(JSON.stringify(messages), /user denied this action/);
  }));
