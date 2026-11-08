import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startRun } from '../../src/app/run.ts';
import { defaultConfig, loadConfig } from '../../src/app/config.ts';
import { createSession } from '../../src/session/index.ts';
import { zeroUsage } from '../../src/ai/index.ts';
import { afterEditHook } from '../../src/hooks/after-edit.ts';
import { createWriteTool, createEditTool } from '../../src/tools/index.ts';
import { withTmpDir } from '../helpers/tmp.ts';
import { scripted } from '../helpers/fake-provider.ts';
import { withSSEServer, sse } from '../helpers/sse-server.ts';
import { spawn } from 'node:child_process';
test('session approval persists across user turns and resets for a new session', async () =>
  withTmpDir(async (d) => {
    let asked = 0;
    const ask = async () => {
      asked++;
      return 'session' as const;
    };
    const p = scripted(
        { toolCalls: [{ name: 'bash', args: { command: 'echo "git reset --hard"' } }] },
        { text: 'one' },
        { toolCalls: [{ name: 'bash', args: { command: 'echo "git push --force"' } }] },
        { text: 'two' },
        { toolCalls: [{ name: 'bash', args: { command: 'echo "git reset --hard"' } }] },
        { text: 'three' },
      ),
      base = { cwd: d, home: join(d, 'home'), config: defaultConfig(), provider: p, ask };
    const first = await startRun({ ...base, prompt: 'first' });
    await startRun({ ...base, prompt: 'second', session: first.session });
    assert.equal(asked, 1);
    await startRun({ ...base, prompt: 'new' });
    assert.equal(asked, 2);
  }));
test('resume repairs tool calls interrupted by a process crash', async () =>
  withTmpDir(async (d) => {
    const home = join(d, 'home'),
      s = createSession(home, d);
    s.append({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'read' }] } });
    s.append({
      type: 'message',
      message: {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'pending', name: 'read', args: { path: 'a' } }],
        stopReason: 'toolUse',
        usage: zeroUsage(),
        model: 'test',
        provider: 'anthropic',
      },
    });
    const p = scripted((req) => {
      assert.ok(req.messages.some((m) => m.role === 'toolResult' && m.toolCallId === 'pending' && m.isError));
      return { text: 'recovered' };
    });
    const r = await startRun({ cwd: d, home, session: s, config: defaultConfig(), prompt: 'continue', provider: p });
    assert.equal(r.reason, 'done');
    assert.ok(s.context().messages.some((m) => m.role === 'toolResult'));
  }));
test('after-edit resolves a relative file from the agent cwd while running at project root', async () =>
  withTmpDir(async (d) => {
    const sub = join(d, 'sub');
    await mkdir(sub);
    const hook = afterEditHook({
      cwd: d,
      fileCwd: sub,
      commands: [{ command: "node -e \"require('fs').writeFileSync('seen',process.env.MH_FILE)\"" }],
      signal: new AbortController().signal,
    });
    await hook.afterTool!({ type: 'toolCall', id: 'a', name: 'write', args: { path: 'a.ts' } }, createWriteTool(''), {
      content: [],
    });
    assert.equal(await readFile(join(d, 'seen'), 'utf8'), join(sub, 'a.ts'));
  }));
test('edits the first line of a BOM file using text copied from read', async () =>
  withTmpDir(async (d) => {
    const path = join(d, 'bom.txt');
    await writeFile(path, '\uFEFFconst x = 1;\r\n');
    await createEditTool('').execute(
      { path, oldText: '\uFEFFconst x = 1;', newText: 'const x = 2;' },
      { cwd: d, sessionDir: d, signal: new AbortController().signal },
    );
    assert.equal(await readFile(path, 'utf8'), '\uFEFFconst x = 2;\r\n');
  }));
test('provider programming errors leave an error trace before propagating', async () =>
  withTmpDir(async (d) => {
    const session = createSession(d, d);
    await assert.rejects(
      () => startRun({ cwd: d, home: d, session, config: defaultConfig(), prompt: 'task', provider: scripted() }),
      /no more steps/,
    );
    assert.ok(session.entries().some((e) => e.type === 'trace' && e.name === 'agentEnd' && e.data.reason === 'error'));
  }));
test('incomplete pricing is rejected before it can produce NaN costs', async () =>
  withTmpDir(async (d) => {
    await writeFile(join(d, 'config.json'), JSON.stringify({ models: { test: { pricing: { input: 1 } } } }));
    assert.throws(() => loadConfig({ home: d, cwd: join(d, 'project') }), /pricing/);
  }));

test('resume restores the previous provider and model while allowing an explicit model override', async () =>
  withTmpDir(async (d) => {
    const home = join(d, 'home'),
      session = createSession(home, d);
    session.append({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'first' }] } });
    session.append({
      type: 'message',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'prior reply' }],
        stopReason: 'end',
        usage: zeroUsage(),
        model: 'prior-model',
        provider: 'openai',
      },
    });
    const received: string[] = [];
    await withSSEServer(
      (body, _, request) => {
        assert.equal(request.url, '/v1/responses');
        received.push((body as { model: string }).model);
        return {
          chunks: [
            sse({
              type: 'response.completed',
              response: {
                status: 'completed',
                output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }],
                usage: { input_tokens: 1, output_tokens: 1 },
              },
            }),
          ],
        };
      },
      async (url) => {
        for (const extra of [[], ['--model', 'explicit-model']]) {
          const child = spawn(process.execPath, ['src/cli/main.ts', '--cwd', d, '-c', '-p', 'continue', ...extra], {
            env: {
              ...process.env,
              MH_HOME: home,
              OPENAI_API_KEY: 'fixture-only',
              OPENAI_BASE_URL: url,
              ANTHROPIC_API_KEY: '',
              ANTHROPIC_AUTH_TOKEN: '',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
          });
          let output = '';
          child.stdout.on('data', (c) => (output += c));
          child.stderr.on('data', (c) => (output += c));
          const status = await new Promise<number | null>((resolve, reject) => {
            child.on('error', reject);
            child.on('close', resolve);
          });
          assert.equal(status, 0, output);
        }
      },
    );
    assert.deepEqual(received, ['prior-model', 'explicit-model']);
  }));
