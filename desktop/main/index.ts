import { app, BrowserWindow, dialog, ipcMain, MessageChannelMain, utilityProcess } from 'electron';
import type { MessagePortMain, UtilityProcess, IpcMainInvokeEvent } from 'electron';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { HostCommand, HostMessage, Snapshot } from '../contracts.ts';
import { disconnectedSnapshot } from './disconnected.ts';

let window: BrowserWindow | undefined;
let host: UtilityProcess | undefined;
let hostJob: ChildProcessWithoutNullStreams | undefined;
let port: MessagePortMain | undefined;
let latest: Snapshot | undefined;
let hostNodeVersion = '';
let closing = false;
let closePending = false;
const pending = new Map<
  string,
  { resolve(snapshot: Snapshot): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
>();
const smoke = process.argv.includes('--mh-smoke');
const testMode = process.argv.includes('--mh-test');
const smokeReportPath = process.env.MH_DESKTOP_SMOKE_REPORT;
const base = app.getAppPath();
const rendererFile = join(base, 'dist', 'renderer', 'index.html');
const rendererUrl = pathToFileURL(rendererFile).href;
const home = process.env.MH_HOME || join(homedir(), '.mh');
const promptsDir = join(base, 'dist', 'assets', 'prompts');
const inheritedEnvironment = Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
);
const appDataPath = process.env.MH_DESKTOP_USER_DATA || join(home, 'desktop-app');
mkdirSync(appDataPath, { recursive: true });
app.setPath('userData', appDataPath);
// Chromium descendants inherit main's environment. Keep only OS/runtime essentials here;
// provider configuration is delivered privately to the Host, never to a renderer process.
for (const key of Object.keys(process.env))
  if (
    !/^(?:path|pathext|systemroot|systemdrive|windir|temp|tmp|userprofile|appdata|localappdata|programfiles(?:\(x86\))?|programw6432|commonprogramfiles(?:\(x86\))?|home|lang|lc_.*|tz|comspec|number_of_processors|processor_.*|os)$/i.test(
      key,
    )
  )
    delete process.env[key];

