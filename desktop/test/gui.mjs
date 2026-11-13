/**
 * Native Electron GUI acceptance, using only Node's standard library and CDP.
 * Windows PowerShell (desktop/): node test/gui.mjs [--exe <packaged executable>]
 * Every launch uses a temporary MH_HOME/project/cache and a loopback-only SSE fixture.
 * Artifacts and retained temporary paths are recorded under .codex/desktop-mvp-checks/.
 */
import assert from 'node:assert/strict';
import { spawn, execFileSync, execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { inflateSync } from 'node:zlib';

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repository = resolve(desktop, '..');
const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
let packagedExecutable;
for (let index = 0; index < args.length; index++) {
  if (args[index] !== '--exe' || !args[index + 1])
    throw new Error('Usage: node test/gui.mjs [--exe <packaged executable>]');
  packagedExecutable = resolve(args[++index]);
}
assert.ok(Number(process.versions.node.split('.')[0]) >= 24, 'GUI checks require native Node >=24');
assert.equal(typeof WebSocket, 'function', 'Node must provide the standard WebSocket client');

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const mode = packagedExecutable ? 'packaged' : 'source';
const artifactDirectory = join(repository, '.codex', 'desktop-mvp-checks');
const artifactBase = join(artifactDirectory, `gui-${mode}-${stamp}`);
const fakeKey = `gui-only-fake-${randomUUID()}`;
const report = {
  startedAt: new Date().toISOString(),
  mode,
  executable: packagedExecutable ?? null,
  node: process.versions.node,
  checks: [],
  screenshots: [],
  rendererExceptions: [],
  externalRendererRequests: [],
  requests: [],
  temporaryDirectoriesRetained: true,
};
const redact = (value) => String(value).replaceAll(fakeKey, '[fake-key-redacted]');
let currentApp;
let fixture;
let temporary;
let launchCount = 0;

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(label, predicate, timeout = 25000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    if (currentApp?.exited && !currentApp.stopping)
      throw new Error(`Electron exited while waiting for ${label}: ${redact(currentApp.log.slice(-5000))}`);
    try {
      const result = await predicate();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await delay(80);
  }
  throw new Error(`Timed out: ${label}${lastError ? `; ${redact(lastError.message)}` : ''}`);
}

async function check(name, run) {
  const started = Date.now();
  try {
    const detail = await run();
    report.checks.push({ name, passed: true, durationMs: Date.now() - started, ...(detail ? { detail } : {}) });
    process.stdout.write(`PASS ${name}\n`);
    return detail;
  } catch (error) {
    report.checks.push({ name, passed: false, durationMs: Date.now() - started, error: redact(error.stack ?? error) });
    throw error;
  }
}

function assertLoopback(url) {
  const parsed = new URL(url);
  assert.equal(parsed.hostname, '127.0.0.1', 'Acceptance network must remain on 127.0.0.1');
  return parsed;
}

class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Map();
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== undefined) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`));
        else pending.resolve(message.result ?? {});
      } else {
        for (const listener of this.listeners.get(message.method) ?? []) listener(message.params ?? {});
      }
    });
    socket.addEventListener('close', () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('CDP connection closed'));
      }
      this.pending.clear();
    });
  }
  static async connect(url) {
    assertLoopback(url);
    const socket = new WebSocket(url);
    await new Promise((resolveOpen, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP WebSocket open timed out')), 10000);
      socket.addEventListener(
        'open',
        () => {
          clearTimeout(timer);
          resolveOpen();
        },
        { once: true },
      );
      socket.addEventListener(
        'error',
        () => {
          clearTimeout(timer);
          reject(new Error('CDP WebSocket open failed'));
        },
        { once: true },
      );
    });
    return new Cdp(socket);
  }
  on(name, listener) {
    const listeners = this.listeners.get(name) ?? [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }
  send(method, params = {}, timeout = 20000) {
    const id = ++this.nextId;
    return new Promise((resolveResult, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out`));
      }, timeout);
      this.pending.set(id, { resolve: resolveResult, reject, timer, method });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    if (result.exceptionDetails)
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result?.value;
  }
  close() {
    this.socket.close();
  }
}

