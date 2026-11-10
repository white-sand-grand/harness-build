import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, posix, relative, resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { Tool } from '../agent/index.ts';
import type { PluginDescriptor, PreparedPlugin } from './plugin-types.ts';

const manifestName = 'mh-plugin.json';
const maxBytes = 1024 * 1024;
const maxPending = 64;
const identifier = /^[a-zA-Z][a-zA-Z0-9_-]{0,31}$/;
type Manifest = { id: string; version: string; module: string; files: string[] };
type Inspection = { descriptor: PluginDescriptor; manifest: Manifest; contents: Map<string, Buffer> };
type Metadata = {
  id: string;
  version: string;
  tools: Array<Omit<Tool, 'execute'>>;
  context: string[];
  memory: Array<{ id: string; remember: boolean }>;
  prompts: Record<string, string>;
  hooks: Array<{ id: string; beforeTool: boolean; afterTool: boolean; onStop: boolean }>;
};

function plain(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function fileName(value: unknown): string {
  if (typeof value !== 'string' || !value || /[\x00-\x1f:<>"|?*]/.test(value))
    throw new Error('Plugin file paths must be relative ordinary file names.');
  const path = value.replaceAll('\\', '/');
  if (isAbsolute(path) || path.startsWith('/') || path.split('/').includes('..'))
    throw new Error(`Plugin file escapes its directory: ${value}`);
  const normalized = posix.normalize(path);
  if (normalized === '.' || normalized.endsWith('/')) throw new Error(`Invalid plugin file: ${value}`);
  if (
    normalized
      .split('/')
      .some((part) => /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))
  )
    throw new Error(`Plugin file must use portable ordinary names: ${value}`);
  return normalized;
}
function ordinary(path: string, directory = false): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()))
    throw new Error(`Plugin paths must not be symlinks or special files: ${path}`);
}
function readOrdinary(root: string, file: string): Buffer {
  const parts = file.split('/');
  let path = root;
  ordinary(path, true);
  for (const [i, part] of parts.entries()) {
    path = join(path, part);
    ordinary(path, i < parts.length - 1);
  }
  const bytes = readFileSync(path);
  if (bytes.byteLength > 8 * maxBytes) throw new Error(`Plugin file exceeds the 8 MiB limit: ${file}`);
  return bytes;
}
function inspect(directory: string): Inspection {
  const root = resolve(directory);
  const manifestBytes = readOrdinary(root, manifestName);
  if (manifestBytes.byteLength > 65536) throw new Error('Plugin manifest exceeds the 64 KiB limit.');
  const data: unknown = JSON.parse(manifestBytes.toString('utf8'));
  if (
    !plain(data) ||
    Object.keys(data).some((key) => !['id', 'version', 'module', 'files'].includes(key)) ||
    typeof data.id !== 'string' ||
    !identifier.test(data.id) ||
    typeof data.version !== 'string' ||
    !data.version.trim() ||
    data.version.length > 128 ||
    !Array.isArray(data.files) ||
    !data.files.length ||
    data.files.length > 128
  )
    throw new Error('Invalid mh-plugin.json: expected id, version, module and 1–128 explicit files.');
  const module = fileName(data.module),
    declared = data.files.map(fileName);
  if (!/\.(?:mjs|js|ts)$/.test(module)) throw new Error('Plugin module must be a .mjs, .js or .ts source file.');
  const keys = declared.map((file) => (process.platform === 'win32' ? file.toLowerCase() : file));
  if (new Set(keys).size !== declared.length) throw new Error('Duplicate plugin file paths.');
  if (!declared.includes(module)) throw new Error('Plugin module must be included in files.');
  const files = [...new Set([manifestName, ...declared])].sort();
  const contents = new Map<string, Buffer>();
  const hash = createHash('sha256');
  let total = 0;
  for (const file of files) {
    const bytes = file === manifestName ? manifestBytes : readOrdinary(root, file);
    total += bytes.byteLength;
    if (total > 8 * maxBytes) throw new Error('Plugin contents exceed the 8 MiB limit.');
    contents.set(file, bytes);
    hash.update(JSON.stringify([file, bytes.byteLength]) + '\n').update(bytes);
  }
  const manifest = { id: data.id, version: data.version, module, files: declared };
  return {
    manifest,
    contents,
    descriptor: { id: manifest.id, version: manifest.version, fingerprint: hash.digest('hex'), files, directory: root },
  };
}

