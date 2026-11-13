import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const reportPath = fileURLToPath(new URL('../../.codex/desktop-mvp-checks/job-guard.json', import.meta.url));
const guardianPath = fileURLToPath(new URL('../assets/host-job.ps1', import.meta.url));
const selfPath = fileURLToPath(import.meta.url);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
    await delay(25);
  }
}

function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

function observe(child) {
  const state = { stdout: '', stderr: '', exited: false, exitCode: undefined, error: undefined };
  child.stdout.setEncoding('utf8').on('data', (text) => {
    state.stdout += text;
  });
  child.stderr.setEncoding('utf8').on('data', (text) => {
    state.stderr += text;
  });
  child.on('error', (error) => {
    state.error = error;
  });
  child.on('exit', (code) => {
    state.exited = true;
    state.exitCode = code;
  });
  child.stdin.on('error', () => {});
  return state;
}

async function outputLine(state, predicate, label) {
  let found;
  await until(() => {
    if (state.error) throw state.error;
    found = state.stdout.split('\n').find(predicate);
    if (!found && state.exited) throw new Error(`${label} exited early: ${state.stderr}`);
    return !!found;
  }, label);
  return found;
}

async function controlledParent() {
  const timer = setInterval(() => {}, 1000);
  process.stdout.write(JSON.stringify({ type: 'parent-ready', pid: process.pid }) + '\n');
  let spawned = false;
  for await (const line of createInterface({ input: process.stdin })) {
    if (line === 'crash') process.exit(97);
    if (line !== 'spawn-child' || spawned) continue;
    spawned = true;
    const child = spawn(
      process.execPath,
      [
        '-e',
        "require('node:fs').writeFileSync(process.argv[1],JSON.stringify({pid:process.pid}));setInterval(()=>{},1000)",
        join(process.cwd(), 'child-ready.json'),
      ],
      { windowsHide: true, stdio: 'ignore' },
    );
    child.once('spawn', () => {
      process.stdout.write(JSON.stringify({ type: 'child-ready', pid: child.pid }) + '\n');
    });
    child.on('error', (error) => {
      process.stderr.write(String(error));
      process.exitCode = 1;
      clearInterval(timer);
    });
  }
}

async function scenario(name, script) {
  const temporary = await mkdtemp(join(tmpdir(), 'mh-desktop-job-guard-'));
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) =>
        typeof value === 'string' &&
        /^(?:path|pathext|systemroot|systemdrive|windir|userprofile|appdata|localappdata|comspec|os)$/i.test(key),
    ),
  );
  environment.TEMP = temporary;
  environment.TMP = temporary;
  const parent = spawn(process.execPath, [selfPath, '--controlled-parent'], {
    cwd: temporary,
    env: environment,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const parentState = observe(parent);
  let guardian, guardianState, childPid;
  const evidence = { name, temporary, attachedBeforeChildSpawn: false, events: [] };
  try {
    await outputLine(parentState, (line) => line.includes('"type":"parent-ready"'), 'controlled parent readiness');
    assert.ok(parent.pid && alive(parent.pid));
    evidence.parentPid = parent.pid;
    evidence.events.push('parent-ready-without-child');
    const powershell = join(
      environment.SystemRoot || environment.SYSTEMROOT || 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    );
    guardian = spawn(
      powershell,
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64'),
      ],
      {
        cwd: temporary,
        env: { ...environment, MH_DESKTOP_HOST_PID: String(parent.pid) },
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    guardianState = observe(guardian);
    await outputLine(guardianState, (line) => line.trim() === 'MH_JOB_READY', 'guardian attachment');
    evidence.guardianPid = guardian.pid;
    evidence.events.push('guardian-attached');
    assert.ok(!parentState.stdout.includes('"type":"child-ready"'));
    evidence.attachedBeforeChildSpawn = true;
    parent.stdin.write('spawn-child\n');
    const ready = await outputLine(
      parentState,
      (line) => line.includes('"type":"child-ready"'),
      'controlled child readiness',
    );
    childPid = JSON.parse(ready).pid;
    assert.ok(Number.isSafeInteger(childPid) && childPid > 0 && childPid !== parent.pid);
    const readyFile = join(temporary, 'child-ready.json');
    await until(() => existsSync(readyFile), 'controlled child execution');
    assert.equal(JSON.parse(await readFile(readyFile, 'utf8')).pid, childPid);
    assert.ok(alive(parent.pid) && alive(childPid));
    evidence.childPid = childPid;
    evidence.events.push('child-spawned-and-alive');
    await delay(100);
    assert.ok(
      alive(guardian.pid) && !guardianState.exited,
      'Guardian must remain alive while its private pipe is open.',
    );
    evidence.guardianAliveBeforeEOF = true;
    if (name === 'host-crash-then-guardian-eof') {
      assert.ok(alive(parent.pid) && alive(childPid));
      evidence.parentAndChildAliveBeforeCrash = true;
      parent.stdin.write('crash\n');
      await until(() => parentState.exited && !alive(parent.pid), 'controlled parent crash');
      assert.equal(parentState.exitCode, 97);
      evidence.parentCrashExitCode = parentState.exitCode;
      evidence.guardianAliveAfterParentCrash = alive(guardian.pid) && !guardianState.exited;
      assert.equal(evidence.guardianAliveAfterParentCrash, true);
      evidence.earlyDescendantExit = !alive(childPid);
      evidence.events.push(
        evidence.earlyDescendantExit ? 'parent-crashed-child-already-exited' : 'parent-crashed-child-still-alive',
      );
    } else {
      assert.ok(alive(parent.pid) && alive(childPid));
      evidence.parentAndChildAliveBeforeEOF = true;
    }
    guardian.stdin.end();
    evidence.events.push('private-pipe-eof');
    await until(() => guardianState.exited, 'guardian exit');
    assert.equal(guardianState.exitCode, 0, guardianState.stderr);
    await until(() => !alive(parent.pid) && !alive(childPid), 'Job descendant termination');
    evidence.events.push('all-owned-job-processes-exited');
    evidence.parentExited = true;
    evidence.childExited = true;
    evidence.guardianExitCode = guardianState.exitCode;
    evidence.passed = true;
  } catch (error) {
    evidence.passed = false;
    evidence.error = error instanceof Error ? error.stack : String(error);
    if (guardianState?.stderr) evidence.guardianStderr = guardianState.stderr;
  } finally {
    guardian?.stdin.end();
    // Failure cleanup is confined to PIDs created by this scenario; it cannot make a failed assertion pass.
    if (guardianState && !guardianState.exited) {
      await until(() => guardianState.exited, 'guardian cleanup', 3000).catch(() => {
        guardian.kill('SIGKILL');
      });
    }
    if (alive(parent.pid)) parent.kill('SIGKILL');
    if (alive(childPid)) process.kill(childPid, 'SIGKILL');
    parent.stdin.destroy();
    guardian?.stdin.destroy();
  }
  return evidence;
}

async function main() {
  if (process.platform !== 'win32')
    throw new Error('This native Windows Job Object probe is unsupported on WSL/Linux/macOS.');
  const script = await readFile(guardianPath, 'utf8');
  const cases = [];
  for (const name of ['host-crash-then-guardian-eof', 'main-pipe-eof-with-live-parent-and-child'])
    cases.push(await scenario(name, script));
  const report = {
    platform: process.platform,
    node: process.versions.node,
    guardianPath,
    finishedAt: new Date().toISOString(),
    passed: cases.every((item) => item.passed),
    cases,
  };
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  if (!report.passed) process.exitCode = 1;
}

if (process.argv.includes('--controlled-parent')) await controlledParent();
else await main();