async function startFixture() {
  let scenario = 'idle';
  let step = 0;
  let releaseStream;
  let cancelledResponses = 0;
  const pendingResponses = new Set();
  const sockets = new Set();
  const emit = (response, data) => {
    if (!response.destroyed) response.write(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const begin = (response) => {
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    emit(response, {
      type: 'message_start',
      message: { usage: { input_tokens: 12, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    });
  };
  const text = (response, index, value) => {
    emit(response, { type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
    emit(response, { type: 'content_block_delta', index, delta: { type: 'text_delta', text: value } });
    emit(response, { type: 'content_block_stop', index });
  };
  const tool = (response, index, name, input) => {
    emit(response, {
      type: 'content_block_start',
      index,
      content_block: { type: 'tool_use', id: `${scenario}-${index}`, name, input: {} },
    });
    const raw = JSON.stringify(input);
    const middle = Math.floor(raw.length / 2);
    for (const partial of [raw.slice(0, middle), raw.slice(middle)])
      emit(response, {
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: partial },
      });
    emit(response, { type: 'content_block_stop', index });
  };
  const finish = (response, reason) => {
    emit(response, { type: 'message_delta', delta: { stop_reason: reason }, usage: { output_tokens: 9 } });
    emit(response, { type: 'message_stop' });
    response.end();
  };
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/v1/messages');
      assert.equal(request.headers['x-api-key'], fakeKey, 'Host must use the in-memory test credential');
      let raw = '';
      for await (const chunk of request) raw += String(chunk);
      assert.ok(raw.length < 2_000_000);
      const body = JSON.parse(raw);
      const content = (body.messages ?? []).flatMap((message) => message.content ?? []);
      const results = content.filter((block) => block.type === 'tool_result');
      const strings = content.filter((block) => block.type === 'text').map((block) => block.text ?? '');
      const item = {
        scenario,
        step: step++,
        model: body.model,
        thinking: body.thinking ?? null,
        toolNames: (body.tools ?? []).map((entry) => entry.name),
        toolResults: results.map((entry) => ({
          id: entry.tool_use_id,
          isError: !!entry.is_error,
          text: (entry.content ?? []).map((block) => block.text ?? '').join(''),
        })),
        steeringObserved: strings.some((value) => value.includes('GUI_STEER_NEXT_INPUT')),
      };
      report.requests.push(item);
      assert.equal(body.model, 'gui-acceptance-model');
      assert.equal(body.stream, true);
      begin(response);
      if (scenario === 'readwrite' && item.step === 0) {
        assert.equal(
          body.thinking?.budget_tokens,
          24576,
          'Deep thinking selection must reach the actual provider body',
        );
        emit(response, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
        emit(response, {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'GUI_STREAM_VISIBLE：正在读取本地文件。' },
        });
        await new Promise((release) => {
          releaseStream = release;
        });
        if (response.destroyed) return;
        emit(response, { type: 'content_block_stop', index: 0 });
        tool(response, 1, 'read', { path: 'input 中文.txt' });
        tool(response, 2, 'write', { path: 'generated 中文.txt', content: 'GUI_REAL_WRITE_OK\n' });
        finish(response, 'tool_use');
      } else if (scenario === 'readwrite' && item.step === 1) {
        assert.ok(
          results.some((entry) => JSON.stringify(entry).includes('GUI_REAL_READ_SEED')),
          'The second provider call must carry the real read result',
        );
        assert.ok(results.some((entry) => JSON.stringify(entry).includes('generated 中文.txt')));
        assert.ok(item.steeringObserved, 'UI steering must be consumed by the real agent loop');
        text(response, 0, 'GUI_READ_WRITE_DONE');
        finish(response, 'end_turn');
      } else if ((scenario === 'approve' || scenario === 'deny') && item.step === 0) {
        tool(response, 0, 'write', {
          path: scenario === 'approve' ? '../approved.txt' : '../denied.txt',
          content: 'GUI_OUTSIDE_WRITE\n',
        });
        finish(response, 'tool_use');
      } else if ((scenario === 'approve' || scenario === 'deny') && item.step === 1) {
        assert.ok(results.length > 0);
        assert.equal(
          results.at(-1).is_error === true,
          scenario === 'deny',
          'The permission decision must reach the real tool result',
        );
        text(response, 0, scenario === 'approve' ? 'GUI_APPROVAL_DONE' : 'GUI_DENIAL_DONE');
        finish(response, 'end_turn');
      } else if (scenario === 'cancel' && item.step === 0) {
        pendingResponses.add(response);
        response.once('close', () => {
          pendingResponses.delete(response);
          cancelledResponses++;
        });
        emit(response, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
        emit(response, {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'GUI_CANCEL_WAITING' },
        });
      } else throw new Error(`Unexpected fixture request: ${scenario}/${item.step}`);
    } catch (error) {
      report.fixtureError = redact(error.stack ?? error);
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'text/plain' });
      response.end('GUI fixture assertion failed');
    }
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    url: `http://127.0.0.1:${address.port}`,
    select(name) {
      assert.equal(pendingResponses.size, 0);
      scenario = name;
      step = 0;
    },
    release() {
      assert.equal(typeof releaseStream, 'function');
      releaseStream();
      releaseStream = undefined;
    },
    get cancelledResponses() {
      return cancelledResponses;
    },
    async close() {
      releaseStream?.();
      for (const response of pendingResponses) response.destroy();
      for (const socket of sockets) socket.destroy();
      await new Promise((resolveClose) => server.close(resolveClose));
    },
  };
}

async function launch() {
  const executable = packagedExecutable ?? require('electron');
  await access(executable);
  const childEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !/(?:key|token|secret|password|credential|auth)/i.test(key) &&
        !['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS'].includes(key),
    ),
  );
  // Each process receives a fresh browser cache. Agent history/connection
  // metadata stay in MH_HOME; stale DevToolsActivePort files cannot select a
  // previous process's now-closed debugging endpoint during restart checks.
  const cache = join(temporary, `app cache 中文 ${++launchCount}`);
  report.cacheDirectories ??= [];
  report.cacheDirectories.push(cache);
  const flags = [
    '--mh-test',
    '--project',
    report.project,
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0',
    `--user-data-dir=${cache}`,
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--no-first-run',
  ];
  const child = spawn(executable, [...(packagedExecutable ? [] : [desktop]), ...flags], {
    cwd: desktop,
    windowsHide: true,
    detached: process.platform !== 'win32',
    env: { ...childEnvironment, MH_HOME: report.home, MH_DESKTOP_USER_DATA: cache },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const app = { child, log: '', exited: false, stopping: false, cdp: undefined };
  app.exit = new Promise((resolveExit) => {
    child.once('exit', (code, signal) => {
      app.exited = true;
      app.exitInfo = { code, signal };
      resolveExit(app.exitInfo);
    });
  });
  child.once('error', (error) => {
    app.log += `\n${error.message}`;
    app.exited = true;
  });
  for (const stream of [child.stdout, child.stderr])
    stream?.on('data', (chunk) => {
      app.log = (app.log + String(chunk)).slice(-60000);
    });
  currentApp = app;
  const port = await waitFor('loopback DevTools endpoint', async () => {
    const found = app.log.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
    if (found) return Number(found[1]);
    const activePort = join(cache, 'DevToolsActivePort');
    if (await exists(activePort)) {
      const value = Number((await readFile(activePort, 'utf8')).split('\n')[0]);
      if (Number.isInteger(value) && value > 0) return value;
    }
    return false;
  });
  const targetsUrl = `http://127.0.0.1:${port}/json/list`;
  assertLoopback(targetsUrl);
  const target = await waitFor('actual application renderer', async () => {
    const response = await fetch(targetsUrl);
    const targets = await response.json();
    return targets.find(
      (entry) => entry.type === 'page' && entry.url.startsWith('file:') && entry.webSocketDebuggerUrl,
    );
  });
  app.targetId = target.id;
  app.cdp = await Cdp.connect(target.webSocketDebuggerUrl);
  app.cdp.on('Runtime.exceptionThrown', ({ exceptionDetails }) =>
    report.rendererExceptions.push(redact(exceptionDetails.exception?.description ?? exceptionDetails.text)),
  );
  app.cdp.on('Network.requestWillBeSent', ({ request }) => {
    if (/^https?:/.test(request.url) && new URL(request.url).hostname !== '127.0.0.1')
      report.externalRendererRequests.push(request.url);
  });
  await app.cdp.send('Page.enable');
  await app.cdp.send('Runtime.enable');
  await app.cdp.send('Network.enable');
  // Keep the native Windows DPI. Overriding deviceScaleFactor then bringing a
  // hidden window forward can make CDP input and DOM coordinates disagree.
  await ready();
  await showOwnedTestWindow(app);
  return app;
}

async function showOwnedTestWindow(app) {
  if (process.platform !== 'win32') return;
  assert.ok(Number.isSafeInteger(app.child.pid) && app.child.pid > 0);
  // The caller authorizes showing only this test-created Electron window.
  // EnumWindows includes hidden windows; match both our PID and app title.
  // SW_SHOWNOACTIVATE paints its native surface without stealing focus.
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class MhOwnedGuiWindow {
  private delegate bool Visitor(IntPtr hwnd, IntPtr state);
  [DllImport("user32.dll")] private static extern bool EnumWindows(Visitor visitor, IntPtr state);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int count);
  [DllImport("user32.dll")] private static extern bool ShowWindowAsync(IntPtr hwnd, int command);
  public static int Show(int ownedProcessId) {
    int shown = 0;
    EnumWindows((hwnd, state) => {
      uint processId;
      GetWindowThreadProcessId(hwnd, out processId);
      if (processId != (uint)ownedProcessId) return true;
      var title = new StringBuilder(256);
      GetWindowText(hwnd, title, title.Capacity);
      if (!String.Equals(title.ToString(), "mini-harness", StringComparison.Ordinal)) return true;
      ShowWindowAsync(hwnd, 4);
      shown++;
      return true;
    }, IntPtr.Zero);
    return shown;
  }
}
'@
$shownCount = [MhOwnedGuiWindow]::Show(${app.child.pid})
@{ processId = ${app.child.pid}; shown = $shownCount; command = 'SW_SHOWNOACTIVATE' } | ConvertTo-Json -Compress
`;
  const result = await promisify(execFile)(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { windowsHide: true, timeout: 15000 },
  );
  const shown = JSON.parse(result.stdout.trim());
  assert.ok(shown.shown >= 1, 'No owned mini-harness native window was found');
  report.nativeTestWindows ??= [];
  report.nativeTestWindows.push(shown);
}

const evaluate = (expression) => currentApp.cdp.evaluate(expression);
const snapshot = () => evaluate('window.mh.request({method:"snapshot"})');
async function ready() {
  await waitFor('renderer bridge and native project', async () => {
    if (!(await evaluate('typeof window.mh?.request === "function" && !!document.querySelector(".composer textarea")')))
      return false;
    const state = await snapshot();
    return (
      state.project?.path === report.project &&
      (await evaluate('document.querySelector(".project-label")?.textContent.includes("GUI 项目 空格")'))
    );
  });
}
async function waitSnapshot(label, predicate) {
  return waitFor(label, async () => {
    const state = await snapshot();
    return predicate(state) ? state : false;
  });
}

async function clickExpression(expression) {
  const position = await evaluate(
    `(() => { const element = (${expression}); if (!element) throw new Error('UI target not found'); if (element.disabled) throw new Error('UI target is disabled'); element.scrollIntoView({block:'center',inline:'center'}); const rect = element.getBoundingClientRect(); if (!rect.width || !rect.height) throw new Error('UI target is not visible'); return {x:rect.left+rect.width/2,y:rect.top+rect.height/2}; })()`,
  );
  await evaluate(`(() => {
    const expected = (${expression});
    window.__mhGuiClick = null;
    document.addEventListener('click', event => {
      window.__mhGuiClick = {
        expected: event.composedPath().includes(expected),
        target: event.target.closest('button')?.className ?? event.target.tagName,
        text: event.target.closest('button')?.textContent.trim(),
        trusted: event.isTrusted, x: event.clientX, y: event.clientY,
        viewport: { width: innerWidth, height: innerHeight, ratio: devicePixelRatio, scrollX, scrollY },
      };
    }, { capture: true, once: true });
  })()`);
  await currentApp.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...position });
  await currentApp.cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    button: 'left',
    clickCount: 1,
    ...position,
  });
  await currentApp.cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    button: 'left',
    clickCount: 1,
    ...position,
  });
  const click = await waitFor('native click delivery', () => evaluate('window.__mhGuiClick'), 2000);
  report.clicks ??= [];
  report.clicks.push({ requested: expression, position, ...click });
  assert.equal(click.expected, true, `Native click missed its UI target: ${JSON.stringify(click)}`);
}
const click = (selector) => clickExpression(`document.querySelector(${JSON.stringify(selector)})`);
const buttonText = (text, scope = 'document') =>
  clickExpression(
    `[...(${scope}).querySelectorAll('button')].find(button => button.textContent.trim() === ${JSON.stringify(text)})`,
  );

async function fillExpression(expression, value) {
  await evaluate(
    `(() => { const input = (${expression}); if (!input) throw new Error('Input not found'); input.focus(); input.select(); })()`,
  );
  await currentApp.cdp.send('Input.insertText', { text: value });
  assert.equal(await evaluate(`(${expression}).value`), value);
}
const fill = (selector, value) => fillExpression(`document.querySelector(${JSON.stringify(selector)})`, value);
const fieldExpression = (label) =>
  `[...document.querySelectorAll('dialog label')].find(label => label.textContent.trim().startsWith(${JSON.stringify(label)}))?.querySelector('input,select')`;

async function select(selector, value) {
  await evaluate(
    `(() => { const input=document.querySelector(${JSON.stringify(selector)}); if(!input || input.disabled) throw new Error('Select unavailable'); const setter=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set; setter.call(input,${JSON.stringify(value)}); input.dispatchEvent(new Event('change',{bubbles:true})); })()`,
  );
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(selector)}).value`), value);
}

