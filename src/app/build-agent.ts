import { AnthropicProvider, OpenAIProvider, resolveModel } from '../ai/index.ts';
import type { AgentConfig } from '../agent/index.ts';
import type { SessionStore } from '../session/index.ts';
import { createDefaultTools, createBashTool } from '../tools/index.ts';
import { offloadHook } from '../context/offload.ts';
import { detectShell } from '../util/process.ts';
import { projectRoot } from '../util/paths.ts';
import { permissionHook } from '../hooks/permission.ts';
import { composeHooks, traceHooks } from '../hooks/compose.ts';
import { afterEditHook } from '../hooks/after-edit.ts';
import { stopCheckHook } from '../hooks/stop-check.ts';
import { loadPrompts } from './prompts.ts';
import { assembleSystemPrompt, systemCacheBoundary } from '../context/system-prompt.ts';
import { compactionHook } from '../context/compaction.ts';
import { collectInstructions } from '../memory/agents-md.ts';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { memoryDir, readIndex } from '../memory/memory-dir.ts';
import { renderTemplate } from './prompts.ts';
import type { StartRunOptions } from './run.ts';
const frozen = new WeakMap<SessionStore, { key: string; system: string }>();
const sessionApprovals = new WeakMap<SessionStore, Set<string>>();
export function buildAgent(opts: StartRunOptions, session: SessionStore): AgentConfig {
  if (!sessionApprovals.has(session)) sessionApprovals.set(session, new Set());
  const config = opts.config,
    model = resolveModel(config.model, config.models, config.provider),
    prompts = opts.runtimeSnapshot?.prompts ?? loadPrompts(config.promptsDir),
    shell = detectShell();
  const runtime = opts.runtimeSnapshot;
  const usesFiles = !runtime || runtime.profile.memory.some((id) => ['file-index', 'file-recall'].includes(id));
  const memory = opts.systemOverride || !usesFiles ? undefined : memoryDir(opts.home, opts.cwd);
  if (memory) mkdirSync(memory, { recursive: true });
  let tools = createDefaultTools(prompts.tools);
  if (shell.kind === 'powershell')
    tools = tools.map((t) =>
      t.name === 'bash'
        ? createBashTool(
            `Run commands using ${shell.name} (PowerShell syntax), not bash syntax. Each call starts a fresh shell. Stdin is closed. Default timeout 120s, maximum 600s.`,
            shell,
          )
        : t,
    );
  if (runtime) {
    const available = [...tools, ...runtime.tools];
    tools = runtime.profile.tools.map((name) => available.find((tool) => tool.name === name)!);
  }
  if (opts.toolsFilter) tools = tools.filter((t) => opts.toolsFilter!.includes(t.name));
  if (!model.supportsImages)
    tools = tools.map((t) =>
      t.name === 'read'
        ? {
            ...t,
            async execute(args, ctx) {
              const r = await t.execute(args, ctx);
              return {
                ...r,
                content: r.content.map((b) =>
                  b.type === 'image'
                    ? {
                        type: 'text' as const,
                        text: 'This model does not support images. Use a model with image support.',
                      }
                    : b,
                ),
              };
            },
          }
        : t,
    );
  const key = JSON.stringify([runtime?.id ?? 'default', opts.systemOverride, opts.includeProjectInstructions]);
  let system = frozen.get(session)?.key === key ? frozen.get(session)!.system : undefined;
  if (!system) {
    const branch = spawnSync('git', ['-C', opts.cwd, 'branch', '--show-current'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    const now = new Date(),
      date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    system = assembleSystemPrompt({
      base: [opts.systemOverride ?? prompts.system, ...(runtime?.fragments ?? [])].join('\n\n'),
      instructions:
        opts.includeProjectInstructions === false
          ? []
          : (runtime?.instructions ?? collectInstructions(opts.home, opts.cwd)),
      memory:
        memory && (!runtime || runtime.profile.memory.includes('file-index'))
          ? renderTemplate(prompts.fragments.memory, {
              memoryDir: memory,
              memoryIndex: runtime?.fileMemoryIndex ?? readIndex(memory).text,
            })
          : undefined,
      env: {
        cwd: opts.cwd,
        platform: process.platform,
        date,
        shell: `${shell.name} (${shell.kind === 'bash' ? 'bash syntax' : 'PowerShell syntax'})`,
        git: branch.status === 0 ? branch.stdout.trim() || 'unborn branch' : undefined,
      },
    });
    frozen.set(session, { key, system });
  }
  const provider = opts.provider ?? (model.provider === 'anthropic' ? new AnthropicProvider() : new OpenAIProvider());
  const reducer = compactionHook({
    provider,
    model,
    sessionDir: session.dir,
    template: prompts.compact,
    config: { ...config.compaction, ...(runtime?.profile.reducer === 'clear' ? { compactAtRatio: Infinity } : {}) },
    signal: opts.signal ?? new AbortController().signal,
    onSummary: (usage, latencyMs, cache) =>
      session.append({
        type: 'trace',
        name: 'turn',
        data: { kind: 'compaction', usage, latencyMs, ...(cache ? { cache } : {}) },
      }),
    onFailure: (message) =>
      session.append({ type: 'trace', name: 'hook', data: { hook: 'compaction', decision: 'failed', message } }),
  });
  const contextHook = runtime
    ? {
        async modelContext(messages: readonly import('../ai/index.ts').Message[]) {
          const ctx = {
            cwd: opts.cwd,
            home: opts.home,
            sessionDir: session.dir,
            prompt: opts.prompt,
            messages: structuredClone([...messages]),
            signal: opts.signal ?? new AbortController().signal,
          };
          const parts: string[] = [];
          if (runtime.profile.memory.includes('file-recall') && memory) parts.push(readIndex(memory).text);
          for (const strategy of runtime.memory) parts.push(await strategy.recall(ctx));
          for (const provider of runtime.context) parts.push(await provider.provide(ctx));
          return parts.filter((part) => part.trim()).join('\n\n');
        },
      }
    : {};
  let pluginContinuations = 0;
  const pluginHooks = (runtime?.hooks ?? []).map((hook) => ({
    ...hook,
    ...(hook.onStop
      ? {
          async onStop(last: import('../ai/index.ts').AssistantMessage) {
            const decision = await hook.onStop!(last);
            if (decision.action === 'continue') {
              if (pluginContinuations >= config.hooks.maxStopContinuations) {
                session.append({
                  type: 'trace',
                  name: 'hook',
                  data: { hook: hook.id, decision: 'stop', exhausted: true },
                });
                return { action: 'stop' } as const;
              }
              pluginContinuations++;
            }
            return decision;
          },
        }
      : {}),
  }));
  return {
    provider,
    model,
    system,
    systemCacheBoundary: systemCacheBoundary(system),
    tools,
    hooks: traceHooks(
      composeHooks(
        runtime?.profile.reducer === 'none'
          ? {}
          : runtime?.profile.reducer === 'clear'
            ? {
                beforeModel: (messages, info) =>
                  info.force ? Promise.resolve(undefined) : reducer.beforeModel!(messages, info),
              }
            : reducer,
        contextHook,
        permissionHook({
          mode: config.permissions.mode,
          root: projectRoot(opts.cwd),
          cwd: opts.cwd,
          allowedDirs: [session.dir, ...(memory ? [memory] : []), ...(opts.writeRoots ?? [])],
          ask: opts.ask,
          extraPatterns: config.permissions.extraRiskyPatterns.map((p) => new RegExp(p, 'i')),
          strictWriteRoots: opts.writeRoots,
          strictReadRoots: opts.strictReadRoots,
          strictWritePaths: opts.strictWritePaths,
          approvals: sessionApprovals.get(session),
        }),
        ...pluginHooks,
        afterEditHook({
          fileCwd: opts.cwd,
          cwd: projectRoot(opts.cwd),
          home: opts.home,
          commands: config.hooks.afterEdit,
          signal: opts.signal ?? new AbortController().signal,
        }),
        runtime?.profile.offload === false ? {} : offloadHook({ sessionDir: session.dir, ...config.toolOutput }),
        stopCheckHook({
          cwd: projectRoot(opts.cwd),
          home: opts.home,
          commands: config.hooks.onStop,
          maxContinuations: config.hooks.maxStopContinuations,
          template: prompts.fragments.stopContinue,
          signal: opts.signal ?? new AbortController().signal,
          onExhausted: (data) =>
            session.append({ type: 'trace', name: 'hook', data: { hook: 'stopCheck', exhausted: true, ...data } }),
        }),
      ),
      (data) => session.append({ type: 'trace', name: 'hook', data }),
    ),
    thinking: config.thinking,
    maxTurns: opts.maxTurns,
  };
}
