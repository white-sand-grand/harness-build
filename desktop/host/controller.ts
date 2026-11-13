import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { AnthropicProvider, OpenAIProvider, resolveModel } from '../../src/ai/index.ts';
import type { Message, Provider } from '../../src/ai/index.ts';
import type { AgentEvent } from '../../src/agent/index.ts';
import { loadConfig, mergeConfig, readProjectSensitive } from '../../src/app/config.ts';
import type { Config } from '../../src/app/config.ts';
import { startRun } from '../../src/app/run.ts';
import { createSession, listSessions, openSession } from '../../src/session/index.ts';
import type { SessionStore } from '../../src/session/index.ts';
import { trustHash } from '../../src/hooks/trust.ts';
import { matchesGlob } from '../../src/util/glob.ts';
import { projectRoot } from '../../src/util/paths.ts';
import type {
  Connection,
  ConversationMessage,
  HostCommand,
  ModelOption,
  Run,
  Snapshot,
  StartRun,
  VerificationState,
} from '../contracts.ts';
import { connectionFieldErrors } from '../contracts.ts';
import {
  DesktopCredentials,
  readConnections,
  validateConnection,
  writeConnections,
  type PrivateCredential,
} from './credentials.ts';

const execFileAsync = promisify(execFile);
const terminal = new Set(['completed', 'cancelled', 'failed']);
const projectHookWarning = '项目检查命令尚未授权；运行时可允许本次/会话，拒绝后忽略这些命令。';
const textOf = (message: Message) =>
  message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');
const clipped = (value: string, limit = 20_000) =>
  value.length > limit
    ? value.slice(0, Math.floor(limit * 0.7)) +
      '\n…（界面输出已截断，完整会话保存在本机）…\n' +
      value.slice(-Math.floor(limit * 0.3))
    : value;
type Decision = 'once' | 'session' | 'deny';
type ActiveRun = {
  run: Run;
  abort: AbortController;
  session: SessionStore;
  queue: Message[];
  config: Config;
  entryStart: number;
  done: Promise<void>;
  stopSeen: boolean;
  afterEdit: Map<string, boolean>;
};
export type DesktopControllerOptions = {
  home: string;
  promptsDir: string;
  onSnapshot: (snapshot: Snapshot) => void;
  credentialEnvironment?: Record<string, string>;
  providerFactory?: (connection: Connection, credential: PrivateCredential) => Provider | Promise<Provider>;
};

/** The only writer of an open desktop session. Renderer state never controls an in-flight run. */
export class DesktopController {
  private options: DesktopControllerOptions;
  private credentials: DesktopCredentials;
  private connections: Connection[];
  private state: Snapshot = {
    protocolVersion: 1,
    seq: 0,
    sessions: [],
    messages: [],
    activities: [],
    streamingText: '',
    approvals: [],
    models: [],
  };
  private session?: SessionStore;
  private active?: ActiveRun;
  private closed = false;
  private pending = new Map<string, { runId: string; resolve: (decision: Decision) => void }>();
  private hookApprovals = new WeakMap<SessionStore, Set<string>>();
  private publishTimer?: ReturnType<typeof setTimeout>;