async function saveConnection(name, supportsThinking) {
  await click('.sidebar-footer .button');
  await waitFor('native connection dialog', () =>
    evaluate('!!document.querySelector("dialog.connection-dialog[open]")'),
  );
  await fillExpression(fieldExpression('连接名称'), name);
  await fillExpression(fieldExpression('模型 ID'), 'gui-acceptance-model');
  await fillExpression(fieldExpression('服务地址'), fixture.url);
  await fillExpression(fieldExpression('API Key'), fakeKey);
  if (supportsThinking)
    await clickExpression(
      `[...document.querySelectorAll('dialog label')].find(label => label.textContent.includes('声明此连接支持可调思考')).querySelector('input')`,
    );
  await click('dialog button[type="submit"]');
  await waitFor('connection saved by UI', () => evaluate('!document.querySelector("dialog[open]")'));
  const state = await waitSnapshot('saved connection capability and credentials', (next) =>
    next.models.some((model) => model.name === name && model.credentialReady),
  );
  const model = state.models.find((item) => item.name === name);
  assert.equal(model.supportsThinking, supportsThinking);
  assert.equal(JSON.stringify(state).includes(fakeKey), false);
  return model;
}

async function submit(prompt) {
  await fill('#prompt', prompt);
  await waitFor('enabled task submit', () => evaluate('!document.querySelector(".send-button").disabled'));
  await click('.send-button');
  await waitFor('submitted prompt acknowledged', () => evaluate('document.querySelector("#prompt").value === ""'));
}