function safeEnvironment() {
  return Object.fromEntries(
    Object.entries(inheritedEnvironment).filter(([key]) => !/(?:key|token|secret|password|credential|auth)/i.test(key)),
  );
}
function rejectPending(message: string) {
  for (const item of pending.values()) {
    clearTimeout(item.timer);
    item.reject(new Error(message));
  }
  pending.clear();
}
function request(command: HostCommand): Promise<Snapshot> {
  if (!port) return Promise.reject(new Error('执行服务尚未就绪。'));
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('执行服务未及时响应，请检查当前任务状态。'));
    }, 30000);
    pending.set(id, { resolve, reject, timer });
    port!.postMessage({ id, command });
  });
}
function ensureSender(event: IpcMainInvokeEvent) {
  if (!window || event.sender.id !== window.webContents.id || event.senderFrame?.url !== rendererUrl)
    throw new Error('不允许此页面访问桌面执行服务。');
}
function validateCommand(value: unknown): HostCommand {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('无效的桌面请求。');
  const command = value as Record<string, unknown>;
  if (
    ![
      'snapshot',
      'openSession',
      'newSession',
      'startRun',
      'steer',
      'cancel',
      'approve',
      'review',
      'saveConnection',
    ].includes(String(command.method))
  )
    throw new Error('不支持的桌面操作。');
  if (JSON.stringify(command).length > 1024 * 1024) throw new Error('输入超过本次操作允许的大小。');
  return command as HostCommand;
}
async function containHost(pid: number) {
  if (process.platform !== 'win32') return;
  const script = readFileSync(join(base, 'dist', 'assets', 'host-job.ps1'), 'utf8');
  const powershell = join(
    inheritedEnvironment.SystemRoot || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  const guardian = spawn(
    powershell,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    {
      env: { ...safeEnvironment(), MH_DESKTOP_HOST_PID: String(pid) },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  hostJob = guardian;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('无法建立执行服务的进程回收边界。')), 12000);
    guardian.stdout.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('MH_JOB_READY')) {
        clearTimeout(timer);
        resolve();
      }
    });
    guardian.once('error', () => {
      clearTimeout(timer);
      reject(new Error('无法启动执行服务进程监护。'));
    });
    guardian.once('exit', () => {
      clearTimeout(timer);
      reject(new Error('执行服务进程监护已退出。'));
      if (!closing && host?.pid) host.kill();
    });
    guardian.stderr.on('data', () => {
      /* Avoid exposing native error data or environment values to the UI. */
    });
    guardian.stdin.on('error', () => {});
  });
}
async function startHost() {
  const channel = new MessageChannelMain();
  port = channel.port1;
  let readyResolve: () => void;
  let readyReject: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const startupTimer = setTimeout(() => readyReject(new Error('执行服务启动超时。')), 15000);
  port.on('message', (event: { data: HostMessage }) => {
    const message = event.data;
    if (message.type === 'ready') {
      hostNodeVersion = message.nodeVersion;
      if (Number(message.nodeVersion.split('.')[0]) < 24) {
        readyReject(new Error('执行服务需要 Node 24 或更新版本。'));
        return;
      }
      clearTimeout(startupTimer);
      readyResolve();
    } else if (message.type === 'snapshot') {
      if (!latest || message.snapshot.seq >= latest.seq) latest = message.snapshot;
      if (window && !window.isDestroyed()) window.webContents.send('mh:snapshot', message.snapshot);
    } else {
      const item = pending.get(message.id);
      if (!item) return;
      pending.delete(message.id);
      clearTimeout(item.timer);
      if (message.error) item.reject(new Error(message.error));
      else if (message.snapshot) {
        if (!latest || message.snapshot.seq >= latest.seq) latest = message.snapshot;
        item.resolve(message.snapshot);
      } else item.reject(new Error('执行服务返回了无效响应。'));
    }
  });
  port.start();
  host = utilityProcess.fork(join(base, 'dist', 'host', 'index.js'), [], {
    env: safeEnvironment(),
    serviceName: 'mini-harness Agent',
    stdio: 'pipe',
  });
  host.once('exit', () => {
    clearTimeout(startupTimer);
    readyReject(new Error('执行服务已退出。'));
    rejectPending('执行服务意外退出，未完成任务不会自动重跑。');
    port?.close();
    port = undefined;
    hostJob?.stdin.end();
    if (!closing && window && !window.isDestroyed()) {
      latest = disconnectedSnapshot(latest);
      window.webContents.send('mh:snapshot', latest);
    }
  });
  if (!host.pid)
    await new Promise<void>((resolve, reject) => {
      host!.once('spawn', resolve);
      host!.once('exit', () => reject(new Error('执行服务启动前已退出。')));
    });
  if (!host.pid) throw new Error('执行服务没有可用进程标识。');
  await containHost(host.pid);
  host.postMessage({ home, promptsDir, credentialEnvironment: inheritedEnvironment }, [channel.port2]);
  return ready;
}
async function closeApplication() {
  if (closing || closePending) return;
  closePending = true;
  try {
    if (latest?.run && ['running', 'thinking', 'waitingApproval', 'cancelling'].includes(latest.run.status) && !smoke) {
      const answer = await dialog.showMessageBox(window!, {
        type: 'question',
        title: '退出 mini-harness',
        message: '任务仍在执行。停止任务后退出？',
        detail: '应用会先取消运行、解除待确认请求并等待命令进程清理。',
        buttons: ['继续工作', '停止并退出'],
        defaultId: 0,
        cancelId: 0,
      });
      if (answer.response !== 1) return;
    }
    if (port) await request({ method: 'shutdown' });
    closing = true;
    port?.close();
    port = undefined;
    hostJob?.stdin.end();
    host?.kill();
    app.quit();
  } catch {
    if (!smoke && window)
      await dialog.showMessageBox(window, {
        type: 'error',
        message: '尚未确认任务清理完成，应用保持开启。',
        detail: '请停止当前任务后再次退出。',
      });
    if (smoke) {
      closing = true;
      app.exit(1);
    }
  } finally {
    closePending = false;
  }
}
async function smokeReport() {
  const reportFile = smokeReportPath;
  if (!reportFile || !window) throw new Error('Smoke report path is required.');
  const snapshot = await request({ method: 'snapshot' });
  await new Promise((resolve) => setTimeout(resolve, 200));
  const renderer = await window.webContents.executeJavaScript(
    '({bridge:typeof window.mh?.request === "function",text:document.body.innerText})',
  );
  const report = {
    node: process.versions.node,
    hostNode: hostNodeVersion,
    electron: process.versions.electron,
    bridge: renderer.bridge,
    rendered: String(renderer.text).includes('mini-harness'),
    protocol: snapshot.protocolVersion,
    rendererEnvironmentHasSecrets: Object.keys(process.env).some((key) =>
      /(?:api.?key|token|secret|password|credential)/i.test(key),
    ),
    hostContainment: process.platform !== 'win32' || !!hostJob,
    assets: [
      'dist/host/plugin-worker.js',
      'dist/host/windows-job.ps1',
      'dist/assets/host-job.ps1',
      'dist/assets/prompts/system.md',
    ].map((file) => ({ file, exists: existsSync(join(base, file)) })),
  };
  writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n');
  writeFileSync(reportFile.replace(/\.json$/, '.png'), (await window.webContents.capturePage()).toPNG());
  if (!report.bridge || !report.rendered || report.assets.some((asset) => !asset.exists))
    throw new Error('Desktop smoke validation failed.');
  await closeApplication();
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    window?.restore();
    window?.focus();
  });
  app.on('before-quit', (event) => {
    if (!closing) {
      event.preventDefault();
      void closeApplication();
    }
  });
  app
    .whenReady()
    .then(async () => {
      mkdirSync(home, { recursive: true });
      ipcMain.handle('mh:request', (event, command: unknown) => {
        ensureSender(event);
        return request(validateCommand(command));
      });
      ipcMain.handle('mh:choose-project', async (event) => {
        ensureSender(event);
        if (latest?.run && ['running', 'thinking', 'waitingApproval', 'cancelling'].includes(latest.run.status))
          throw new Error('请先停止当前任务，再切换项目。');
        const selected = await dialog.showOpenDialog(window!, {
          title: '选择项目文件夹',
          properties: ['openDirectory'],
        });
        return selected.canceled || !selected.filePaths[0]
          ? null
          : request({ method: 'openProject', path: selected.filePaths[0] });
      });
      await startHost();
      const projectIndex = process.argv.indexOf('--project');
      if (projectIndex >= 0 && process.argv[projectIndex + 1])
        await request({ method: 'openProject', path: process.argv[projectIndex + 1]! });
      window = new BrowserWindow({
        width: 1400,
        height: 940,
        minWidth: 760,
        minHeight: 600,
        title: 'mini-harness',
        backgroundColor: '#faf9f6',
        show: !smoke && !testMode,
        autoHideMenuBar: true,
        icon: join(base, 'dist', 'assets', 'moon.png'),
        webPreferences: {
          preload: join(base, 'dist', 'preload', 'index.cjs'),
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          backgroundThrottling: !testMode,
        },
      });
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.on('will-navigate', (event, url) => {
        if (url !== rendererUrl) event.preventDefault();
      });
      window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      window.on('close', (event) => {
        if (!closing) {
          event.preventDefault();
          void closeApplication();
        }
      });
      await window.loadFile(rendererFile);
      if (smoke) await smokeReport();
    })
    .catch(async (error: unknown) => {
      const message = error instanceof Error ? error.message : '桌面程序启动失败。';
      const report = smoke && smokeReportPath;
      if (report) writeFileSync(report, JSON.stringify({ error: message }) + '\n');
      else await dialog.showErrorBox('mini-harness 启动失败', message);
      closing = true;
      host?.kill();
      app.exit(1);
    });
}