/** Reads only declared bytes; importing plugin code is forbidden before authorization. */
export function inspectPlugin(directory: string): PluginDescriptor {
  return inspect(directory).descriptor;
}
function snapshot(inspection: Inspection, home: string): string {
  const base = resolve(home, 'runtime', 'plugins');
  mkdirSync(resolve(home), { recursive: true });
  for (const directory of [dirname(base), base]) {
    try {
      ordinary(directory, true);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      mkdirSync(directory);
    }
  }
  const destination = join(base, inspection.descriptor.fingerprint);
  try {
    ordinary(destination, true);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const temporary = join(base, '.prepare-' + randomUUID());
    mkdirSync(temporary);
    try {
      for (const [file, bytes] of inspection.contents) {
        const target = join(temporary, file);
        if (relative(temporary, target).startsWith('..')) throw new Error('Plugin snapshot path escapes its root.');
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, bytes, { flag: 'wx' });
      }
      try {
        renameSync(temporary, destination);
      } catch (caught) {
        // Another concurrent prepare may have published the same immutable content.
        if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes((caught as NodeJS.ErrnoException).code ?? '')) throw caught;
        ordinary(destination, true);
      }
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }
  if (inspect(destination).descriptor.fingerprint !== inspection.descriptor.fingerprint)
    throw new Error('Plugin snapshot content does not match its authorized fingerprint.');
  const actual: string[] = [];
  function inventory(directory: string, prefix = '') {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const name = prefix + entry.name;
      if (entry.isSymbolicLink()) throw new Error('Plugin snapshot contains an unauthorized symlink.');
      if (entry.isDirectory()) inventory(join(directory, entry.name), name + '/');
      else if (entry.isFile()) actual.push(name);
      else throw new Error('Plugin snapshot contains a special file.');
    }
  }
  inventory(destination);
  if (JSON.stringify(actual.sort()) !== JSON.stringify(inspection.descriptor.files))
    throw new Error('Plugin snapshot contains files outside its authorized manifest.');
  return join(destination, inspection.manifest.module);
}