async function startUiRun(name, prompt) {
  fixture.select(name);
  const previous = (await snapshot()).run?.id;
  await submit(prompt);
  return waitSnapshot(`new ${name} run`, (state) => !!state.run && state.run.id !== previous);
}

function screenshotContent(bytes) {
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'Capture must be a PNG');
  let width;
  let height;
  let channels;
  const compressed = [];
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const size = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const chunk = bytes.subarray(offset + 8, offset + 8 + size);
    if (type === 'IHDR') {
      width = chunk.readUInt32BE(0);
      height = chunk.readUInt32BE(4);
      assert.equal(chunk[8], 8, 'Capture must use 8-bit PNG channels');
      assert.ok([2, 6].includes(chunk[9]), 'Capture must use RGB or RGBA pixels');
      assert.equal(chunk[12], 0, 'Capture must be noninterlaced');
      channels = chunk[9] === 6 ? 4 : 3;
    } else if (type === 'IDAT') compressed.push(chunk);
    offset += size + 12;
  }
  assert.ok(width > 0 && height > 0 && width * height < 20_000_000);
  const stride = width * channels;
  const inflated = inflateSync(Buffer.concat(compressed), { maxOutputLength: (stride + 1) * height });
  assert.equal(inflated.length, (stride + 1) * height);
  let previous = Buffer.alloc(stride);
  const colors = new Set();
  let minimum = 255;
  let maximum = 0;
  let visible = 0;
  let nonblack = 0;
  let sampled = 0;
  const sampleEvery = Math.max(1, Math.floor((width * height) / 120000));
  const paeth = (left, above, upperLeft) => {
    const prediction = left + above - upperLeft;
    const a = Math.abs(prediction - left),
      b = Math.abs(prediction - above),
      c = Math.abs(prediction - upperLeft);
    return a <= b && a <= c ? left : b <= c ? above : upperLeft;
  };
  for (let y = 0; y < height; y++) {
    const start = y * (stride + 1);
    const filter = inflated[start];
    assert.ok(filter <= 4, 'Unknown PNG scanline filter');
    const row = Buffer.allocUnsafe(stride);
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? row[x - channels] : 0;
      const above = previous[x];
      const upperLeft = x >= channels ? previous[x - channels] : 0;
      const predictor =
        filter === 0
          ? 0
          : filter === 1
            ? left
            : filter === 2
              ? above
              : filter === 3
                ? Math.floor((left + above) / 2)
                : paeth(left, above, upperLeft);
      row[x] = (inflated[start + 1 + x] + predictor) & 255;
    }
    for (let x = 0; x < width; x++) {
      if ((y * width + x) % sampleEvery) continue;
      sampled++;
      const at = x * channels;
      const [red, green, blue] = row.subarray(at, at + 3);
      if (channels === 4 && row[at + 3] < 200) continue;
      visible++;
      if (red + green + blue > 45) nonblack++;
      const luminance = Math.round(0.2126 * red + 0.7152 * green + 0.0722 * blue);
      minimum = Math.min(minimum, luminance);
      maximum = Math.max(maximum, luminance);
      colors.add(((red >> 3) << 10) | ((green >> 3) << 5) | (blue >> 3));
    }
    previous = row;
  }
  const stats = {
    width,
    height,
    colors: colors.size,
    contrast: maximum - minimum,
    visibleFraction: visible / sampled,
    nonblackFraction: nonblack / sampled,
  };
  assert.ok(
    stats.visibleFraction > 0.9 && stats.nonblackFraction > 0.1 && stats.colors >= 16 && stats.contrast >= 35,
    `Rejected blank/black capture: ${JSON.stringify(stats)}`,
  );
  return stats;
}