  constructor(options: DesktopControllerOptions) {
    const { credentialEnvironment, ...rest } = options;
    this.options = { ...rest, home: resolve(options.home), promptsDir: resolve(options.promptsDir) };
    this.credentials = new DesktopCredentials(credentialEnvironment);
    this.connections = readConnections(this.options.home);
    this.state.models = this.connections.map((connection) => this.modelOption(connection, 'desktop'));
  }
  private clean(value: string, limit?: number): string {
    return clipped(this.credentials.redact(value), limit);
  }
  private snapshot(): Snapshot {
    return structuredClone(this.state);
  }
  private publish(): Snapshot {
    if (this.publishTimer) {
      clearTimeout(this.publishTimer);
      this.publishTimer = undefined;
    }
    this.state.seq++;
    const snapshot = this.snapshot();
    try {
      this.options.onSnapshot(snapshot);
    } catch {
      /* A disconnected view cannot fail an agent run. */
    }
    return snapshot;
  }
  private publishSoon(): void {
    this.publishTimer ??= setTimeout(() => {
      this.publishTimer = undefined;
      this.publish();
    }, 40);
  }
  private warning(message: string): void {
    const text = this.clean(message, 3000);
    if (!this.state.warning?.includes(text))
      this.state.warning = clipped([this.state.warning, text].filter(Boolean).join('\n'), 4000);
  }
  private assertIdle(): void {
    if (this.active) throw new Error('任务仍在运行；请先停止或等待完成后再切换项目/会话。');
  }
  private project(id?: string) {
    const project = this.state.project;
    if (!project || (id !== undefined && project.id !== id)) throw new Error('项目已切换或尚未打开，请刷新后重试。');
    return project;
  }
  private modelOption(connection: Connection, source: ModelOption['source']): ModelOption {
    const configurationIssue = Object.values(connectionFieldErrors(connection))[0];
    const credential = this.credentials.get(connection, { allowEnvironmentFallback: source !== 'project' });
    return {
      ...connection,
      source,
      credentialReady: !configurationIssue && !!credential,
      ...(configurationIssue ? { configurationIssue } : {}),
    };
  }
  private readConfig(cwd: string): Config {
    const snapshot = readProjectSensitive(cwd);
    const config = loadConfig({
      cwd,
      home: this.options.home,
      overrides: { promptsDir: this.options.promptsDir },
      warn: (message) =>
        this.warning(message.startsWith('Sensitive project configuration') ? projectHookWarning : message),
      ...(snapshot ? { projectData: snapshot.data } : {}),
    });
    // Desktop gates project model definitions through the connection picker (source marking,
    // credentialReady, explicit selection) instead of the CLI's file-level trust prompt, so
    // re-admit the model table and its provider; hooks/permissions/plugins stay gated.
    if (snapshot?.data.models)
      return mergeConfig(config, {
        models: snapshot.data.models,
        ...(snapshot.data.provider ? { provider: snapshot.data.provider } : {}),
      });
    return config;
  }
  private refreshModels(config?: Config): void {
    const models = this.connections.map((connection) => this.modelOption(connection, 'desktop'));
    if (this.state.project && config) {
      const ids = new Set(Object.keys(config.models));
      for (const file of [
        join(this.options.home, 'config.json'),
        join(projectRoot(this.state.project.path), '.mh', 'config.json'),
      ]) {
        if (!existsSync(file)) continue;
        const raw = JSON.parse(readFileSync(file, 'utf8')) as { model?: string };
        if (typeof raw.model === 'string' && raw.model.trim()) ids.add(raw.model);
      }
      for (const id of ids) {
        const model = resolveModel(id, config.models, config.provider);
        const connection: Connection = {
          id:
            'project-' +
            createHash('sha256')
              .update(
                JSON.stringify([
                  this.state.project.path,
                  model.provider,
                  id,
                  model.baseUrl ?? '',
                  model.apiKeyEnv ?? '',
                ]),
              )
              .digest('hex')
              .slice(0, 16),
          name: id,
          model: id,
          provider: model.provider,
          supportsThinking: model.supportsThinking,
          supportsImages: model.supportsImages,
          contextWindow: model.contextWindow,
          maxOutputTokens: model.maxOutputTokens,
          ...(model.baseUrl ? { baseUrl: model.baseUrl } : {}),
          ...(model.apiKeyEnv ? { apiKeyEnv: model.apiKeyEnv } : {}),
        };
        if (!models.some((existing) => existing.id === connection.id))
          models.push(this.modelOption(validateConnection(connection), 'project'));
      }
    }
    this.state.models = models;
  }
  private refreshSessions(): void {
    const project = this.project();
    this.state.sessions = listSessions(this.options.home, project.path)
      .slice(0, 200)
      .map((session) => ({
        id: session.id,
        title: this.clean(session.firstUserText || '新会话', 160),
        updatedAt: session.mtime.toISOString(),
      }));
  }
  private resetConversation(): void {
    this.state.messages = [];
    this.state.activities = [];
    this.state.streamingText = '';
    this.state.approvals = [];
    delete this.state.run;
    delete this.state.error;
    delete this.state.review;
  }
  private appendMessage(message: ConversationMessage): void {
    this.state.messages.push({ ...message, text: this.clean(message.text, 60_000) });
    let size = this.state.messages.reduce((sum, item) => sum + item.text.length, 0);
    while (this.state.messages.length > 100 || (size > 350_000 && this.state.messages.length > 1)) {
      size -= this.state.messages.shift()!.text.length;
      this.warning('界面仅保留最近部分消息；完整消息仍保存在原始会话中。');
    }
  }
  private restoreSession(session: SessionStore): void {
    this.session = session;
    this.resetConversation();
    this.state.selectedSessionId = session.id;
    const entries = session.entries();
    for (const entry of entries) {
      if (entry.type === 'message' && ['user', 'assistant'].includes(entry.message.role)) {
        this.appendMessage({
          id: entry.id,
          role: entry.message.role as ConversationMessage['role'],
          text: textOf(entry.message),
          ...(entry.message.role === 'assistant' ? { model: entry.message.model } : {}),
        });
      }
    }
    const saved = entries.findLast(
      (entry) => entry.type === 'trace' && entry.name === 'hook' && entry.data.hook === 'desktopRun',
    );
    const ended = entries.findLast((entry) => entry.type === 'trace' && entry.name === 'agentEnd');
    const lastMessage = entries.findLast((entry) => entry.type === 'message' && entry.message.role === 'assistant');
    const lastMessageIndex = entries.findLastIndex((entry) => entry.type === 'message');
    if (
      saved?.type === 'trace' &&
      entries.indexOf(saved) > lastMessageIndex &&
      saved.data.run &&
      typeof saved.data.run === 'object'
    ) {
      const run = saved.data.run as Run;
      if (
        typeof run.id === 'string' &&
        typeof run.modelId === 'string' &&
        typeof run.modelName === 'string' &&
        terminal.has(run.status) &&
        ['off', 'low', 'medium', 'high'].includes(run.thinking) &&
        ['notConfigured', 'notRun', 'passed', 'failed', 'incomplete'].includes(run.verification)
      )
        this.state.run = {
          id: run.id,
          sessionId: session.id,
          modelId: run.modelId,
          modelName: this.clean(run.modelName, 200),
          status: run.status,
          thinking: run.thinking,
          verification: run.verification,
          inputTokens: Number.isFinite(run.inputTokens) ? run.inputTokens : 0,
          outputTokens: Number.isFinite(run.outputTokens) ? run.outputTokens : 0,
          ...(run.error ? { error: this.clean(run.error, 3000) } : {}),
        };
    } else if (ended?.type === 'trace' && entries.indexOf(ended) > lastMessageIndex) {
      const model =
        lastMessage?.type === 'message' && lastMessage.message.role === 'assistant'
          ? lastMessage.message.model
          : '历史模型';
      this.state.run = {
        id: 'history-' + session.id,
        sessionId: session.id,
        status: ended.data.reason === 'done' ? 'completed' : ended.data.reason === 'aborted' ? 'cancelled' : 'failed',
        modelId: model,
        modelName: model,
        thinking: 'off',
        verification: 'incomplete',
        inputTokens: 0,
        outputTokens: 0,
      };
      this.warning('该历史会话未记录桌面检查结论与完整工具详情；恢复消息，不自动重放操作。');
    } else if (this.state.messages.length) {
      this.warning('上次会话没有完整结束记录；再次发送会继续保存的上下文，不自动重放旧工具。');
    }
  }
  private requireActive(runId: string): ActiveRun {
    if (!this.active || this.active.run.id !== runId) throw new Error('该任务已结束或运行 ID 已过期。');
    return this.active;
  }
  private async ask(active: ActiveRun, question: { title: string; detail: string }): Promise<Decision> {
    if (this.active !== active || active.abort.signal.aborted) return 'deny';
    const id = randomUUID();
    const answer = new Promise<Decision>((resolveAnswer) =>
      this.pending.set(id, { runId: active.run.id, resolve: resolveAnswer }),
    );
    this.state.approvals.push({
      id,
      runId: active.run.id,
      title: this.clean(question.title, 500),
      detail: this.clean(question.detail, 12_000),
    });
    active.run.status = 'waitingApproval';
    this.publish();
    const decision = await answer;
    this.pending.delete(id);
    this.state.approvals = this.state.approvals.filter((approval) => approval.id !== id);
    if (!active.abort.signal.aborted && this.active === active) active.run.status = 'running';
    this.publish();
    return decision;
  }
  private onEvent(active: ActiveRun, event: AgentEvent): void {
    if (this.active !== active) return;
    if (event.type === 'agentStart' || event.type === 'turnStart') {
      if (!active.abort.signal.aborted) active.run.status = 'thinking';
    } else if (event.type === 'stream') {
      if (event.event.type === 'textDelta') {
        this.state.streamingText = this.clean(this.state.streamingText + event.event.text, 60_000);
        if (!active.abort.signal.aborted) active.run.status = 'running';
      } else if (event.event.type === 'thinkingDelta' && !active.abort.signal.aborted) active.run.status = 'thinking';
      this.publishSoon();
      return;
    } else if (event.type === 'message') {
      const message = event.message;
      if (message.role === 'user' || message.role === 'assistant') {
        const entry = active.session.entries().findLast((item) => item.type === 'message');
        this.appendMessage({
          id: entry?.id ?? randomUUID(),
          role: message.role,
          text: textOf(message),
          ...(message.role === 'assistant' ? { model: message.model } : {}),
        });
        if (message.role === 'assistant') {
          this.state.streamingText = '';
          active.run.inputTokens += message.usage.input + message.usage.cacheRead + message.usage.cacheWrite;
          active.run.outputTokens += message.usage.output;
        }
      }
    } else if (event.type === 'toolStart') {
      if (!active.abort.signal.aborted) active.run.status = 'running';
      this.state.activities.push({
        id: event.call.id,
        name: event.call.name,
        status: 'running',
        input: this.clean(JSON.stringify(event.call.args)),
        output: '',
      });
      if (this.state.activities.length > 80) this.state.activities.shift();
    } else if (event.type === 'toolUpdate') {
      const activity = this.state.activities.find((item) => item.id === event.callId);
      if (activity) activity.output = this.clean(activity.output + event.text);
      this.publishSoon();
      return;
    } else if (event.type === 'toolEnd') {
      const activity = this.state.activities.find((item) => item.id === event.call.id);
      const details = event.result.details as { diff?: unknown; exitCode?: unknown } | undefined;
      const output = event.result.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n');
      if (activity) {
        activity.status =
          event.result.isError || (typeof details?.exitCode === 'number' && details.exitCode !== 0)
            ? 'failed'
            : 'completed';
        activity.output = this.clean(output);
        activity.durationMs = event.durationMs;
        if (typeof details?.diff === 'string') activity.diff = this.clean(details.diff);
      }
      if (['write', 'edit'].includes(event.call.name) && typeof event.call.args.path === 'string') {
        const path = relative(projectRoot(this.project().path), resolve(this.project().path, event.call.args.path));
        const checks = active.config.hooks.afterEdit.filter((hook) => !hook.match || matchesGlob(hook.match, path));
        if (checks.length && (!event.result.isError || output.includes('[after-edit check failed:')))
          active.afterEdit.set(path, !event.result.isError);
      }
    } else if (event.type === 'stopHook') {
      active.stopSeen = true;
      if (active.config.hooks.onStop.length)
        active.run.verification = event.decision.action === 'continue' ? 'failed' : 'notRun';
    } else if (event.type === 'agentEnd' && event.error) active.run.error = this.clean(event.error, 3000);
    this.publish();
  }
  private verification(active: ActiveRun, reason: string): VerificationState {
    const configured = active.config.hooks.onStop.length || active.config.hooks.afterEdit.length;
    if (!configured) return 'notConfigured';
    const trace = active.session.entries().slice(active.entryStart);
    if (trace.some((entry) => entry.type === 'trace' && entry.name === 'hook' && entry.data.exhausted)) return 'failed';
    if (reason === 'aborted') return 'incomplete';
    if (active.config.hooks.onStop.length) {
      if (
        active.stopSeen &&
        trace.some(
          (entry) =>
            entry.type === 'trace' &&
            entry.name === 'hook' &&
            entry.data.hook === 'onStop' &&
            entry.data.decision === 'stop',
        )
      )
        return 'passed';
      return reason === 'done' ? 'notRun' : 'incomplete';
    }
    if ([...active.afterEdit.values()].some((passed) => !passed)) return 'failed';
    if (active.afterEdit.size) return 'passed';
    return reason === 'done' ? 'notRun' : 'incomplete';
  }
  private begin(input: StartRun): void {
    this.assertIdle();
    const project = this.project(input.projectId);
    if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 100_000)
      throw new Error('请输入任务要求，最多 100000 个字符。');
    if (!['off', 'low', 'medium', 'high'].includes(input.thinking)) throw new Error('思考深度无效。');
    this.state.warning = undefined;
    let config = this.readConfig(project.path);
    this.refreshModels(config);
    const selected = this.state.models.find((model) => model.id === input.modelId);
    if (!selected) throw new Error('模型连接已变化，请重新选择。');
    const connection = validateConnection({
      id: selected.id,
      name: selected.name,
      provider: selected.provider,
      model: selected.model,
      supportsThinking: selected.supportsThinking,
      supportsImages: selected.supportsImages,
      contextWindow: selected.contextWindow,
      maxOutputTokens: selected.maxOutputTokens,
      ...(selected.baseUrl ? { baseUrl: selected.baseUrl } : {}),
      ...(selected.apiKeyEnv ? { apiKeyEnv: selected.apiKeyEnv } : {}),
    });
    const credential = this.credentials.get(connection, {
      allowEnvironmentFallback: selected.source !== 'project',
    });
    if (!credential) throw new Error('该连接尚无可用密钥；请先配置本次连接凭据。');
    const thinking = connection.supportsThinking ? input.thinking : 'off';
    if (thinking !== input.thinking) this.warning('该连接未声明可选择思考深度；本轮使用端点默认设置。');
    config = mergeConfig(config, {
      provider: connection.provider,
      model: connection.model,
      thinking,
      models: {
        [connection.model]: {
          ...(selected.source === 'project' ? config.models[connection.model] : {}),
          provider: connection.provider,
          supportsThinking: connection.supportsThinking,
          supportsImages: connection.supportsImages,
          contextWindow: connection.contextWindow,
          maxOutputTokens: connection.maxOutputTokens,
          ...(connection.baseUrl ? { baseUrl: connection.baseUrl } : {}),
          ...(connection.apiKeyEnv ? { apiKeyEnv: connection.apiKeyEnv } : {}),
        },
      },
    });
    const session = input.sessionId
      ? this.session?.id === input.sessionId
        ? this.session
        : openSession(this.options.home, project.path, input.sessionId)
      : createSession(this.options.home, project.path);
    if (this.session !== session) this.restoreSession(session);
    this.state.activities = [];
    this.state.streamingText = '';
    this.state.approvals = [];
    delete this.state.error;
    delete this.state.review;
    const run: Run = {
      id: randomUUID(),
      sessionId: session.id,
      status: 'running',
      modelId: connection.id,
      modelName: connection.name,
      thinking,
      verification: config.hooks.onStop.length || config.hooks.afterEdit.length ? 'notRun' : 'notConfigured',
      inputTokens: 0,
      outputTokens: 0,
    };
    this.state.run = run;
    this.state.selectedSessionId = session.id;
    const active: ActiveRun = {
      run,
      session,
      config: structuredClone(config),
      abort: new AbortController(),
      queue: [],
      entryStart: session.entries().length,
      done: Promise.resolve(),
      stopSeen: false,
      afterEdit: new Map(),
    };
    this.active = active;
    active.done = Promise.resolve().then(async () => {
      let reason = 'error';
      try {
        const hooks = readProjectSensitive(project.path)?.sensitive.hooks as Config['hooks'] | undefined;
        if (hooks) {
          const hash = trustHash(hooks);
          const approved = this.hookApprovals.get(session) ?? new Set<string>();
          if (!this.hookApprovals.has(session)) this.hookApprovals.set(session, approved);
          const decision = approved.has(hash)
            ? 'session'
            : await this.ask(active, {
                title: '允许项目检查命令？',
                detail: JSON.stringify(hooks, null, 2) + '\n允许本次只对本轮有效；允许会话只对当前会话与这些命令有效。',
              });
          this.state.warning =
            this.state.warning
              ?.split('\n')
              .filter((line) => line !== projectHookWarning)
              .join('\n') || undefined;
          if (decision !== 'deny' && !active.abort.signal.aborted) {
            // loadConfig already validated this exact object; do not persist trust for once/session grants.
            active.config = mergeConfig(active.config, { hooks: hooks as Config['hooks'] });
            if (decision === 'session') approved.add(hash);
            active.run.verification =
              active.config.hooks.onStop.length || active.config.hooks.afterEdit.length ? 'notRun' : 'notConfigured';
          } else this.warning('项目检查命令未获准，本轮忽略这些命令。');
        }
        if (active.abort.signal.aborted) reason = 'aborted';
        else {
          const provider = this.options.providerFactory
            ? await this.options.providerFactory(structuredClone(connection), { ...credential })
            : connection.provider === 'anthropic'
              ? new AnthropicProvider(credential)
              : new OpenAIProvider({ apiKey: credential.apiKey });
          const result = await startRun({
            cwd: project.path,
            home: this.options.home,
            config: active.config,
            session,
            prompt: input.prompt.trim(),
            provider,
            signal: active.abort.signal,
            ask: (question) => this.ask(active, question),
            getSteering: () => active.queue.splice(0),
            onEvent: (event) => this.onEvent(active, event),
            maxTurns: 50,
          });
          reason = result.reason;
          active.run.inputTokens = result.usage.input + result.usage.cacheRead + result.usage.cacheWrite;
          active.run.outputTokens = result.usage.output;
        }
      } catch (error) {
        active.run.error = this.clean(error instanceof Error ? error.message : String(error), 3000);
        reason = active.abort.signal.aborted ? 'aborted' : 'error';
      } finally {
        for (const [id, pending] of this.pending)
          if (pending.runId === active.run.id) {
            this.pending.delete(id);
            pending.resolve('deny');
          }
        this.state.approvals = [];
        active.run.status = reason === 'done' ? 'completed' : reason === 'aborted' ? 'cancelled' : 'failed';
        if (reason === 'maxTurns') active.run.error = '任务达到 50 轮预算；可以审阅后继续。';
        active.run.verification = this.verification(active, reason);
        for (const activity of this.state.activities) if (activity.status === 'running') activity.status = 'failed';
        this.state.streamingText = '';
        try {
          session.append({
            type: 'trace',
            name: 'hook',
            data: { hook: 'desktopRun', run: structuredClone(active.run) },
          });
        } catch {
          this.warning('任务已结束，但桌面结果摘要写入失败；原始会话仍可检查。');
        }
        if (this.active === active) this.active = undefined;
        active.queue.length = 0;
        try {
          this.refreshSessions();
        } catch {
          this.warning('会话列表刷新失败。');
        }
        this.publish();
      }
    });
  }
  private async review(projectId: string): Promise<void> {
    const project = this.project(projectId);
    const git = async (args: string[]) =>
      execFileAsync('git', ['-c', 'core.fsmonitor=false', '-c', 'core.quotepath=false', ...args], {
        cwd: project.path,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 10_000,
        maxBuffer: 512 * 1024,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
      });
    try {
      const status = await git(['status', '--porcelain=v1', '--untracked-files=all']);
      const parts = await Promise.allSettled([
        git(['diff', '--no-ext-diff', '--no-textconv', '--']),
        git(['diff', '--cached', '--no-ext-diff', '--no-textconv', '--']),
      ]);
      const outputs = parts.map((part) =>
        part.status === 'fulfilled' ? part.value.stdout : String((part.reason as { stdout?: unknown }).stdout ?? ''),
      );
      const raw = '[未暂存]\n' + outputs[0] + '\n[已暂存]\n' + outputs[1];
      this.project(projectId);
      this.state.review = {
        available: true,
        scope: 'workingTree',
        summary: this.clean(
          '工作区当前全部变更，包含用户原有修改；不代表本任务归因。未跟踪文件只列名称。\n' +
            (status.stdout || '工作区无变更。'),
          20_000,
        ),
        diff: this.clean(raw, 120_000),
        truncated:
          raw.length > 120_000 || status.stdout.length > 20_000 || parts.some((part) => part.status === 'rejected'),
        capturedAt: new Date().toISOString(),
      };
    } catch {
      this.project(projectId);
      this.state.review = {
        available: false,
        scope: 'workingTree',
        summary: '当前目录无法读取 Git 工作区。',
        diff: '',
        truncated: false,
        capturedAt: new Date().toISOString(),
        error: '请确认 Git 已安装且所选目录属于 Git 仓库。',
      };
    }
  }
  async handle(command: HostCommand): Promise<Snapshot> {
    if (this.closed && command.method !== 'snapshot') throw new Error('执行宿主已关闭。');
    switch (command.method) {
      case 'snapshot':
        return this.snapshot();
      case 'openProject': {
        this.assertIdle();
        let path: string;
        try {
          path = realpathSync(resolve(command.path));
          if (!statSync(path).isDirectory()) throw new Error();
        } catch {
          throw new Error('请选择真实存在的项目文件夹。');
        }
        this.state.warning = undefined;
        const config = this.readConfig(path);
        this.state.project = {
          id: createHash('sha256').update(path).digest('hex').slice(0, 20),
          path,
          name: basename(path) || path,
        };
        this.session = undefined;
        delete this.state.selectedSessionId;
        this.resetConversation();
        this.refreshModels(config);
        this.refreshSessions();
        break;
      }
      case 'openSession': {
        this.assertIdle();
        const project = this.project(command.projectId);
        this.restoreSession(openSession(this.options.home, project.path, command.sessionId));
        break;
      }
      case 'newSession': {
        this.assertIdle();
        const project = this.project(command.projectId);
        this.restoreSession(createSession(this.options.home, project.path));
        this.refreshSessions();
        break;
      }
      case 'saveConnection': {
        const connection = validateConnection(command.connection);
        if (command.apiKey !== undefined) this.credentials.set(connection.id, command.apiKey);
        this.credentials.get(connection);
        const next = this.connections.filter((item) => item.id !== connection.id).concat(connection);
        writeConnections(this.options.home, next);
        this.connections = next;
        this.refreshModels(this.state.project ? this.readConfig(this.state.project.path) : undefined);
        break;
      }
      case 'startRun':
        this.begin(structuredClone(command.input));
        break;
      case 'steer': {
        const active = this.requireActive(command.runId);
        if (active.abort.signal.aborted) throw new Error('任务正在停止，不能再追加输入。');
        if (
          typeof command.text !== 'string' ||
          !command.text.trim() ||
          command.text.length > 100_000 ||
          active.queue.length >= 20
        )
          throw new Error('补充输入为空、过长或队列已满。');
        active.queue.push({ role: 'user', content: [{ type: 'text', text: command.text.trim() }] });
        break;
      }
      case 'approve': {
        this.requireActive(command.runId);
        const pending = this.pending.get(command.approvalId);
        if (!pending || pending.runId !== command.runId || !['once', 'session', 'deny'].includes(command.decision))
          throw new Error('审批已失效或不属于该任务。');
        this.pending.delete(command.approvalId);
        pending.resolve(command.decision);
        this.state.approvals = this.state.approvals.filter((item) => item.id !== command.approvalId);
        break;
      }
      case 'cancel': {
        if (!this.active && this.state.run?.id === command.runId && terminal.has(this.state.run.status))
          return this.snapshot();
        const active = this.requireActive(command.runId);
        active.run.status = 'cancelling';
        active.abort.abort();
        for (const [id, pending] of this.pending)
          if (pending.runId === command.runId) {
            this.pending.delete(id);
            pending.resolve('deny');
          }
        this.state.approvals = [];
        this.publish();
        await active.done;
        return this.snapshot();
      }
      case 'review':
        await this.review(command.projectId);
        break;
      case 'shutdown': {
        if (this.active) await this.handle({ method: 'cancel', runId: this.active.run.id });
        this.closed = true;
        this.credentials.clear();
        this.state.models = this.state.models.map((model) => ({ ...model, credentialReady: false }));
        break;
      }
      default:
        throw new Error('未知的桌面宿主命令。');
    }
    return this.publish();
  }
}
