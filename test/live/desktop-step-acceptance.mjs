/**
 * Packaged native Windows acceptance against the real Step Messages endpoint.
 * Input: exactly one stdin JSON object { apiKey }; never pass credentials in argv/env.
 * This live-path script deliberately has no model/SSE fixture. It is not run by pnpm test.
 */
import { spawn, execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile, readdir, access, chmod, stat, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, relative, isAbsolute, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { inflateSync } from 'node:zlib';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const options = {};
for (let index = 2; index < process.argv.length; index += 2) {
  const flag = process.argv[index],
    value = process.argv[index + 1];
  if (!['--exe', '--resume'].includes(flag) || !value || Object.hasOwn(options, flag))
    throw new Error(
      'Usage: node test/live/desktop-step-acceptance.mjs [--exe <packaged executable>] [--resume <sanitized report>]',
    );
  options[flag] = resolve(value);
}
const executable = options['--exe'] ?? join(repository, 'desktop/release/v0.1.1/win-unpacked/mini-harness.exe');
const resumePath = options['--resume'];
const artifactDirectory = join(repository, '.codex/desktop-step-acceptance');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const artifactBase = join(artifactDirectory, 'step-live-' + stamp);
const limits = { runs: 2, runMs: 180000, assistantResponses: 8, reportedTokens: 60000, overallMs: 450000 };
const busy = (run) => run && ['running', 'thinking', 'waitingApproval', 'cancelling'].includes(run.status);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fixtureInput = '19\n23\n';
const fixtureChecker = `const fs=require('node:fs');const assert=require('node:assert/strict');const values=fs.readFileSync('input.txt','utf8').trim().split(/\\s+/).map(Number);assert.deepEqual(values,[19,23]);const result=JSON.parse(fs.readFileSync('result.json','utf8'));assert.equal(result.sum,values[0]+values[1]);assert.equal(result.sum,42);console.log('STEP_CHECK_OK 42');\n`;
async function hashFile(path) {
  const digest = createHash('sha256');
  for await (const bytes of createReadStream(path)) digest.update(bytes);
  return digest.digest('hex');
}
const report = {
  startedAt: new Date().toISOString(),
  provider: 'anthropic',
  model: 'step-5-preview',
  baseUrl: 'https://api.stepfun.com/step_plan',
  executable,
  limits,
  checks: [],
  runs: [],
  screenshots: [],
  visualPending: [],
  usageIsReportedOnly: true,
  inFlightOrUnreportedUsageNotEstimated: true,
};
let apiKey = '';
let app;
let temporary;
let sessionFile;
let stage = 'stdin';
let expired = false;
let globalTimer;
let checkerHash;
let inputHash;
let secondApproved = false;
let rendererSecretVerified = false;
let snapshotSecretVerified = false;

class AcceptanceError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}
function requireTrue(value, code) {
  if (!value) throw new AcceptanceError(code);
}
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
  while (Date.now() < deadline) {
    if (expired) throw new AcceptanceError('OVERALL_TIMEOUT');
    if (app?.exited && !app.stopping) throw new AcceptanceError('APPLICATION_EXITED');
    const result = await predicate();
    if (result) return result;
    await delay(80);
  }
  throw new AcceptanceError('TIMEOUT_' + label);
}
async function check(name, action) {
  stage = name;
  const started = Date.now();
  process.stdout.write(JSON.stringify({ type: 'progress', stage: name, status: 'started' }) + '\n');
  try {
    const detail = await action();
    report.checks.push({ name, passed: true, durationMs: Date.now() - started, ...(detail ? { detail } : {}) });
    process.stdout.write(JSON.stringify({ type: 'progress', stage: name, status: 'passed' }) + '\n');
    return detail;
  } catch (error) {
    report.checks.push({
      name,
      passed: false,
      durationMs: Date.now() - started,
      code: error instanceof AcceptanceError ? error.code : 'CHECK_FAILED',
    });
    throw error;
  }
}
async function stdinKey() {
  const chunks = [];
  let bytes = 0;
  let payload;
  const timer = setTimeout(() => process.stdin.destroy(new AcceptanceError('STDIN_TIMEOUT')), 20000);
  try {
    for await (const chunk of process.stdin) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      requireTrue(bytes <= 40000, 'STDIN_TOO_LARGE');
      chunks.push(buffer);
    }
    const buffer = Buffer.concat(chunks);
    try {
      payload = JSON.parse(buffer.toString('utf8'));
    } catch {
      throw new AcceptanceError('INVALID_STDIN_JSON');
    } finally {
      buffer.fill(0);
    }
    requireTrue(
      payload &&
        typeof payload === 'object' &&
        !Array.isArray(payload) &&
        Object.keys(payload).length === 1 &&
        typeof payload.apiKey === 'string',
      'INVALID_STDIN_CREDENTIAL',
    );
    const key = payload.apiKey.trim();
    requireTrue(key.length > 0 && key.length <= 32768 && !/[\r\n]/.test(key), 'INVALID_STDIN_CREDENTIAL');
    payload.apiKey = '';
    return key;
  } finally {
    clearTimeout(timer);
    for (const chunk of chunks) chunk.fill(0);
    payload = undefined;
  }
}
function safeEnvironment() {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) =>
        typeof value === 'string' &&
        /^(?:path|pathext|systemroot|systemdrive|windir|temp|tmp|userprofile|appdata|localappdata|programfiles(?:\(x86\))?|programw6432|commonprogramfiles(?:\(x86\))?|home|lang|lc_.*|tz|comspec|number_of_processors|processor_.*|os)$/i.test(
          key,
        ),
    ),
  );
}
function loopback(url) {
  const parsed = new URL(url);
  requireTrue(parsed.hostname === '127.0.0.1', 'NON_LOOPBACK_CDP');
}
class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.next = 0;
    this.pending = new Map();
    socket.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(new AcceptanceError('CDP_REQUEST_FAILED'));
      else request.resolve(message.result ?? {});
    });
    socket.addEventListener('close', () => {
      for (const request of this.pending.values()) {
        clearTimeout(request.timer);
        request.reject(new AcceptanceError('CDP_CLOSED'));
      }
      this.pending.clear();
    });
  }
  static async connect(url) {
    loopback(url);
    const socket = new WebSocket(url);
    await new Promise((resolveOpen, reject) => {
      const timer = setTimeout(() => reject(new AcceptanceError('CDP_OPEN_TIMEOUT')), 10000);
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
          reject(new AcceptanceError('CDP_OPEN_FAILED'));
        },
        { once: true },
      );
    });
    return new Cdp(socket);
  }
  send(method, params = {}, timeout = 15000) {
    const id = ++this.next;
    return new Promise((resolveResult, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AcceptanceError('CDP_TIMEOUT_' + method.replace(/[^A-Za-z0-9]/g, '_')));
      }, timeout);
      this.pending.set(id, { resolve: resolveResult, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression, timeout = 15000) {
    const result = await this.send(
      'Runtime.evaluate',
      {
        expression,
        returnByValue: true,
        awaitPromise: true,
        userGesture: true,
      },
      timeout,
    );
    if (result.exceptionDetails) throw new AcceptanceError('RENDERER_EVALUATION_FAILED');
    return result.result?.value;
  }
  async savePrivateConnection(connection, secret) {
    // Pass data as CDP arguments, never embed the key in executable source or persist its request.
    const object = await this.send('Runtime.evaluate', { expression: 'window', objectGroup: 'step-private-bootstrap' });
    try {
      const result = await this.send('Runtime.callFunctionOn', {
        objectId: object.result.objectId,
        functionDeclaration:
          'async function(connection, key) { try { const state = await window.mh.request({method:"saveConnection",connection,apiKey:key}); return {ready:state.models.some(model=>model.id===connection.id&&model.credentialReady)}; } finally { key=undefined; } }',
        arguments: [{ value: connection }, { value: secret }],
        returnByValue: true,
        awaitPromise: true,
        userGesture: true,
      });
      if (result.exceptionDetails) throw new AcceptanceError('PRIVATE_CONNECTION_SAVE_FAILED');
      requireTrue(result.result?.value?.ready, 'PRIVATE_CONNECTION_NOT_READY');
    } finally {
      await this.send('Runtime.releaseObjectGroup', { objectGroup: 'step-private-bootstrap' }).catch(() => {});
      secret = '';
    }
  }
  close() {
    this.socket.close();
  }
  async closeAndWait() {
    if (this.socket.readyState === 3) return true;
    return new Promise((resolveClosed) => {
      const timer = setTimeout(() => resolveClosed(false), 2000);
      this.socket.addEventListener(
        'close',
        () => {
          clearTimeout(timer);
          resolveClosed(true);
        },
        { once: true },
      );
      this.socket.close();
    });
  }
}
const evaluate = (expression, timeout) => app.cdp.evaluate(expression, timeout);
const snapshot = async (timeout) => {
  const state = await evaluate('window.mh.request({method:"snapshot"})', timeout);
  requireTrue(!JSON.stringify(state).includes(apiKey), 'SNAPSHOT_SECRET_EXPOSURE');
  snapshotSecretVerified = true;
  return state;
};
async function select(selector, value) {
  await evaluate(
    `(() => { const input=document.querySelector(${JSON.stringify(selector)}); if(!input||input.disabled) throw Error("select"); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,"value").set.call(input,${JSON.stringify(value)}); input.dispatchEvent(new Event("change",{bubbles:true})); })()`,
  );
  requireTrue(
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).value===${JSON.stringify(value)}`),
    'UI_SELECTION_FAILED',
  );
}
async function clickExpression(expression) {
  const at = await evaluate(
    `(() => { const button=(${expression}); if(!button||button.disabled) throw Error("button"); button.scrollIntoView({block:"center"}); const box=button.getBoundingClientRect(); if(!box.width||!box.height) throw Error("hidden"); return {x:box.left+box.width/2,y:box.top+box.height/2}; })()`,
  );
  await app.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...at });
  await app.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...at });
  await app.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...at });
}
async function submit(prompt) {
  await evaluate('(() => {const input=document.querySelector("#prompt");input.focus();input.select();})()');
  await app.cdp.send('Input.insertText', { text: prompt });
  await waitFor('SEND_ENABLED', () => evaluate('!document.querySelector(".send-button").disabled'));
  await clickExpression('document.querySelector(".send-button")');
  await waitFor('PROMPT_ACK', () => evaluate('document.querySelector("#prompt").value===""'));
}
async function ready() {
  return waitFor('RENDERER_READY', async () => {
    if (!(await evaluate('typeof window.mh?.request==="function"&&!!document.querySelector("#prompt")'))) return false;
    const state = await snapshot();
    return state.project?.path === report.project ? state : false;
  });
}
async function showOwnedWindow() {
  const program = `
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System; using System.Text; using System.Runtime.InteropServices;
public static class StepOwnedWindow {
 delegate bool Visitor(IntPtr window,IntPtr state);
 [DllImport("user32.dll")] static extern bool EnumWindows(Visitor visitor,IntPtr state);
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window,out uint pid);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr window,StringBuilder text,int size);
 [DllImport("user32.dll")] static extern bool ShowWindowAsync(IntPtr window,int command);
 public static int Show(int ownedPid) { int shown=0; EnumWindows((window,state)=>{uint pid;GetWindowThreadProcessId(window,out pid);if(pid!=(uint)ownedPid)return true;var title=new StringBuilder(256);GetWindowText(window,title,title.Capacity);if(title.ToString()!="mini-harness")return true;ShowWindowAsync(window,4);shown++;return true;},IntPtr.Zero);return shown; }
}
'@
[StepOwnedWindow]::Show(${app.child.pid})
`;
  const result = await promisify(execFile)(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(program, 'utf16le').toString('base64')],
    { windowsHide: true, timeout: 15000, env: safeEnvironment() },
  );
  requireTrue(Number(result.stdout.trim()) >= 1, 'OWNED_WINDOW_NOT_FOUND');
}
async function launch() {
  const cache = await mkdtemp(join(temporary, '浏览器缓存-'));
  report.cacheDirectory = cache;
  const child = spawn(
    executable,
    [
      '--mh-test',
      '--inspect=127.0.0.1:0',
      '--project',
      report.project,
      '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=0',
      '--user-data-dir=' + cache,
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--no-first-run',
    ],
    {
      cwd: dirname(executable),
      windowsHide: true,
      env: { ...safeEnvironment(), MH_HOME: report.home, MH_DESKTOP_USER_DATA: cache },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  app = { child, log: '', exited: false, stopping: false };
  app.exit = new Promise((resolveExit) =>
    child.once('exit', (code, signal) => {
      app.exited = true;
      app.exitInfo = { code, signal };
      resolveExit(app.exitInfo);
    }),
  );
  child.once('error', () => {
    app.exited = true;
  });
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', (bytes) => {
      app.log = (app.log + (apiKey ? String(bytes).replaceAll(apiKey, '[redacted]') : String(bytes))).slice(-12000);
    });
  const port = await waitFor('DEVTOOLS_PORT', async () => {
    const match = app.log.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
    if (match) return Number(match[1]);
    const file = join(cache, 'DevToolsActivePort');
    if (!(await exists(file))) return false;
    const value = Number((await readFile(file, 'utf8')).split('\n')[0]);
    return Number.isInteger(value) && value > 0 ? value : false;
  });
  const url = 'http://127.0.0.1:' + port + '/json/list';
  const target = await waitFor('APP_TARGET', async () => {
    const list = await (await fetch(url)).json();
    return list.find((item) => item.type === 'page' && item.url.startsWith('file:') && item.webSocketDebuggerUrl);
  });
  app.cdp = await Cdp.connect(target.webSocketDebuggerUrl);
  await app.cdp.send('Page.enable');
  await app.cdp.send('Runtime.enable');
  await ready();
  await showOwnedWindow();
}
async function noRendererSecret(timeout = 15000) {
  const view = await evaluate(
    '({text:document.body.textContent,values:[...document.querySelectorAll("input,textarea")].map(input=>input.value)})',
    timeout,
  );
  requireTrue(
    !view.text.includes(apiKey) && view.values.every((value) => !value.includes(apiKey)),
    'RENDERER_SECRET_EXPOSURE',
  );
  rendererSecretVerified = true;
  const state = await snapshot(timeout);
  requireTrue(!JSON.stringify(state).includes(apiKey), 'SNAPSHOT_SECRET_EXPOSURE');
  return state;
}
async function allFiles(root) {
  const result = [];
  for (const item of await readdir(root, { withFileTypes: true })) {
    const path = join(root, item.name);
    if (item.isDirectory()) result.push(...(await allFiles(path)));
    else if (item.isFile()) result.push(path);
  }
  return result;
}
async function entries() {
  if (!sessionFile) {
    const files = await allFiles(report.home);
    const candidates = files.filter((file) => file.endsWith('session.jsonl'));
    if (!candidates.length) return [];
    requireTrue(candidates.length === 1, 'UNEXPECTED_SESSION_COUNT');
    sessionFile = candidates[0];
  }
  const raw = await readFile(sessionFile, 'utf8');
  requireTrue(!raw.includes(apiKey), 'SESSION_SECRET_EXPOSURE');
  const lines = raw.split('\n');
  if (!raw.endsWith('\n')) lines.pop();
  return lines.filter(Boolean).map((line) => JSON.parse(line));
}
async function protectedAssets() {
  requireTrue(hash(await readFile(join(report.project, 'checker.js'))) === checkerHash, 'PROTECTED_CHECKER_CHANGED');
  requireTrue(hash(await readFile(join(report.project, 'input.txt'))) === inputHash, 'PROTECTED_INPUT_CHANGED');
}
function usageOf(records) {
  const turns = records.filter((entry) => entry.type === 'trace' && entry.name === 'turn');
  return {
    assistantResponses: records.filter((entry) => entry.type === 'message' && entry.message?.role === 'assistant')
      .length,
    reportedTokens: turns.reduce(
      (sum, entry) =>
        sum +
        ['input', 'output', 'cacheRead', 'cacheWrite'].reduce(
          (value, key) => value + (Number(entry.data.usage?.[key]) || 0),
          0,
        ),
      0,
    ),
    modelIds: [
      ...new Set(
        records
          .filter((entry) => entry.type === 'message' && entry.message?.role === 'assistant')
          .map((entry) => entry.message.model),
      ),
    ],
  };
}
async function cancelRun(runId) {
  try {
    await evaluate(`window.mh.request({method:"cancel",runId:${JSON.stringify(runId)}})`);
  } catch {
    await forceStop();
  }
}
async function monitor(started, baseEntryCount, number) {
  const startedAt = Date.now();
  const runId = started.run.id;
  while (true) {
    const state = await snapshot();
    await protectedAssets();
    const records = (await entries()).slice(baseEntryCount);
    const usage = usageOf(records);
    const reported = Math.max(usage.reportedTokens, (state.run?.inputTokens || 0) + (state.run?.outputTokens || 0));
    const totalReportedTokens = report.runs.reduce((sum, run) => sum + run.reportedTokens, 0) + reported;
    const reason =
      Date.now() - startedAt > limits.runMs
        ? 'RUN_TIMEOUT'
        : usage.assistantResponses > limits.assistantResponses ||
            (usage.assistantResponses === limits.assistantResponses && busy(state.run))
          ? 'ASSISTANT_RESPONSE_BUDGET'
          : totalReportedTokens > limits.reportedTokens
            ? 'REPORTED_TOKEN_BUDGET'
            : null;
    if (reason) {
      report.budgetStop = { run: number, reason };
      await cancelRun(runId);
      throw new AcceptanceError(reason);
    }
    requireTrue(state.run?.id === runId, 'RUN_ID_CHANGED');
    if (number === 2 && !secondApproved && (await exists(report.outsideFile)))
      throw new AcceptanceError('OUTSIDE_WRITE_BEFORE_APPROVAL');
    for (const approval of state.approvals) {
      const permitted =
        number === 2 &&
        !secondApproved &&
        approval.runId === runId &&
        approval.title.startsWith('Approve write: outside:') &&
        resolve(approval.detail).toLowerCase() === report.outsideFile.toLowerCase();
      if (!permitted) {
        await cancelRun(runId);
        throw new AcceptanceError('UNEXPECTED_APPROVAL');
      }
      requireTrue(!(await exists(report.outsideFile)), 'OUTSIDE_FILE_ALREADY_EXISTS');
      await waitFor('APPROVAL_CARD', () => evaluate('!!document.querySelector(".approval-card")'));
      await clickExpression(
        `(() => { const card=[...document.querySelectorAll(".approval-card")].find(card=>card.querySelector("h2")?.id===${JSON.stringify('approval-' + approval.id)}); return [...(card?.querySelectorAll(".approval-actions button")??[])].find(button=>button.textContent.trim()==="允许本次"); })()`,
      );
      secondApproved = true;
      report.approval = { decision: 'once', target: 'temporary sibling approved.txt', viaNativeUi: true };
    }
    if (!busy(state.run)) {
      requireTrue(state.run.status === 'completed', 'REAL_RUN_NOT_COMPLETED');
      requireTrue(state.run.verification === 'passed', 'REAL_RUN_VERIFICATION_NOT_PASSED');
      requireTrue(usage.modelIds.length === 1 && usage.modelIds[0] === report.model, 'ACTUAL_MODEL_MISMATCH');
      requireTrue(
        usage.assistantResponses > 0 && usage.assistantResponses <= limits.assistantResponses,
        'ASSISTANT_RESPONSE_BUDGET',
      );
      const summary = {
        number,
        runId,
        sessionId: state.run.sessionId,
        thinking: state.run.thinking,
        status: state.run.status,
        verification: state.run.verification,
        inputTokens: state.run.inputTokens,
        outputTokens: state.run.outputTokens,
        assistantResponses: usage.assistantResponses,
        reportedTokens: reported,
        elapsedMs: Date.now() - startedAt,
        activities: state.activities.map((activity) => ({
          name: activity.name,
          status: activity.status,
          durationMs: activity.durationMs,
        })),
        provenance: { executable, ...report.build },
      };
      report.runs.push(summary);
      return state;
    }
    await delay(80);
  }
}
function pngStats(bytes) {
  requireTrue(bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a', 'CAPTURE_NOT_PNG');
  let width, height, channels;
  const compressed = [];
  for (let at = 8; at + 12 <= bytes.length;) {
    const size = bytes.readUInt32BE(at),
      type = bytes.toString('ascii', at + 4, at + 8);
    const chunk = bytes.subarray(at + 8, at + 8 + size);
    if (type === 'IHDR') {
      width = chunk.readUInt32BE(0);
      height = chunk.readUInt32BE(4);
      requireTrue(chunk[8] === 8 && [2, 6].includes(chunk[9]) && chunk[12] === 0, 'CAPTURE_FORMAT');
      channels = chunk[9] === 6 ? 4 : 3;
    } else if (type === 'IDAT') compressed.push(chunk);
    at += size + 12;
  }
  requireTrue(width > 0 && height > 0 && width * height < 20000000, 'CAPTURE_SIZE');
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(compressed), { maxOutputLength: (stride + 1) * height });
  const colors = new Set();
  let previous = Buffer.alloc(stride),
    minimum = 255,
    maximum = 0;
  const paeth = (a, b, c) => {
    const p = a + b - c,
      x = Math.abs(p - a),
      y = Math.abs(p - b),
      z = Math.abs(p - c);
    return x <= y && x <= z ? a : y <= z ? b : c;
  };
  for (let y = 0; y < height; y++) {
    const row = Buffer.allocUnsafe(stride),
      start = y * (stride + 1),
      filter = raw[start];
    requireTrue(filter <= 4, 'CAPTURE_FILTER');
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? row[x - channels] : 0,
        above = previous[x],
        corner = x >= channels ? previous[x - channels] : 0;
      const predictor =
        filter === 0
          ? 0
          : filter === 1
            ? left
            : filter === 2
              ? above
              : filter === 3
                ? Math.floor((left + above) / 2)
                : paeth(left, above, corner);
      row[x] = (raw[start + 1 + x] + predictor) & 255;
    }
    if (y % 4 === 0)
      for (let x = 0; x < width; x += 4) {
        const at = x * channels,
          r = row[at],
          g = row[at + 1],
          b = row[at + 2];
        if (channels === 4 && row[at + 3] < 200) continue;
        colors.add(((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3));
        const brightness = Math.round((r + g + b) / 3);
        minimum = Math.min(minimum, brightness);
        maximum = Math.max(maximum, brightness);
      }
    previous = row;
  }
  requireTrue(colors.size >= 16 && maximum - minimum >= 35, 'CAPTURE_BLANK');
  return { width, height, colors: colors.size, contrast: maximum - minimum };
}
async function screenshot(name) {
  let lastCode = 'CAPTURE_FAILED';
  const inspectorUrl = app.log.match(/Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[^\s]+)/)?.[1];
  if (inspectorUrl) {
    let inspector;
    try {
      inspector = await Cdp.connect(inspectorUrl);
      app.mainInspector = inspector;
      const ownedWindow =
        'process.getBuiltinModule("module").createRequire(process.execPath)("electron").BrowserWindow.getAllWindows().find(window=>!window.isDestroyed()&&window.getTitle()==="mini-harness")';
      const readView =
        '({text:document.body.textContent,values:[...document.querySelectorAll("input,textarea")].map(input=>input.value)})';
      const view = await inspector.evaluate(
        `(async()=>{const window=${ownedWindow};if(!window)throw Error("owned window");return window.webContents.executeJavaScript(${JSON.stringify(readView)});})()`,
        5000,
      );
      requireTrue(
        !view.text.includes(apiKey) && view.values.every((value) => !value.includes(apiKey)),
        'RENDERER_SECRET_EXPOSURE',
      );
      rendererSecretVerified = true;
      const encoded = await inspector.evaluate(
        `(async()=>{const window=${ownedWindow};if(!window)throw Error("owned window");return(await window.webContents.capturePage()).toPNG().toString("base64");})()`,
        8000,
      );
      const bytes = Buffer.from(encoded, 'base64');
      const result = pngStats(bytes);
      const path = artifactBase + '-' + name + '.png';
      await writeFile(path, bytes);
      report.screenshots.push({
        name,
        path,
        ...result,
        capturedAt: new Date().toISOString(),
        source: 'current two-stage session after functional checks',
        captureMethod: 'owned main inspector capturePage',
        provenance: { executable, ...report.build },
      });
      return true;
    } catch (error) {
      if (error instanceof AcceptanceError && /SECRET_EXPOSURE$/.test(error.code)) throw error;
      lastCode = error instanceof AcceptanceError ? error.code : 'NATIVE_CAPTURE_FAILED';
    } finally {
      if (inspector && (await inspector.closeAndWait())) app.mainInspector = undefined;
    }
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      if (attempt) {
        await app.cdp.send('Page.bringToFront', {}, 3000);
        await delay(100);
      }
      // A transport timeout means no screenshot is saved, not that an exposure was found.
      await noRendererSecret(5000);
      const image = await app.cdp.send(
        'Page.captureScreenshot',
        { format: 'png', captureBeyondViewport: false, fromSurface: true },
        8000,
      );
      const bytes = Buffer.from(image.data, 'base64');
      const result = pngStats(bytes);
      const path = artifactBase + '-' + name + '.png';
      await writeFile(path, bytes);
      report.screenshots.push({
        name,
        path,
        ...result,
        capturedAt: new Date().toISOString(),
        source: resumePath && name === 'low-run-completed' ? 'restored first-run history' : 'current live acceptance',
        provenance: { executable, ...report.build },
      });
      return true;
    } catch (error) {
      if (
        error instanceof AcceptanceError &&
        ['RENDERER_SECRET_EXPOSURE', 'SNAPSHOT_SECRET_EXPOSURE'].includes(error.code)
      )
        throw error;
      lastCode = error instanceof AcceptanceError ? error.code : 'CAPTURE_FAILED';
    }
  }
  // Keep successful live-run evidence and continue bounded functional checks.
  // A later offline screenshot pass can fill the gap without rerunning a paid model.
  report.visualPending.push({ name, code: lastCode });
  return false;
}
async function forceStop() {
  if (!app || app.exited || !app.child.pid) return;
  await promisify(execFile)('taskkill', ['/PID', String(app.child.pid), '/T', '/F'], {
    windowsHide: true,
    timeout: 10000,
  }).catch(() => {});
}
async function closeApplication() {
  if (!app) return;
  app.stopping = true;
  try {
    if (app.mainInspector) {
      requireTrue(await app.mainInspector.closeAndWait(), 'MAIN_INSPECTOR_DISCONNECT_TIMEOUT');
      app.mainInspector = undefined;
    }
    if (!app.exited && app.cdp) {
      const state = await snapshot();
      if (busy(state.run)) await cancelRun(state.run.id);
      await evaluate('window.close()').catch(() => {});
    }
    await Promise.race([
      app.exit,
      delay(25000).then(() => {
        throw new AcceptanceError('GRACEFUL_EXIT_TIMEOUT');
      }),
    ]);
    requireTrue(app.exitInfo?.code === 0, 'APPLICATION_EXIT_NONZERO');
    report.applicationExit = { graceful: true, ...app.exitInfo };
  } catch {
    await forceStop();
    report.applicationExit = { graceful: false, ...(app.exitInfo || {}) };
    report.passed = false;
  } finally {
    app.cdp?.close();
    app.log = '';
  }
}
async function scanStoredSecrets() {
  const metadata = await readFile(join(report.home, 'desktop-connections.json'), 'utf8');
  requireTrue(!metadata.includes(apiKey), 'METADATA_SECRET_EXPOSURE');
  const saved = JSON.parse(metadata);
  requireTrue(
    saved.every((connection) => !Object.hasOwn(connection, 'apiKey') && !Object.hasOwn(connection, 'apiKeyEnv')),
    'CREDENTIAL_IN_METADATA',
  );
  for (const file of (await allFiles(report.home)).filter((path) => /\.(?:json|jsonl|md|txt)$/.test(path))) {
    const value = await readFile(file, 'utf8');
    requireTrue(!value.includes(apiKey), 'OWNED_HOME_SECRET_EXPOSURE');
  }
  return {
    body: rendererSecretVerified,
    snapshot: snapshotSecretVerified,
    connectionMetadata: true,
    session: true,
    ownedHomeTextFiles: true,
  };
}
function samePath(left, right) {
  return resolve(left).toLowerCase() === resolve(right).toLowerCase();
}
function within(parent, child) {
  const path = relative(resolve(parent), resolve(child));
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith('..\\') && !path.startsWith('../'));
}
async function prepareResume() {
  requireTrue(within(artifactDirectory, resumePath), 'RESUME_REPORT_OUTSIDE_ARTIFACTS');
  const raw = await readFile(resumePath, 'utf8');
  requireTrue(!raw.includes(apiKey), 'RESUME_REPORT_SECRET_EXPOSURE');
  const prior = JSON.parse(raw);
  requireTrue(
    prior.provider === report.provider && prior.model === report.model && prior.baseUrl === report.baseUrl,
    'RESUME_PROVIDER_MISMATCH',
  );
  requireTrue(Array.isArray(prior.runs) && prior.runs.length === 1, 'RESUME_REQUIRES_EXACTLY_ONE_COMPLETED_RUN');
  const first = prior.runs[0];
  requireTrue(
    first.number === 1 && first.thinking === 'low' && first.status === 'completed' && first.verification === 'passed',
    'RESUME_LOW_RUN_NOT_PASSED',
  );
  requireTrue(
    prior.checker?.exitCode === 0 &&
      prior.checker.sha256 === hash(fixtureChecker) &&
      prior.frozenThinking?.observedDuringRealRun === true,
    'RESUME_FIRST_RUN_EVIDENCE_INCOMPLETE',
  );
  temporary = dirname(resolve(prior.project));
  requireTrue(
    within(tmpdir(), temporary) && basename(temporary).startsWith('mh-step-desktop-live-'),
    'RESUME_NOT_OWNED_TEMP',
  );
  requireTrue(
    samePath(prior.project, join(temporary, '真实Step 项目 空格')) &&
      samePath(prior.home, join(temporary, '隔离MH_HOME')) &&
      samePath(prior.outsideFile, join(temporary, 'approved.txt')),
    'RESUME_FIXTURE_PATH_MISMATCH',
  );
  report.project = prior.project;
  report.home = prior.home;
  report.outsideFile = prior.outsideFile;
  requireTrue(
    samePath(await realpath(report.project), report.project) && samePath(await realpath(report.home), report.home),
    'RESUME_FIXTURE_LINK',
  );
  checkerHash = hash(fixtureChecker);
  inputHash = hash(fixtureInput);
  await protectedAssets();
  requireTrue(((await stat(join(report.project, 'checker.js'))).mode & 0o222) === 0, 'RESUME_CHECKER_NOT_READONLY');
  requireTrue(!(await exists(report.outsideFile)), 'RESUME_SECOND_RUN_ALREADY_STARTED');
  const records = await entries();
  requireTrue(records[0]?.type === 'header' && records[0].id === first.sessionId, 'RESUME_SESSION_MISMATCH');
  requireTrue(
    records.filter((entry) => entry.type === 'message' && entry.message?.role === 'user').length === 1,
    'RESUME_CONTAINS_ADDITIONAL_USER_RUN',
  );
  const ended = records.findLast((entry) => entry.type === 'trace' && entry.name === 'agentEnd');
  requireTrue(ended?.data.reason === 'done', 'RESUME_SESSION_NOT_COMPLETED');
  const usage = usageOf(records);
  requireTrue(
    usage.assistantResponses === first.assistantResponses &&
      usage.assistantResponses <= limits.assistantResponses &&
      Math.max(usage.reportedTokens, first.reportedTokens) <= limits.reportedTokens,
    'RESUME_USAGE_MISMATCH',
  );
  const resultPath = join(report.project, 'result.json');
  const result = await readFile(resultPath);
  requireTrue(JSON.parse(result.toString('utf8')).sum === 42, 'RESUME_RESULT_MISMATCH');
  const write = records
    .flatMap((entry) => (entry.type === 'message' && entry.message?.role === 'assistant' ? entry.message.content : []))
    .findLast(
      (block) =>
        block.type === 'toolCall' &&
        block.name === 'write' &&
        typeof block.args?.path === 'string' &&
        samePath(resolve(report.project, block.args.path), resultPath),
    );
  requireTrue(
    typeof write?.args.content === 'string' && hash(result) === hash(write.args.content),
    'RESUME_RESULT_WRITE_HASH_MISMATCH',
  );
  const checked = await promisify(execFile)(process.execPath, ['checker.js'], {
    cwd: report.project,
    env: safeEnvironment(),
    windowsHide: true,
    timeout: 15000,
  });
  requireTrue(checked.stdout.trim() === 'STEP_CHECK_OK 42', 'RESUME_INDEPENDENT_CHECK_FAILED');
  const sourceBundleHash =
    first.provenance?.hostBundleSha256 ??
    prior.checks?.find((item) => item.name === 'packaged Step effort mapping preflight' && item.passed)?.detail
      ?.hostBundleSha256;
  requireTrue(
    typeof sourceBundleHash === 'string' && /^[a-f0-9]{64}$/.test(sourceBundleHash),
    'RESUME_SOURCE_BUILD_HASH_MISSING',
  );
  requireTrue(
    typeof prior.executable === 'string' && within(join(repository, 'desktop/release'), prior.executable),
    'RESUME_EXECUTABLE_PATH_INVALID',
  );
  const observedExeHash = (await exists(prior.executable)) ? await hashFile(prior.executable) : null;
  const provenance = first.provenance ?? {
    executable: prior.executable,
    hostBundleSha256: sourceBundleHash,
    executableSha256: null,
    executableHashStatus: 'not recorded at original run time',
    executableSha256ObservedAtResume: observedExeHash,
  };
  report.resume = {
    sourceReport: resumePath,
    sourceReportSha256: hash(raw),
    firstRunReused: true,
    noFirstRunModelReplay: true,
    resultWriteSha256: hash(result),
    checkerSha256: checkerHash,
    inputSha256: inputHash,
    crossVersionContinuation: sourceBundleHash !== report.build.hostBundleSha256,
    originalExecutableHashKnown: !!first.provenance?.executableSha256,
  };
  report.runs.push({
    number: 1,
    runId: first.runId,
    sessionId: first.sessionId,
    thinking: 'low',
    status: 'completed',
    verification: 'passed',
    inputTokens: first.inputTokens,
    outputTokens: first.outputTokens,
    assistantResponses: usage.assistantResponses,
    reportedTokens: Math.max(usage.reportedTokens, first.reportedTokens),
    elapsedMs: first.elapsedMs,
    activities: first.activities.map((item) => ({ name: item.name, status: item.status, durationMs: item.durationMs })),
    reusedFromReport: resumePath,
    provenance,
  });
  report.frozenThinking = { ...prior.frozenThinking, sourceReport: resumePath };
  report.checker = { sha256: checkerHash, unchanged: true, readOnly: true, exitCode: 0, output: 'STEP_CHECK_OK 42' };
  report.assets = { checkerSha256: checkerHash, inputSha256: inputHash, resultSha256: hash(result) };
}
async function restoreResumedSession() {
  const recordsBefore = (await entries()).length;
  const state = await snapshot();
  await evaluate(
    `window.mh.request({method:"openSession",projectId:${JSON.stringify(state.project.id)},sessionId:${JSON.stringify(report.runs[0].sessionId)}})`,
  );
  const restored = await waitFor('RESUMED_SESSION', async () => {
    const next = await snapshot();
    return next.selectedSessionId === report.runs[0].sessionId && next.run?.id === report.runs[0].runId ? next : false;
  });
  requireTrue(
    restored.run.status === 'completed' && restored.run.verification === 'passed' && restored.run.thinking === 'low',
    'RESUMED_TERMINAL_STATE_MISMATCH',
  );
  requireTrue((await entries()).length === recordsBefore, 'RESUME_REPLAY_DETECTED');
  return { sessionId: restored.selectedSessionId, priorRunRestoredWithoutReplay: true };
}
async function main() {
  requireTrue(process.platform === 'win32', 'NATIVE_WINDOWS_REQUIRED');
  requireTrue(Number(process.versions.node.split('.')[0]) >= 24 && typeof WebSocket === 'function', 'NODE_24_REQUIRED');
  apiKey = await stdinKey();
  globalTimer = setTimeout(() => {
    expired = true;
    void forceStop();
  }, limits.overallMs);
  await check('packaged Step effort mapping preflight', async () => {
    await access(executable);
    const path = join(dirname(executable), 'resources/app/dist/host/index.js');
    const bundle = await readFile(path, 'utf8');
    requireTrue(
      bundle.includes('api.stepfun.com') && /output_config:\s*\{\s*effort:/.test(bundle),
      'PACKAGED_STEP_MAPPING_MISSING',
    );
    report.build = { executableSha256: await hashFile(executable), hostBundleSha256: hash(bundle) };
    return { ...report.build, explicitStepEffortMapping: true };
  });
  if (resumePath) await check('reuse verified first live run from sanitized report', prepareResume);
  else {
    temporary = await mkdtemp(join(tmpdir(), 'mh-step-desktop-live-'));
    report.project = join(temporary, '真实Step 项目 空格');
    report.home = join(temporary, '隔离MH_HOME');
    report.outsideFile = join(temporary, 'approved.txt');
    await mkdir(report.project, { recursive: true });
    await mkdir(report.home, { recursive: true });
    await mkdir(artifactDirectory, { recursive: true });
    const input = fixtureInput;
    const checker = fixtureChecker;
    await writeFile(join(report.project, 'package.json'), '{"private":true,"type":"commonjs"}\n');
    await writeFile(join(report.project, 'input.txt'), input);
    await writeFile(join(report.project, 'checker.js'), checker);
    inputHash = hash(input);
    checkerHash = hash(checker);
    report.assets = { inputSha256: inputHash, checkerSha256: checkerHash };
    await chmod(join(report.project, 'checker.js'), 0o444);
    await chmod(join(report.project, 'input.txt'), 0o444);
    await writeFile(
      join(report.home, 'config.json'),
      JSON.stringify(
        {
          compaction: { enabled: false },
          hooks: { onStop: [{ command: 'node checker.js', timeoutSec: 20 }], maxStopContinuations: 0 },
        },
        null,
        2,
      ) + '\n',
    );
  }
  await check('launch actual packaged desktop with isolated Chinese workspace', launch);
  const connection = {
    id: 'step-live-acceptance',
    name: 'Step 真实验收',
    provider: 'anthropic',
    model: report.model,
    baseUrl: report.baseUrl,
    supportsThinking: true,
    supportsImages: false,
    contextWindow: 128000,
    maxOutputTokens: 4096,
  };
  await check('save memory-only Step connection through desktop bridge', async () => {
    await app.cdp.savePrivateConnection(connection, apiKey);
    await waitFor('SAVED_CONNECTION_UI', () =>
      evaluate(
        '!![...document.querySelectorAll(".select-control:not(.effort-select) option")].find(option=>option.value==="step-live-acceptance")',
      ),
    );
    await snapshot();
    return {
      credentialSource: 'stdin-only',
      credentialTransport: 'single private bridge save',
      noCredentialInEnvironment: true,
    };
  });
  await select('.select-control:not(.effort-select) select', connection.id);
  if (resumePath) {
    await check('restore completed first-run history without requesting the model', restoreResumedSession);
    await select('.select-control:not(.effort-select) select', connection.id);
    await select('.effort-select select', 'medium');
  } else {
    await select('.effort-select select', 'low');
    let before = await entries();
    await check('real low-effort read/write/check run and frozen active thinking', async () => {
      const previous = (await snapshot()).run?.id;
      await submit(
        'Read input.txt with the read tool and add its two integers. Write result.json as JSON with a sum property containing the computed result. Use the bash tool to execute node checker.js and confirm its real output. Do not modify input.txt, checker.js, package.json or settings. Complete within at most 8 assistant responses; keep your final answer brief.',
      );
      const started = await waitFor('FIRST_RUN', async () => {
        const state = await snapshot();
        return state.run && state.run.id !== previous ? state : false;
      });
      requireTrue(started.run.thinking === 'low' && busy(started.run), 'LOW_ACTIVE_RUN_NOT_OBSERVED');
      await select('.effort-select select', 'medium');
      requireTrue((await snapshot()).run.thinking === 'low', 'ACTIVE_THINKING_MUTATED');
      report.frozenThinking = { active: 'low', next: 'medium', observedDuringRealRun: true };
      const ended = await monitor(started, before.length, 1);
      requireTrue(
        JSON.parse(await readFile(join(report.project, 'result.json'), 'utf8')).sum === 42,
        'RESULT_SUM_MISMATCH',
      );
      requireTrue(
        ended.activities.some(
          (item) => item.name === 'read' && item.status === 'completed' && item.input.includes('input.txt'),
        ),
        'REAL_READ_NOT_OBSERVED',
      );
      requireTrue(
        ended.activities.some(
          (item) => item.name === 'write' && item.status === 'completed' && item.input.includes('result.json'),
        ),
        'REAL_WRITE_NOT_OBSERVED',
      );
      requireTrue(
        ended.activities.some(
          (item) =>
            item.name === 'bash' &&
            item.status === 'completed' &&
            item.input.includes('checker.js') &&
            item.output.includes('STEP_CHECK_OK 42'),
        ),
        'REAL_CHECK_COMMAND_NOT_OBSERVED',
      );
      await protectedAssets();
      const verified = await promisify(execFile)(process.execPath, ['checker.js'], {
        cwd: report.project,
        env: safeEnvironment(),
        windowsHide: true,
        timeout: 15000,
      });
      requireTrue(verified.stdout.trim() === 'STEP_CHECK_OK 42', 'INDEPENDENT_CHECK_FAILED');
      report.checker = {
        sha256: checkerHash,
        unchanged: true,
        readOnly: true,
        exitCode: 0,
        output: 'STEP_CHECK_OK 42',
      };
      report.assets.resultSha256 = await hashFile(join(report.project, 'result.json'));
      return { result: 42, actualTools: ['read', 'write', 'bash'], independentCheckerExitCode: 0 };
    });
  }
  await check('real medium-effort outside write uses native allow-once approval', async () => {
    const before = await entries();
    const previous = (await snapshot()).run?.id;
    await submit(
      'Using the write tool, create exactly this one temporary sibling file outside the workspace: ' +
        report.outsideFile +
        '. Its exact content must be STEP_APPROVED_WRITE followed by a newline. This is the only outside write authorized for this task; wait for its native approval card. Do not use bash to bypass permission. Read the created file to verify it, then run node checker.js in the workspace again. Preserve all existing project files and finish briefly within 8 assistant responses.',
    );
    const started = await waitFor('SECOND_RUN', async () => {
      const state = await snapshot();
      return state.run && state.run.id !== previous ? state : false;
    });
    requireTrue(started.run.thinking === 'medium', 'MEDIUM_RUN_NOT_OBSERVED');
    const ended = await monitor(started, before.length, 2);
    requireTrue(secondApproved, 'NATIVE_ONCE_APPROVAL_NOT_OBSERVED');
    requireTrue((await readFile(report.outsideFile, 'utf8')) === 'STEP_APPROVED_WRITE\n', 'APPROVED_RESULT_MISMATCH');
    const writes = ended.activities.filter((item) => item.name === 'write');
    requireTrue(writes.length === 1 && writes[0].status === 'completed', 'OUTSIDE_WRITE_COUNT_MISMATCH');
    await protectedAssets();
    return { nativeApproval: 'once', oneOutsideWrite: true, target: 'temporary sibling approved.txt' };
  });
  await check('history reload retains results without replaying model or tools', async () => {
    const state = await snapshot(),
      records = await entries();
    const prior = {
      entries: records.length,
      usage: usageOf(records),
      runId: state.run.id,
      result: hash(await readFile(join(report.project, 'result.json'))),
      outside: hash(await readFile(report.outsideFile)),
    };
    await app.cdp.send('Page.reload', { ignoreCache: true });
    await ready();
    await delay(2000);
    const next = await snapshot(),
      retained = await entries();
    requireTrue(next.run?.id === prior.runId && next.run.status === 'completed', 'HISTORY_RUN_CHANGED');
    requireTrue(
      retained.length === prior.entries && usageOf(retained).assistantResponses === prior.usage.assistantResponses,
      'HISTORY_REPLAY_DETECTED',
    );
    requireTrue(
      hash(await readFile(join(report.project, 'result.json'))) === prior.result &&
        hash(await readFile(report.outsideFile)) === prior.outside,
      'HISTORY_SIDE_EFFECT',
    );
    await protectedAssets();
    return { noNewAssistantResponses: true, noNewSessionEntries: true, resultsUnchanged: true };
  });
  report.secretChecks = await scanStoredSecrets();
  await screenshot('completed-session-after-reload');
  report.secretChecks = await scanStoredSecrets();
  const capturesPassed = report.visualPending.length === 0 && report.screenshots.length === 1;
  report.checks.push({ name: 'safe nonblank desktop captures', passed: capturesPassed });
  report.passed = capturesPassed;
  if (!capturesPassed) report.failure = { stage: 'screenshots', code: 'VISUAL_EVIDENCE_PENDING' };
}

try {
  await main();
} catch (error) {
  report.passed = false;
  report.failure = { stage, code: error instanceof AcceptanceError ? error.code : 'ACCEPTANCE_FAILED' };
  if (app?.cdp && !app.exited) {
    try {
      const state = await snapshot();
      if (state.run) {
        report.remoteFailure = {
          status: state.run.status,
          verification: state.run.verification,
          httpStatus: /HTTP\s+(\d{3})/.exec(state.run.error || '')?.[1] || null,
        };
        if (busy(state.run)) await cancelRun(state.run.id);
      }
    } catch {
      /* Do not expose raw CDP/API exception descriptions. */
    }
  }
  process.exitCode = 1;
} finally {
  clearTimeout(globalTimer);
  await closeApplication();
  if (apiKey && report.home && (await exists(join(report.home, 'desktop-connections.json')))) {
    try {
      report.secretChecks = await scanStoredSecrets();
    } catch {
      report.passed = false;
      report.secretChecks = { passed: false, code: 'STORED_SECRET_CHECK_FAILED' };
    }
  }
  report.finishedAt = new Date().toISOString();
  report.temporaryDirectoriesRetained = !!temporary;
  // Do not retain input bytes, key references, request headers, raw session data, logs or API errors in evidence.
  apiKey = '';
  await mkdir(artifactDirectory, { recursive: true });
  const reportPath = artifactBase + '.json';
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(
    JSON.stringify({ passed: !!report.passed, runs: report.runs.length, report: reportPath }) + '\n',
  );
  if (!report.passed) process.exitCode = 1;
}