async function restoreCaptureWindow(name) {
  try {
    const { windowId } = await currentApp.cdp.send(
      'Browser.getWindowForTarget',
      { targetId: currentApp.targetId },
      2500,
    );
    await currentApp.cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } }, 2500);
    report.captureWindowRestored ??= [];
    report.captureWindowRestored.push(name);
  } catch (error) {
    report.captureWindowRestoreErrors ??= [];
    report.captureWindowRestoreErrors.push({ name, error: redact(error.message) });
  }
  await currentApp.cdp.send('Page.bringToFront');
}

async function screenshot(name) {
  if (!currentApp?.cdp || currentApp.exited) return;
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (attempt) await restoreCaptureWindow(name);
      const image = await currentApp.cdp.send(
        'Page.captureScreenshot',
        {
          format: 'png',
          captureBeyondViewport: false,
          fromSurface: true,
        },
        7000,
      );
      const bytes = Buffer.from(image.data, 'base64');
      const content = screenshotContent(bytes);
      const file = `${artifactBase}-${name}.png`;
      await writeFile(file, bytes);
      report.screenshots.push(file);
      report.screenshotContent ??= [];
      report.screenshotContent.push({ name, file, attempt: attempt + 1, ...content });
      return;
    } catch (error) {
      lastError = error;
      report.screenshotRetries ??= [];
      report.screenshotRetries.push({ name, attempt: attempt + 1, reason: redact(error.message) });
    }
  }
  throw lastError;
}

async function stopApplication(app) {
  if (!app || app.exited) {
    app?.cdp?.close();
    return;
  }
  app.stopping = true;
  try {
    const state = await app.cdp?.evaluate('window.mh.request({method:"snapshot"})');
    if (state?.run && ['running', 'thinking', 'waitingApproval', 'cancelling'].includes(state.run.status)) {
      await app.cdp.evaluate(`window.mh.request({method:'cancel',runId:${JSON.stringify(state.run.id)}})`);
    }
    await app.cdp?.evaluate('window.close()').catch(() => {});
    await Promise.race([
      app.exit,
      delay(30000, undefined, { ref: false }).then(() => {
        throw new Error('Graceful Electron shutdown timed out');
      }),
    ]);
    report.shutdowns ??= [];
    report.shutdowns.push({ graceful: true, ...app.exitInfo });
  } catch (error) {
    report.shutdowns ??= [];
    report.shutdowns.push({ graceful: false, error: redact(error.message) });
    if (!app.exited) {
      if (process.platform === 'win32')
        await promisify(execFile)('taskkill', ['/PID', String(app.child.pid), '/T', '/F'], { windowsHide: true }).catch(
          () => {},
        );
      else {
        try {
          process.kill(-app.child.pid, 'SIGTERM');
        } catch {
          /* It already exited. */
        }
      }
      await Promise.race([app.exit, delay(5000, undefined, { ref: false })]);
    }
    throw error;
  } finally {
    app.cdp?.close();
  }
}

