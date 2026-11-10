import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import type { Tool } from '../agent/index.ts';
import type { Asker } from '../hooks/permission.ts';
import { isProjectTrusted, trustHash, trustProjectHooks } from '../hooks/trust.ts';
import { collectInstructions } from '../memory/agents-md.ts';
import { memoryDir, readIndex } from '../memory/memory-dir.ts';
import type { Config } from './config.ts';
import { validateConfig } from './config-schema.ts';
import { inspectPlugin, loadPlugin } from './plugin-loader.ts';
import type {
  ContextProvider,
  HookContribution,
  MemoryStrategy,
  PluginDescriptor,
  PreparedPlugin,
  RuntimeProfile,
} from './plugin-types.ts';
import { readPromptSelection } from './prompt-selection.ts';
import type { Prompts } from './prompts.ts';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const defaults = ['read', 'write', 'edit', 'bash'];
type SelectedProfile = Required<
  Pick<RuntimeProfile, 'tools' | 'context' | 'memory' | 'prompts' | 'hooks' | 'reducer' | 'offload'>
> &
  RuntimeProfile;
export type RuntimeSnapshot = {
  id: string;
  actorHash: string;
  promptHash: string;
  profileName: string;
  profile: SelectedProfile;
  config: Config;
  prompts: Prompts;
  instructions: ReturnType<typeof collectInstructions>;
  fileMemoryIndex?: string;
  plugins: PluginDescriptor[];
  sourceDirectories: string[];
  tools: Tool[];
  context: ContextProvider[];
  memory: MemoryStrategy[];
  fragments: string[];
  hooks: HookContribution[];
};
type Generation = {
  snapshot: RuntimeSnapshot;
  plugins: PreparedPlugin[];
  refs: number;
  retired: boolean;
  done: Promise<void>;
  finish: () => void;
  disposing?: Promise<void>;
};
export type RuntimeLease = { snapshot: RuntimeSnapshot; release(): Promise<void> };
export type RuntimeOptions = {
  cwd: string;
  home: string;
  config: Config;
  readConfig?: () => Config;
  ask?: Asker;
  trustPlugins?: boolean;
  onDiagnostic?: (message: string) => void;
};
function freezeData<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freezeData(item);
    Object.freeze(value);
  }
  return value;
}
function select<T extends { id: string }>(names: string[], entries: T[], kind: string): T[] {
  if (new Set(names).size !== names.length) throw new Error(`Duplicate ${kind} selection.`);
  const registry = new Map<string, T>();
  for (const entry of entries) {
    if (registry.has(entry.id)) throw new Error(`Duplicate ${kind}: ${entry.id}`);
    registry.set(entry.id, entry);
  }
  return names.map((id) => {
    if (!registry.has(id)) throw new Error(`Unknown ${kind}: ${id}`);
    return registry.get(id)!;
  });
}