export async function loadPlugin(opts: {
  directory: string;
  cwd: string;
  home: string;
  authorize: (descriptor: PluginDescriptor) => Promise<boolean>;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<PreparedPlugin> {
  opts.signal?.throwIfAborted();
  if (
    opts.timeoutMs !== undefined &&
    (!Number.isInteger(opts.timeoutMs) || opts.timeoutMs < 1 || opts.timeoutMs > 600000)
  )
    throw new Error('Plugin timeoutMs must be an integer between 1 and 600000.');
  const inspection = inspect(opts.directory),
    descriptor = inspection.descriptor;
  if (!(await opts.authorize({ ...descriptor, files: [...descriptor.files] })))
    throw new Error(`Plugin authorization denied: ${descriptor.id}`);
  opts.signal?.throwIfAborted();
  if (inspect(opts.directory).descriptor.fingerprint !== descriptor.fingerprint)
    throw new Error('Plugin files changed during authorization; authorize the new fingerprint first.');
  const entry = snapshot(inspection, opts.home);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      /^(?:path|pathext|systemroot|windir|temp|tmp|lang|lc_all)$/i.test(key),
    ),
  );
  env.MH_HOME = opts.home;
  const worker = new Worker(
    new URL(import.meta.url.endsWith('.ts') ? './plugin-worker.ts' : './plugin-worker.js', import.meta.url),
    {
      workerData: { entry, id: descriptor.id, version: descriptor.version, cwd: opts.cwd, home: opts.home },
      execArgv: [],
      env,
      stdout: true,
      stderr: true,
    },
  );
  const timeoutMs = opts.timeoutMs ?? 10000;
  type Pending = {
    resolve(value: unknown): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
    signal?: AbortSignal;
    abort?: () => void;
    update?: (text: string) => void;
    aborted?: boolean;
  };
  const pending = new Map<number, Pending>();
  let nextId = 0,
    failure: Error | undefined,
    outputBytes = 0,
    disposed = false;
  let resolveReady: (value: Metadata) => void, rejectReady: (error: Error) => void;
  const ready = new Promise<Metadata>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  function clear(id: number, call: Pending) {
    clearTimeout(call.timer);
    if (call.abort) call.signal?.removeEventListener('abort', call.abort);
    pending.delete(id);
  }
  function fail(error: Error) {
    if (failure) return;
    failure = error;
    rejectReady(error);
    for (const [id, call] of pending) {
      clear(id, call);
      call.reject(error);
    }
    void worker.terminate();
  }
  const initTimer = setTimeout(() => fail(new Error(`Plugin initialization timed out: ${descriptor.id}`)), timeoutMs);
  const abortInit = () => fail(new Error(`Plugin initialization aborted: ${descriptor.id}`));
  opts.signal?.addEventListener('abort', abortInit, { once: true });
  if (opts.signal?.aborted) abortInit();
  for (const stream of [worker.stdout, worker.stderr])
    stream.on('data', (chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > maxBytes) fail(new Error(`Plugin stdout/stderr exceeded the 1 MiB limit: ${descriptor.id}`));
    });
  worker.on('error', (error) => fail(new Error(`Plugin worker failed: ${error.message}`)));
  worker.on('exit', (code) => {
    if (!disposed) fail(new Error(`Plugin worker exited unexpectedly (${code}): ${descriptor.id}`));
  });
  worker.on('message', (message: unknown) => {
    let size: number;
    try {
      size = Buffer.byteLength(JSON.stringify(message));
    } catch {
      fail(new Error('Plugin worker returned a non-serializable message.'));
      return;
    }
    if (size > maxBytes || !plain(message)) {
      fail(new Error('Plugin worker returned an invalid or oversized message.'));
      return;
    }
    if (message.type === 'ready') resolveReady(message.metadata as Metadata);
    else if (message.type === 'initError') fail(new Error(`Invalid plugin: ${String(message.error)}`));
    else if (typeof message.id === 'number') {
      const call = pending.get(message.id);
      if (!call) return;
      if (message.type === 'update' && typeof message.text === 'string') {
        if (!call.aborted) call.update?.(message.text);
        return;
      }
      clear(message.id, call);
      if (call.aborted) return;
      if (message.type === 'result') call.resolve(message.value);
      else call.reject(new Error(`Plugin operation failed: ${String(message.error)}`));
    }
  });
  function request(op: string, index: number, args: unknown[], signal?: AbortSignal, update?: (text: string) => void) {
    if (failure) return Promise.reject(failure);
    if (disposed) return Promise.reject(new Error('Plugin has been disposed.'));
    if (signal?.aborted) return Promise.reject(new Error('Plugin operation aborted.'));
    if (pending.size >= maxPending) return Promise.reject(new Error('Plugin has too many pending operations.'));
    const id = ++nextId,
      message = { type: 'request', id, op, index, args };
    let encoded: string;
    try {
      encoded = JSON.stringify(message);
    } catch {
      return Promise.reject(new Error('Plugin request must be serializable.'));
    }
    if (Buffer.byteLength(encoded) > maxBytes)
      return Promise.reject(new Error('Plugin request exceeds the 1 MiB limit.'));
    return new Promise<unknown>((resolve, reject) => {
      const call: Pending = {
        resolve,
        reject,
        signal,
        update,
        timer: setTimeout(() => fail(new Error(`Plugin operation timed out: ${op}`)), timeoutMs),
      };
      call.abort = () => {
        call.aborted = true;
        reject(new Error('Plugin operation aborted.'));
        worker.postMessage({ type: 'abort', id });
        clearTimeout(call.timer);
        call.timer = setTimeout(() => fail(new Error('Plugin ignored cancellation.')), Math.min(timeoutMs, 250));
      };
      pending.set(id, call);
      signal?.addEventListener('abort', call.abort, { once: true });
      worker.postMessage(JSON.parse(encoded));
      if (signal?.aborted) call.abort();
    });
  }
  let metadata: Metadata;
  try {
    metadata = await ready;
  } catch (error) {
    await worker.terminate();
    throw error;
  } finally {
    clearTimeout(initTimer);
    opts.signal?.removeEventListener('abort', abortInit);
  }
  const contextArgs = (context: Parameters<NonNullable<PreparedPlugin['context']>[number]['provide']>[0]) => {
    const { signal, ...data } = context;
    return { signal, data };
  };
  const toolMetadata = (tool: Tool) => {
    const { execute: _execute, ...data } = tool;
    return data;
  };
  return {
    id: descriptor.id,
    version: descriptor.version,
    fingerprint: descriptor.fingerprint,
    files: descriptor.files,
    tools: metadata.tools.map((tool, index) => ({
      ...tool,
      name: `${descriptor.id}__${tool.name}`,
      external: { pluginId: descriptor.id, fingerprint: descriptor.fingerprint },
      async execute(args, context) {
        const { signal, onUpdate, ...data } = context;
        return (await request('execute', index, [args, data], signal, onUpdate)) as Awaited<
          ReturnType<Tool['execute']>
        >;
      },
    })),
    context: metadata.context.map((id, index) => ({
      id: `${descriptor.id}/${id}`,
      async provide(context) {
        const { signal, data } = contextArgs(context);
        return (await request('provide', index, [data], signal)) as string;
      },
    })),
    memory: metadata.memory.map(({ id, remember }, index) => ({
      id: `${descriptor.id}/${id}`,
      async recall(context) {
        const { signal, data } = contextArgs(context);
        return (await request('recall', index, [data], signal)) as string;
      },
      ...(remember
        ? ({
            async remember(context, reason) {
              const { signal, data } = contextArgs(context);
              await request('remember', index, [data, reason], signal);
            },
          } satisfies Pick<NonNullable<PreparedPlugin['memory']>[number], 'remember'>)
        : {}),
    })),
    prompts: Object.fromEntries(Object.entries(metadata.prompts).map(([id, text]) => [`${descriptor.id}/${id}`, text])),
    hooks: metadata.hooks.map((hook, index) => ({
      id: `${descriptor.id}/${hook.id}`,
      ...(hook.beforeTool
        ? ({
            beforeTool: async (call, tool) =>
              (await request('beforeTool', index, [call, toolMetadata(tool)])) as Awaited<
                ReturnType<NonNullable<NonNullable<PreparedPlugin['hooks']>[number]['beforeTool']>>
              >,
          } satisfies Pick<NonNullable<PreparedPlugin['hooks']>[number], 'beforeTool'>)
        : {}),
      ...(hook.afterTool
        ? ({
            afterTool: async (call, tool, result) =>
              (await request('afterTool', index, [call, toolMetadata(tool), result])) as Awaited<
                ReturnType<NonNullable<NonNullable<PreparedPlugin['hooks']>[number]['afterTool']>>
              >,
          } satisfies Pick<NonNullable<PreparedPlugin['hooks']>[number], 'afterTool'>)
        : {}),
      ...(hook.onStop
        ? ({
            onStop: async (last) =>
              (await request('onStop', index, [last])) as Awaited<
                ReturnType<NonNullable<NonNullable<PreparedPlugin['hooks']>[number]['onStop']>>
              >,
          } satisfies Pick<NonNullable<PreparedPlugin['hooks']>[number], 'onStop'>)
        : {}),
    })),
    async dispose() {
      if (disposed) return;
      const cleanup = failure ? undefined : request('dispose', 0, []);
      disposed = true;
      try {
        await cleanup;
      } finally {
        fail(new Error('Plugin has been disposed.'));
        await worker.terminate();
      }
    },
  };
}