async function main() {
  await mkdir(artifactDirectory, { recursive: true });
  temporary = await mkdtemp(join(tmpdir(), 'mh-desktop-gui-'));
  report.home = join(temporary, 'MH home 中文');
  report.project = join(temporary, 'GUI 项目 空格');
  await mkdir(report.home, { recursive: true });
  await mkdir(report.project, { recursive: true });
  await writeFile(join(report.project, 'input 中文.txt'), 'GUI_REAL_READ_SEED\n');
  await writeFile(join(report.project, 'tracked.txt'), 'BASELINE_TRACKED\n');
  const gitEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/^GIT_(?:DIR|WORK_TREE|INDEX_FILE|CONFIG|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES)/.test(key),
    ),
  );
  const git = (arguments_) =>
    execFileSync('git', ['-C', report.project, '-c', 'core.hooksPath=', ...arguments_], {
      env: gitEnvironment,
      windowsHide: true,
      stdio: 'pipe',
    });
  git(['init', '--initial-branch=main']);
  git(['add', '--', 'tracked.txt', 'input 中文.txt']);
  git([
    '-c',
    'user.name=GUI Acceptance',
    '-c',
    'user.email=gui@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-m',
    'Temporary GUI acceptance baseline',
  ]);
  await writeFile(join(report.project, 'tracked.txt'), 'BASELINE_TRACKED\nUSER_EXISTING_CHANGE\n');
  await writeFile(join(report.project, 'untracked gui.txt'), 'USER_UNTRACKED_FILE\n');
  fixture = await startFixture();
  report.fixtureUrl = fixture.url;
  await check('real Electron renderer and temporary native project', async () => {
    await launch();
    return { project: (await snapshot()).project, bridge: true };
  });
  await check(
    'connection form rejects mixed-up fields before persistence and preserves an unsent password',
    async () => {
      const initial = await snapshot();
      const metadataFile = join(report.home, 'desktop-connections.json');
      const invalidModel = 'https://example.invalid/step_plan';
      await click('.sidebar-footer .button');
      await waitFor('connection dialog for field validation', () =>
        evaluate('!!document.querySelector("dialog[open]")'),
      );
      assert.equal(await evaluate('document.querySelector("input[name=authenticationMode][value=key]").checked'), true);
      assert.equal(await evaluate('!!document.querySelector("input[name=apiKeyEnv]")'), false);
      await fillExpression(fieldExpression('连接名称'), 'GUI 认证修正');
      await fillExpression(fieldExpression('模型 ID'), invalidModel);
      await fillExpression(fieldExpression('服务地址'), 'not-a-service-url');
      await fillExpression(fieldExpression('API Key'), fakeKey);
      await click('dialog button[type="submit"]');
      await waitFor('model and URL errors shown together', () =>
        evaluate('document.querySelectorAll("dialog input[aria-invalid=true]").length === 2'),
      );
      assert.equal(await evaluate('document.activeElement.name'), 'model');
      assert.equal(await evaluate('document.querySelector("input[name=apiKey]").value'), fakeKey);
      assert.equal(await exists(metadataFile), false);
      assert.equal((await snapshot()).seq, initial.seq);
      assert.equal(report.requests.length, 0);
      await click('input[name="authenticationMode"][value="env"]');
      assert.equal(await evaluate('!!document.querySelector("input[name=apiKey]")'), false);
      await fillExpression(fieldExpression('密钥环境变量名'), fakeKey);
      await click('dialog button[type="submit"]');
      await waitFor('all three field errors shown together', () =>
        evaluate('document.querySelectorAll("dialog input[aria-invalid=true]").length === 3'),
      );
      assert.equal(await evaluate('document.activeElement.name'), 'model');
      const errors = await evaluate(
        '[...document.querySelectorAll(".field-error")].map(node => node.textContent).join("\\n")',
      );
      assert.equal(errors.includes(fakeKey), false);
      assert.equal(errors.includes(invalidModel), false);
      assert.equal(await exists(metadataFile), false);
      assert.equal((await snapshot()).seq, initial.seq);
      await fillExpression(fieldExpression('模型 ID'), 'gui-acceptance-model');
      await fillExpression(fieldExpression('服务地址'), fixture.url);
      await fillExpression(fieldExpression('密钥环境变量名'), 'STEP_API_KEY');
      await click('input[name="authenticationMode"][value="key"]');
      await fillExpression(fieldExpression('API Key'), fakeKey);
      await click('dialog button[type="submit"]');
      await waitFor('corrected connection saved', () => evaluate('!document.querySelector("dialog[open]")'));
      const saved = await waitSnapshot('corrected connection ready', (state) =>
        state.models.some((model) => model.name === 'GUI 认证修正' && model.credentialReady),
      );
      const corrected = saved.models.find((model) => model.name === 'GUI 认证修正');
      assert.equal(Object.hasOwn(corrected, 'apiKeyEnv'), false);
      const stored = await readFile(metadataFile, 'utf8');
      assert.equal(stored.includes(fakeKey), false);
      assert.equal(stored.includes(invalidModel), false);
      assert.equal(
        JSON.parse(stored).some((connection) => Object.hasOwn(connection, 'apiKeyEnv')),
        false,
      );
      return {
        invalidFields: 3,
        unsentPasswordPreserved: true,
        invalidMetadataAbsent: true,
        keyModeDropsOldEnvironmentReference: true,
      };
    },
  );
  await check('connection form saves metadata without persisting its key', async () => {
    const adjustable = await saveConnection('GUI 可调思考', true);
    const fixed = await saveConnection('GUI 默认思考', false);
    report.modelId = adjustable.id;
    await select('.select-control:not(.effort-select) select', adjustable.id);
    await select('.effort-select select', 'high');
    await select('.select-control:not(.effort-select) select', fixed.id);
    assert.equal(await evaluate('document.querySelector(".effort-select select").disabled'), true);
    assert.equal(await evaluate('document.querySelector(".effort-select select").value'), 'off');
    await select('.select-control:not(.effort-select) select', adjustable.id);
    assert.equal(await evaluate('document.querySelector(".effort-select select").value'), 'high');
    const metadata = await readFile(join(report.home, 'desktop-connections.json'), 'utf8');
    assert.equal(metadata.includes(fakeKey), false);
    assert.equal(
      Object.values(JSON.parse(metadata)).some((item) => Object.hasOwn(item, 'apiKey')),
      false,
    );
    return { savedConnections: 2, inMemoryCredential: true, defaultAndRememberedThinking: true };
  });
  let originalSession;
  await check('UI streaming, frozen run configuration, steering and real read/write tools', async () => {
    const started = await startUiRun(
      'readwrite',
      'GUI_READ_WRITE：读取 input 中文.txt，写入 generated 中文.txt，然后汇总结果。',
    );
    originalSession = started.selectedSessionId;
    assert.equal(started.run.thinking, 'high');
    await waitFor('real SSE text visible before completion', () =>
      evaluate('document.querySelector(".streaming .message-text")?.textContent.includes("GUI_STREAM_VISIBLE")'),
    );
    assert.equal(await exists(join(report.project, 'generated 中文.txt')), false);
    await select('.effort-select select', 'low');
    assert.equal((await snapshot()).run.thinking, 'high');
    await submit('GUI_STEER_NEXT_INPUT：保留读取和写入的结果。');
    assert.equal(report.requests.filter((item) => item.scenario === 'readwrite').length, 1);
    fixture.release();
    const ended = await waitSnapshot(
      'read/write run completed',
      (state) => state.run?.id === started.run.id && state.run.status === 'completed',
    );
    assert.equal(await readFile(join(report.project, 'generated 中文.txt'), 'utf8'), 'GUI_REAL_WRITE_OK\n');
    assert.ok(ended.activities.some((item) => item.name === 'read' && item.status === 'completed'));
    assert.ok(ended.activities.some((item) => item.name === 'write' && item.status === 'completed'));
    assert.equal(ended.run.verification, 'notConfigured');
    assert.equal(await evaluate('document.querySelector(".verification").textContent'), '未配置结束检查');
    assert.equal(await evaluate('document.querySelector(".effort-select select").value'), 'low');
    await screenshot('read-write');
    return {
      sessionId: originalSession,
      runId: ended.run.id,
      tools: ended.activities.map((item) => ({ name: item.name, status: item.status })),
      verification: ended.run.verification,
    };
  });
  await check('working tree review includes existing tracked and untracked changes', async () => {
    await buttonText('查看变更');
    await waitSnapshot('Git review captured', (state) => !!state.review?.available);
    await waitFor('actual diff and untracked names rendered', () =>
      evaluate(
        'document.querySelector(".review-diff")?.textContent.includes("USER_EXISTING_CHANGE") && document.querySelector(".review-summary")?.textContent.includes("untracked gui.txt") && document.querySelector(".review-summary")?.textContent.includes("generated 中文.txt")',
      ),
    );
    assert.equal(await evaluate('document.querySelector(".review-scope").textContent.includes("已有的修改")'), true);
    await screenshot('review');
    await click('[aria-label="关闭变更面板"]');
    return { scope: 'workingTree', containsUserChanges: true, untrackedListed: true };
  });
  await check('outside-workspace approval allows exactly once through the UI', async () => {
    const started = await startUiRun('approve', 'GUI_APPROVE：写入上级目录 approved.txt。');
    await waitSnapshot(
      'outside write awaiting approval',
      (state) => state.run?.status === 'waitingApproval' && state.approvals.length === 1,
    );
    assert.equal(await exists(join(temporary, 'approved.txt')), false);
    await waitFor('approval card visible', () => evaluate('!!document.querySelector(".approval-card")'));
    await screenshot('approval');
    await buttonText('允许本次', 'document.querySelector(".approval-card")');
    const ended = await waitSnapshot(
      'approved write completed',
      (state) => state.run?.id === started.run.id && state.run.status === 'completed',
    );
    assert.equal(await readFile(join(temporary, 'approved.txt'), 'utf8'), 'GUI_OUTSIDE_WRITE\n');
    assert.equal(ended.approvals.length, 0);
    return { runId: ended.run.id, approvedFileExists: true };
  });
  await check('next outside write asks again and UI denial prevents the real write', async () => {
    const started = await startUiRun('deny', 'GUI_DENY：尝试写入上级目录 denied.txt。');
    await waitSnapshot(
      'once did not become session-wide permission',
      (state) => state.run?.status === 'waitingApproval' && state.approvals.length === 1,
    );
    await waitFor('second approval card visible', () => evaluate('!!document.querySelector(".approval-card")'));
    await buttonText('拒绝', 'document.querySelector(".approval-card")');
    const ended = await waitSnapshot(
      'denied tool run completed',
      (state) => state.run?.id === started.run.id && state.run.status === 'completed',
    );
    assert.equal(await exists(join(temporary, 'denied.txt')), false);
    assert.ok(ended.activities.some((item) => item.name === 'write' && item.status === 'failed'));
    return { runId: ended.run.id, deniedFileAbsent: true };
  });
  await check('renderer reload preserves active run without duplicate model calls; stop cancels SSE', async () => {
    const started = await startUiRun('cancel', 'GUI_CANCEL：保持连接，等待我停止。');
    await waitFor('blocked SSE visible', () =>
      evaluate('document.querySelector(".streaming .message-text")?.textContent.includes("GUI_CANCEL_WAITING")'),
    );
    const calls = report.requests.length;
    await currentApp.cdp.send('Page.reload', { ignoreCache: true });
    await ready();
    await waitFor('active output restored after reload', () =>
      evaluate('document.querySelector(".streaming .message-text")?.textContent.includes("GUI_CANCEL_WAITING")'),
    );
    assert.equal((await snapshot()).run.id, started.run.id);
    assert.equal(report.requests.length, calls);
    await click('.stop-button');
    const ended = await waitSnapshot(
      'host confirms cancelled terminal state',
      (state) => state.run?.id === started.run.id && state.run.status === 'cancelled',
    );
    await waitFor('SSE request actually closed', () => fixture.cancelledResponses > 0);
    await waitFor('cancelled text rendered', () =>
      evaluate('document.querySelector(".run-state")?.textContent.includes("已中断")'),
    );
    assert.ok(['incomplete', 'notConfigured'].includes(ended.run.verification));
    assert.equal(ended.approvals.length, 0);
    assert.equal(report.requests.length, calls);
    await screenshot('cancelled');
    return {
      runId: ended.run.id,
      callsBeforeAndAfterReload: calls,
      cancelledSseConnections: fixture.cancelledResponses,
    };
  });
  await check('new and historical sessions use actual persisted conversations', async () => {
    const calls = report.requests.length;
    await click('.new-session');
    await waitSnapshot(
      'new session created by sidebar',
      (state) => !!state.selectedSessionId && state.selectedSessionId !== originalSession && !state.messages.length,
    );
    await clickExpression(
      `[...document.querySelectorAll('.session')].find(button => button.title.includes('GUI_READ_WRITE'))`,
    );
    const state = await waitSnapshot(
      'historical session reopened',
      (next) =>
        next.selectedSessionId === originalSession &&
        next.messages.some((message) => message.text.includes('GUI_READ_WRITE_DONE')),
    );
    assert.equal(report.requests.length, calls);
    await waitFor('history is actually rendered', () =>
      evaluate('document.querySelector(".transcript")?.textContent.includes("GUI_READ_WRITE_DONE")'),
    );
    return { originalSession, savedMessages: state.messages.length, noModelReplay: true };
  });
  await check('process restart restores metadata/history while memory-only credentials are gone', async () => {
    const calls = report.requests.length;
    await stopApplication(currentApp);
    await launch();
    const state = await snapshot();
    assert.ok(state.models.length >= 2);
    assert.ok(state.models.every((model) => !model.credentialReady));
    await clickExpression(
      `[...document.querySelectorAll('.session')].find(button => button.title.includes('GUI_READ_WRITE'))`,
    );
    await waitSnapshot(
      'history after process restart',
      (next) =>
        next.selectedSessionId === originalSession &&
        next.messages.some((message) => message.text.includes('GUI_READ_WRITE_DONE')),
    );
    await waitFor('restart history rendered without credential', () =>
      evaluate(
        'document.querySelector(".transcript")?.textContent.includes("GUI_READ_WRITE_DONE") && document.querySelector(".composer-caption")?.textContent.includes("缺少密钥")',
      ),
    );
    assert.equal(report.requests.length, calls);
    await screenshot('restart-history');
    return { metadataPreserved: true, credentialsReset: true, noModelReplay: true };
  });
  assert.equal(report.fixtureError, undefined, report.fixtureError);
  assert.deepEqual(report.rendererExceptions, [], 'Renderer must not throw uncaught exceptions');
  assert.deepEqual(report.externalRendererRequests, [], 'Renderer must not contact remote services');
  report.passed = true;
}

try {
  await main();
} catch (error) {
  report.passed = false;
  report.error = redact(error.stack ?? error);
  try {
    await screenshot('failure');
    report.failureText = redact(await evaluate('document.body.innerText'));
  } catch {
    /* Renderer may have exited. */
  }
  process.stderr.write(`${report.error}\n`);
  process.exitCode = 1;
} finally {
  try {
    await stopApplication(currentApp);
  } catch (error) {
    report.passed = false;
    report.cleanupError = redact(error.stack ?? error);
    process.exitCode = 1;
  }
  if (currentApp) report.appLog = redact(currentApp.log);
  if (fixture) await fixture.close();
  report.finishedAt = new Date().toISOString();
  await mkdir(artifactDirectory, { recursive: true });
  await writeFile(`${artifactBase}.json`, JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(`${report.passed ? 'PASS' : 'FAIL'} GUI acceptance: ${artifactBase}.json\n`);
  if (temporary) process.stdout.write(`Temporary evidence retained: ${temporary}\n`);
}