export class RuntimeManager {
  private opts: RuntimeOptions;
  private active?: Generation;
  private generations = new Set<Generation>();
  private serial: Promise<unknown> = Promise.resolve();
  private timer?: ReturnType<typeof setInterval>;
  private closed = false;
  private initializing = false;
  private selected?: string;
  private observed = '';
  private dirty = false;
  private error?: string;
  private approvals = new Set<string>();
  constructor(opts: RuntimeOptions) {
    this.opts = opts;
  }
  private input() {
    const config = structuredClone(this.opts.readConfig?.() ?? this.opts.config);
    validateConfig(config, 'runtime');
    const name = this.selected ?? config.runtime?.profile ?? 'default';
    const chosen = config.runtime?.profiles?.[name];
    if (!chosen && name !== 'default') throw new Error(`Unknown runtime profile: ${name}`);
    const profile: SelectedProfile = {
      tools: defaults,
      context: [],
      memory: ['file-index'],
      prompts: [],
      hooks: [],
      reducer: 'default',
      offload: true,
      ...chosen,
    };
    if (profile.memory.includes('file-index') && profile.memory.includes('file-recall'))
      throw new Error('file-index and file-recall are mutually exclusive.');
    for (const key of ['tools', 'context', 'memory', 'prompts', 'hooks'] as const)
      if (new Set(profile[key]).size !== profile[key].length) throw new Error(`Duplicate ${key} selection.`);
    const plugins = (config.runtime?.plugins ?? []).map((p) => inspectPlugin(resolve(this.opts.cwd, p)));
    if (new Set(plugins.map((p) => p.id)).size !== plugins.length) throw new Error('Duplicate plugin id.');
    const prompts = readPromptSelection(config, profile, this.opts.cwd);
    const instructions = collectInstructions(this.opts.home, this.opts.cwd);
    const fileMemoryIndex = profile.memory.includes('file-index')
      ? readIndex(memoryDir(this.opts.home, this.opts.cwd)).text
      : undefined;
    return { config, name, profile, plugins, ...prompts, instructions, fileMemoryIndex };
  }
  private stamp(input: ReturnType<RuntimeManager['input']>) {
    return hash({
      config: input.config,
      name: input.name,
      profile: input.profile,
      plugins: input.plugins.map((p) => [p.id, p.fingerprint]),
      promptHash: input.hash,
      instructions: input.instructions,
      fileMemoryIndex: input.fileMemoryIndex,
    });
  }
  private async authorize(descriptor: PluginDescriptor, initial: boolean) {
    const identity = { kind: 'runtime-plugin', id: descriptor.id, fingerprint: descriptor.fingerprint };
    const key = trustHash(identity);
    if (this.approvals.has(key) || isProjectTrusted(this.opts.home, this.opts.cwd, identity)) return true;
    if (initial && this.opts.trustPlugins) {
      trustProjectHooks(this.opts.home, this.opts.cwd, identity);
      return true;
    }
    const answer = await this.opts.ask?.({
      title: `Load plugin ${descriptor.id}@${descriptor.version}?`,
      detail: `${descriptor.directory}\nSHA256 ${descriptor.fingerprint}\nFiles: ${descriptor.files.join(', ')}`,
    });
    if (answer === 'session') this.approvals.add(key);
    return answer === 'once' || answer === 'session';
  }
  private async prepare(initial: boolean): Promise<Generation> {
    const input = this.input(),
      loaded: PreparedPlugin[] = [];
    try {
      for (const plugin of input.plugins)
        loaded.push(
          await loadPlugin({
            directory: plugin.directory,
            cwd: this.opts.cwd,
            home: this.opts.home,
            authorize: async (candidate) =>
              candidate.fingerprint === plugin.fingerprint && (await this.authorize(candidate, initial)),
          }),
        );
      const tools = loaded.flatMap((p) => p.tools ?? []);
      select(input.profile.tools, [...defaults.map((id) => ({ id })), ...tools.map((t) => ({ id: t.name }))], 'tool');
      const context = select(
        input.profile.context,
        loaded.flatMap((p) => p.context ?? []),
        'context',
      );
      const memory = select(
        input.profile.memory.filter((id) => !['file-index', 'file-recall'].includes(id)),
        loaded.flatMap((p) => p.memory ?? []),
        'memory',
      );
      const hooks = select(
        input.profile.hooks,
        loaded.flatMap((p) => p.hooks ?? []),
        'hook',
      );
      const prompts = loaded.flatMap((p) => Object.entries(p.prompts ?? {}).map(([id, text]) => ({ id, text })));
      const fragments = select(input.profile.prompts, prompts, 'prompt').map((p) => p.text);
      const { promptsDir: _dir, promptArtifact: _artifact, ...composition } = input.profile;
      const actorHash = hash({
        profile: input.name,
        composition,
        plugins: input.plugins.map((p) => [p.id, p.version, p.fingerprint]),
      });
      const snapshot: RuntimeSnapshot = Object.freeze({
        id: this.stamp(input),
        actorHash,
        promptHash: input.hash,
        profileName: input.name,
        profile: freezeData(structuredClone(input.profile)),
        config: freezeData(input.config),
        prompts: freezeData(structuredClone(input.prompts)),
        instructions: freezeData(input.instructions),
        fileMemoryIndex: input.fileMemoryIndex,
        plugins: freezeData(input.plugins),
        tools: freezeData(tools),
        sourceDirectories: freezeData(
          input.plugins.map((plugin) => join(this.opts.home, 'runtime', 'plugins', plugin.fingerprint)),
        ),
        context: freezeData(context),
        memory: freezeData(memory),
        hooks: freezeData(hooks),
        fragments: freezeData(fragments),
      });
      let finish!: () => void;
      return {
        snapshot,
        plugins: loaded,
        refs: 0,
        retired: false,
        done: new Promise<void>((r) => {
          finish = r;
        }),
        finish,
      };
    } catch (error) {
      await Promise.allSettled(loaded.map((p) => p.dispose?.()));
      throw error;
    }
  }
  private async dispose(generation: Generation) {
    if (!generation.retired || generation.refs) return;
    generation.disposing ??= (async () => {
      const results = await Promise.allSettled(generation.plugins.map((p) => p.dispose?.()));
      for (const result of results)
        if (result.status === 'rejected') this.opts.onDiagnostic?.('Plugin disposal failed.');
      this.generations.delete(generation);
      generation.finish();
    })();
    await generation.disposing;
  }
  private syncWatcher() {
    if (this.active?.snapshot.config.runtime?.watch && !this.closed && !this.timer) {
      this.timer = setInterval(() => this.scan(), 500);
      this.timer.unref();
    } else if ((!this.active?.snapshot.config.runtime?.watch || this.closed) && this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
  initialize(): Promise<RuntimeManager> {
    if (this.active || this.initializing || this.closed)
      return Promise.reject(new Error('Runtime cannot be initialized.'));
    this.initializing = true;
    const operation = this.serial.then(async () => {
      if (this.closed) throw new Error('Runtime is closed.');
      const generation = await this.prepare(true);
      if (this.closed) {
        generation.retired = true;
        await this.dispose(generation);
        throw new Error('Runtime is closed.');
      }
      this.active = generation;
      this.generations.add(generation);
      this.observed = generation.snapshot.id;
      this.syncWatcher();
      return this;
    });
    this.serial = operation.catch(() => {});
    return operation;
  }
  private scan() {
    if (this.closed) return;
    let next: string;
    try {
      next = this.stamp(this.input());
    } catch (error) {
      next = 'error:' + String(error);
    }
    if (next !== this.observed) {
      this.observed = next;
      this.dirty = true;
    }
  }
  status() {
    return {
      id: this.active?.snapshot.id,
      profile: this.active?.snapshot.profileName,
      plugins:
        this.active?.snapshot.plugins.map((p) => ({ id: p.id, version: p.version, fingerprint: p.fingerprint })) ?? [],
      activeRuns: [...this.generations].reduce((n, g) => n + g.refs, 0),
      generations: this.generations.size,
      dirty: this.dirty,
      ...(this.error ? { error: this.error } : {}),
    };
  }
  reload(profile?: string): Promise<{ ok: boolean; error?: string }> {
    const operation = this.serial.then(async () => {
      if (this.closed) throw new Error('Runtime is closed.');
      const previous = this.selected;
      if (profile !== undefined) this.selected = profile;
      try {
        const next = await this.prepare(false);
        if (this.closed) {
          next.retired = true;
          await this.dispose(next);
          throw new Error('Runtime is closed.');
        }
        const old = this.active;
        this.active = next;
        this.generations.add(next);
        this.observed = next.snapshot.id;
        this.dirty = false;
        this.error = undefined;
        this.syncWatcher();
        if (old) {
          old.retired = true;
          await this.dispose(old);
        }
        return { ok: true };
      } catch (error) {
        this.selected = previous;
        this.error = error instanceof Error ? error.message : String(error);
        this.dirty = false;
        this.opts.onDiagnostic?.(`Reload failed; previous runtime retained: ${this.error}`);
        return { ok: false, error: this.error };
      }
    });
    this.serial = operation.catch(() => {});
    return operation;
  }
  async acquireRun(): Promise<RuntimeLease> {
    if (this.closed || !this.active) throw new Error('Runtime is not available.');
    if (this.timer) {
      this.scan();
      if (this.dirty) await this.reload();
    }
    await this.serial;
    if (this.closed || !this.active) throw new Error('Runtime is not available.');
    const generation = this.active;
    generation.refs++;
    let released = false;
    return {
      snapshot: generation.snapshot,
      release: async () => {
        if (released) return;
        released = true;
        generation.refs--;
        await this.dispose(generation);
      },
    };
  }
  async close() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    await this.serial;
    const generations = [...this.generations];
    for (const generation of generations) {
      generation.retired = true;
      await this.dispose(generation);
    }
    await Promise.all(generations.map((g) => g.done));
  }
}
export const createRuntime = (opts: RuntimeOptions) => new RuntimeManager(opts).initialize();
/** Evaluation forks workers from authorized source bytes, never from changing development files. */
export function snapshotConfigForRun(snapshot: RuntimeSnapshot, promptsDir: string): Config {
  for (const [index, directory] of snapshot.sourceDirectories.entries())
    if (inspectPlugin(directory).fingerprint !== snapshot.plugins[index]!.fingerprint)
      throw new Error('Frozen plugin source changed before evaluation.');
  const profile: RuntimeProfile = { ...snapshot.profile, promptsDir };
  delete profile.promptArtifact;
  return {
    ...snapshot.config,
    promptsDir,
    runtime: {
      watch: false,
      profile: snapshot.profileName,
      profiles: { [snapshot.profileName]: profile },
      plugins: [...snapshot.sourceDirectories],
    },
  };
}
