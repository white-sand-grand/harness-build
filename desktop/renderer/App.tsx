import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent, ReactNode } from 'react';
import type { Activity, Connection, HostCommand, ModelOption, Run, Snapshot, ThinkingLevel } from '../contracts.ts';
import { connectionFieldErrors } from '../contracts.ts';

const activeStates = new Set<Run['status']>(['running', 'thinking', 'waitingApproval', 'cancelling']);
const runLabels: Record<Run['status'], string> = {
  running: '正在执行',
  thinking: '正在思考',
  waitingApproval: '等待确认',
  cancelling: '正在停止',
  completed: '已结束',
  cancelled: '已中断',
  failed: '运行失败',
};
const verificationLabels: Record<Run['verification'], string> = {
  notConfigured: '未配置结束检查',
  notRun: '尚未验证',
  passed: '检查通过',
  failed: '检查失败',
  incomplete: '验证未完成',
};
const effortLabels: Record<ThinkingLevel, string> = { off: '默认', low: '轻量', medium: '标准', high: '深入' };
const efforts = Object.keys(effortLabels) as ThinkingLevel[];
const emptySnapshot: Snapshot = {
  protocolVersion: 1,
  seq: -1,
  sessions: [],
  messages: [],
  activities: [],
  streamingText: '',
  approvals: [],
  models: [],
};
type Draft = { text: string; modelId: string; thinking: ThinkingLevel; efforts: Record<string, ThinkingLevel> };

function errorText(error: unknown): string {
  return error instanceof Error
    ? error.message.replace(/^Error invoking remote method ['"][^'"]+['"]:\s*(?:Error:\s*)?/, '')
    : '操作未完成，请重试。';
}

function Moon({ phase = 'full', className = '' }: { phase?: string; className?: string }) {
  return (
    <span className={`moon ${className}`} data-phase={phase} aria-hidden="true">
      <span />
    </span>
  );
}

function Icon({ name }: { name: 'plus' | 'folder' | 'arrow' | 'close' | 'settings' | 'theme' | 'panel' | 'stop' }) {
  const paths = {
    plus: 'M12 5v14M5 12h14',
    folder: 'M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10H3Z',
    arrow: 'M12 19V5m-5 5 5-5 5 5',
    close: 'm6 6 12 12M18 6 6 18',
    settings: 'M4 7h16M4 17h16M8 4v6m8 4v6',
    theme: 'M20 14a8 8 0 0 1-10-10 8 8 0 1 0 10 10Z',
    panel: 'M3 4h18v16H3ZM14 4v16',
    stop: 'M6 6h12v12H6Z',
  };
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}

function Button({
  children,
  onClick,
  disabled,
  className = '',
  title,
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
  title?: string;
}) {
  return (
    <button type="button" className={`button ${className}`} disabled={disabled} onClick={onClick} title={title}>
      {children}
    </button>
  );
}

function ActivityCard({ activity }: { activity: Activity }) {
  return (
    <details className={`activity ${activity.status}`}>
      <summary>
        <span className="activity-dot" />
        <strong>{activity.name}</strong>
        <span className="activity-state">
          {activity.status === 'running' ? '执行中' : activity.status === 'failed' ? '失败' : '已结束'}
          {activity.durationMs !== undefined ? ` · ${(activity.durationMs / 1000).toFixed(1)} 秒` : ''}
        </span>
      </summary>
      {activity.input && (
        <section>
          <h4>输入</h4>
          <pre>{activity.input}</pre>
        </section>
      )}
      <section>
        <h4>输出</h4>
        <pre>{activity.output || (activity.status === 'running' ? '等待工具输出…' : '没有文本输出。')}</pre>
      </section>
      {activity.diff && (
        <section>
          <h4>工具提供的变更预览</h4>
          <pre className="diff">{activity.diff}</pre>
        </section>
      )}
    </details>
  );
}

const newConnection = (): Connection => ({
  id: '',
  name: '',
  provider: 'anthropic',
  model: '',
  supportsThinking: false,
  supportsImages: false,
  contextWindow: 128000,
  maxOutputTokens: 8192,
});
type ConnectionField = 'name' | 'model' | 'baseUrl' | 'apiKeyEnv' | 'contextWindow' | 'maxOutputTokens';
type ConnectionErrors = Partial<Record<ConnectionField, string>>;

function ConnectionDialog({
  models,
  initialId,
  onClose,
  onSave,
}: {
  models: ModelOption[];
  initialId?: string;
  onClose: () => void;
  onSave: (connection: Connection, apiKey?: string) => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [form, setForm] = useState<Connection>(() => {
    const current = models.find((model) => model.id === initialId);
    return current ? metadata(current) : newConnection();
  });
  const [apiKey, setApiKey] = useState('');
  const [authMode, setAuthMode] = useState<'key' | 'env'>(() => (form.apiKeyEnv ? 'env' : 'key'));
  const [fieldErrors, setFieldErrors] = useState<ConnectionErrors>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  function metadata(model: ModelOption): Connection {
    return {
      id: model.id,
      name: model.name,
      provider: model.provider,
      model: model.model,
      ...(model.baseUrl ? { baseUrl: model.baseUrl } : {}),
      ...(model.apiKeyEnv ? { apiKeyEnv: model.apiKeyEnv } : {}),
      supportsThinking: model.supportsThinking,
      supportsImages: model.supportsImages,
      contextWindow: model.contextWindow,
      maxOutputTokens: model.maxOutputTokens,
    };
  }
  function field<K extends keyof Connection>(name: K, value: Connection[K]) {
    setForm((previous) => ({ ...previous, [name]: value }));
    setFieldErrors((previous) => {
      const next = { ...previous };
      delete next[name as ConnectionField];
      return next;
    });
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (saving) return;
    setError('');
    const { baseUrl, apiKeyEnv, ...connectionMetadata } = form;
    const connection: Connection = {
      ...connectionMetadata,
      id: form.id || crypto.randomUUID(),
      name: form.name.trim(),
      model: form.model.trim(),
      ...(baseUrl?.trim() ? { baseUrl: baseUrl.trim() } : {}),
      ...(authMode === 'env' && apiKeyEnv?.trim() ? { apiKeyEnv: apiKeyEnv.trim() } : {}),
    };
    const errors: ConnectionErrors = connectionFieldErrors(connection);
    if (!connection.name) errors.name = '请填写连接名称，方便在模型列表中辨认。';
    if (!connection.model) errors.model = '请填写模型 ID，例如 step-5-preview；这里不填服务地址。';
    if (authMode === 'env' && !connection.apiKeyEnv)
      errors.apiKeyEnv = '请填写环境变量名，例如 STEP_API_KEY；实际密钥请使用直接输入模式。';
    for (const name of ['contextWindow', 'maxOutputTokens'] as const)
      if (!Number.isSafeInteger(connection[name]) || connection[name] < 1 || connection[name] > 100_000_000)
        errors[name] = '请填写 1 到 100000000 之间的整数。';
    setFieldErrors(errors);
    const firstError = (['name', 'model', 'baseUrl', 'apiKeyEnv', 'contextWindow', 'maxOutputTokens'] as const).find(
      (name) => errors[name],
    );
    if (firstError) {
      dialog.current?.querySelector<HTMLInputElement>(`[name="${firstError}"]`)?.focus();
      return;
    }
    setSaving(true);
    const secret = authMode === 'key' ? apiKey : '';
    setApiKey('');
    try {
      await onSave(connection, secret || undefined);
      dialog.current?.close();
    } catch (failure) {
      setError(`${errorText(failure)}${secret ? ' 密钥输入已清空，请在重试前重新输入。' : ''}`);
    } finally {
      setSaving(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="connection-dialog"
      aria-labelledby="connection-title"
      onClose={() => {
        setApiKey('');
        onClose();
      }}
      onCancel={(event) => {
        if (saving) event.preventDefault();
      }}
    >
      <header className="dialog-header">
        <div>
          <p className="eyebrow">模型连接</p>
          <h2 id="connection-title">让工作台连接你的模型</h2>
        </div>
        <button
          className="icon-button"
          aria-label="关闭连接设置"
          type="button"
          disabled={saving}
          onClick={() => dialog.current?.close()}
        >
          <Icon name="close" />
        </button>
      </header>
      <p className="muted">
        填写模型 ID 和服务地址，再选择认证方式。连接配置保存在本机，直接输入的密钥只用于本次应用进程。
      </p>
      <form noValidate onSubmit={(event) => void submit(event)}>
        {models.length > 0 && (
          <label className="field">
            编辑连接
            <select
              value={form.id}
              disabled={saving}
              onChange={(event) => {
                const model = models.find((item) => item.id === event.target.value);
                setForm(model ? metadata(model) : newConnection());
                setAuthMode(model?.apiKeyEnv ? 'env' : 'key');
                setApiKey('');
                setError('');
                setFieldErrors({});
              }}
            >
              <option value="">添加新连接</option>
              {models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.name}
                  {model.configurationIssue ? ' · 需要修正' : ''}
                  {model.source === 'project' ? ' · 项目配置' : ''}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="form-grid">
          <label className="field">
            连接名称
            <input
              required
              name="name"
              autoFocus
              maxLength={120}
              value={form.name}
              disabled={saving}
              onChange={(event) => field('name', event.target.value)}
              placeholder="例如：我的编程模型"
              aria-invalid={!!fieldErrors.name}
              aria-describedby={fieldErrors.name ? 'connection-name-error' : undefined}
            />
            {fieldErrors.name && (
              <span className="field-error" id="connection-name-error">
                {fieldErrors.name}
              </span>
            )}
          </label>
          <label className="field">
            接口协议
            <select
              value={form.provider}
              disabled={saving}
              onChange={(event) => field('provider', event.target.value as Connection['provider'])}
            >
              <option value="anthropic">Anthropic Messages</option>
              <option value="openai">OpenAI Responses</option>
            </select>
          </label>
        </div>
        <label className="field">
          模型 ID（如 step-5-preview）
          <input
            required
            name="model"
            spellCheck={false}
            value={form.model}
            disabled={saving}
            onChange={(event) => field('model', event.target.value)}
            placeholder="step-5-preview"
            aria-invalid={!!fieldErrors.model}
            aria-describedby={`connection-model-help${fieldErrors.model ? ' connection-model-error' : ''}`}
          />
          <span className="field-hint" id="connection-model-help">
            只填模型名称，不要填写 https:// 开头的服务地址。
          </span>
          {fieldErrors.model && (
            <span className="field-error" id="connection-model-error">
              {fieldErrors.model}
            </span>
          )}
        </label>
        <label className="field">
          服务地址（Base URL）<span className="optional">可选</span>
          <input
            type="url"
            name="baseUrl"
            spellCheck={false}
            value={form.baseUrl ?? ''}
            disabled={saving}
            onChange={(event) => field('baseUrl', event.target.value)}
            placeholder="https://api.stepfun.com/step_plan"
            aria-invalid={!!fieldErrors.baseUrl}
            aria-describedby={`connection-base-url-help${fieldErrors.baseUrl ? ' connection-base-url-error' : ''}`}
          />
          <span className="field-hint" id="connection-base-url-help">
            阶跃示例：https://api.stepfun.com/step_plan；也支持完整的 /v1/messages 地址。留空使用接口默认地址。
          </span>
          {fieldErrors.baseUrl && (
            <span className="field-error" id="connection-base-url-error">
              {fieldErrors.baseUrl}
            </span>
          )}
        </label>
        <fieldset className="authentication-mode" disabled={saving}>
          <legend>认证方式</legend>
          <label>
            <input
              type="radio"
              name="authenticationMode"
              value="key"
              checked={authMode === 'key'}
              onChange={() => {
                setAuthMode('key');
                setApiKey('');
                setFieldErrors({});
                setError('');
              }}
            />
            直接输入密钥（推荐）
          </label>
          <label>
            <input
              type="radio"
              name="authenticationMode"
              value="env"
              checked={authMode === 'env'}
              onChange={() => {
                setAuthMode('env');
                setApiKey('');
                setFieldErrors({});
                setError('');
              }}
            />
            环境变量引用（高级）
          </label>
        </fieldset>
        {authMode === 'key' ? (
          <label className="field">
            API Key（密钥）<span className="optional">仅本次应用</span>
            <input
              type="password"
              name="apiKey"
              value={apiKey}
              autoComplete="new-password"
              spellCheck={false}
              disabled={saving}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder="不会写入连接配置"
              aria-describedby="connection-api-key-help"
            />
            <span className="field-hint" id="connection-api-key-help">
              在密码框粘贴实际密钥。关闭应用后需重新输入；留空可保留当前进程已有的认证。
            </span>
          </label>
        ) : (
          <label className="field">
            密钥环境变量名
            <input
              name="apiKeyEnv"
              spellCheck={false}
              value={form.apiKeyEnv ?? ''}
              disabled={saving}
              onChange={(event) => field('apiKeyEnv', event.target.value)}
              placeholder="STEP_API_KEY"
              aria-invalid={!!fieldErrors.apiKeyEnv}
              aria-describedby={`connection-api-key-env-help${fieldErrors.apiKeyEnv ? ' connection-api-key-env-error' : ''}`}
            />
            <span className="field-hint" id="connection-api-key-env-help">
              这里只填 STEP_API_KEY 等变量名称，不是密钥内容；变量须在启动应用前设置。
            </span>
            {fieldErrors.apiKeyEnv && (
              <span className="field-error" id="connection-api-key-env-error">
                {fieldErrors.apiKeyEnv}
              </span>
            )}
          </label>
        )}
        <div className="capability-fields">
          <label>
            <input
              type="checkbox"
              checked={form.supportsThinking}
              disabled={saving}
              onChange={(event) => field('supportsThinking', event.target.checked)}
            />
            声明此连接支持可调思考
          </label>
          <label>
            <input
              type="checkbox"
              checked={form.supportsImages}
              disabled={saving}
              onChange={(event) => field('supportsImages', event.target.checked)}
            />
            声明模型支持图片
          </label>
        </div>
        <p className="field-hint">
          能力由你声明，尚未验证远端各档位。思考参数由所选接口映射，图片附件将在后续版本开放。
        </p>
        <div className="form-grid">
          <label className="field">
            上下文窗口
            <input
              required
              name="contextWindow"
              type="number"
              min={1}
              step={1}
              value={form.contextWindow}
              disabled={saving}
              onChange={(event) => field('contextWindow', Number(event.target.value))}
              aria-invalid={!!fieldErrors.contextWindow}
              aria-describedby={fieldErrors.contextWindow ? 'connection-context-window-error' : undefined}
            />
            {fieldErrors.contextWindow && (
              <span className="field-error" id="connection-context-window-error">
                {fieldErrors.contextWindow}
              </span>
            )}
          </label>
          <label className="field">
            最大输出 token
            <input
              required
              name="maxOutputTokens"
              type="number"
              min={1}
              step={1}
              value={form.maxOutputTokens}
              disabled={saving}
              onChange={(event) => field('maxOutputTokens', Number(event.target.value))}
              aria-invalid={!!fieldErrors.maxOutputTokens}
              aria-describedby={fieldErrors.maxOutputTokens ? 'connection-output-tokens-error' : undefined}
            />
            {fieldErrors.maxOutputTokens && (
              <span className="field-error" id="connection-output-tokens-error">
                {fieldErrors.maxOutputTokens}
              </span>
            )}
          </label>
        </div>
        {error && (
          <p className="notice error" role="alert">
            {error}
          </p>
        )}
        <footer className="dialog-footer">
          <span>保存不会发起模型请求。</span>
          <button className="button primary" type="submit" disabled={saving}>
            {saving ? '正在保存…' : '保存连接'}
          </button>
        </footer>
      </form>
    </dialog>
  );
}

export function App() {
  const [snapshot, setSnapshot] = useState<Snapshot>(emptySnapshot);
  const seq = useRef(-1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [operation, setOperation] = useState('');
  const operationLock = useRef(false);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [settings, setSettings] = useState<{ modelId?: string } | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [dark, setDark] = useState(() => {
    try {
      return localStorage.getItem('mh:theme') === 'dark';
    } catch {
      return false;
    }
  });
  const [selectionNotice, setSelectionNotice] = useState('');
  const composing = useRef(false);
  const composer = useRef<HTMLTextAreaElement>(null);
  const feed = useRef<HTMLDivElement>(null);
  const followEnd = useRef(true);
  const accept = useCallback((next: Snapshot) => {
    if (next.protocolVersion !== 1 || next.seq <= seq.current) return;
    seq.current = next.seq;
    setSnapshot(next);
    setLoading(false);
  }, []);
  useEffect(() => {
    let alive = true;
    if (!window.mh) {
      setError('桌面连接不可用，请从 mini-harness 桌面应用打开。');
      setLoading(false);
      return;
    }
    const unsubscribe = window.mh.subscribe((next) => {
      if (alive) accept(next);
    });
    void window.mh
      .request({ method: 'snapshot' })
      .then((next) => {
        if (alive) accept(next);
      })
      .catch((failure: unknown) => {
        if (alive) {
          setError(errorText(failure));
          setLoading(false);
        }
      });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [accept]);
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    try {
      localStorage.setItem('mh:theme', dark ? 'dark' : 'light');
    } catch {
      /* Theme still works without storage. */
    }
  }, [dark]);
  useEffect(() => {
    const closeSidebar = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape' && !event.isComposing) setSidebarOpen(false);
    };
    document.addEventListener('keydown', closeSidebar);
    return () => document.removeEventListener('keydown', closeSidebar);
  }, []);

  const project = snapshot.project;
  const sessionId = snapshot.selectedSessionId;
  const scope = `${project?.id ?? 'none'}:${sessionId ?? 'draft'}`;
  const fallback =
    snapshot.models.find((model) => model.credentialReady && !model.configurationIssue) ?? snapshot.models[0];
  const draft: Draft = drafts[scope] ?? { text: '', modelId: fallback?.id ?? '', thinking: 'off', efforts: {} };
  const selectedModel = snapshot.models.find((model) => model.id === draft.modelId);
  const thinking = selectedModel?.supportsThinking ? draft.thinking : 'off';
  const run = snapshot.run;
  const busy = !!run && activeStates.has(run.status);
  const currentRun = run?.sessionId === sessionId ? run : undefined;
  const currentBusy = !!currentRun && activeStates.has(currentRun.status);
  const awaiting = currentRun?.status === 'waitingApproval';
  const closing = currentRun?.status === 'cancelling';
  const canSend =
    !!project &&
    !!draft.text.trim() &&
    !operation &&
    !closing &&
    (currentBusy || (!!selectedModel?.credentialReady && !selectedModel.configurationIssue));
  const title = snapshot.sessions.find((session) => session.id === sessionId)?.title ?? '新的开始';
  const modelChanged = !!currentRun && (currentRun.modelId !== draft.modelId || currentRun.thinking !== thinking);

  useEffect(() => {
    setSelectionNotice('');
    setSidebarOpen(false);
    followEnd.current = true;
  }, [scope]);
  useEffect(() => {
    if (followEnd.current && feed.current) feed.current.scrollTop = feed.current.scrollHeight;
  }, [snapshot.messages, snapshot.streamingText, snapshot.activities, snapshot.approvals, scope]);

  function updateDraft(patch: Partial<Draft>) {
    setDrafts((previous) => ({ ...previous, [scope]: { ...draft, ...patch } }));
  }
  async function request(command: HostCommand): Promise<Snapshot> {
    if (!window.mh) throw new Error('桌面连接尚未就绪。');
    const next = await window.mh.request(command);
    accept(next);
    return next;
  }
  async function action(name: string, execute: () => Promise<unknown>) {
    if (operationLock.current) return;
    operationLock.current = true;
    setOperation(name);
    setError('');
    try {
      await execute();
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      operationLock.current = false;
      setOperation('');
    }
  }
  function chooseProject() {
    void action('project', async () => {
      const next = await window.mh.chooseProject();
      if (next) {
        accept(next);
        setReviewOpen(false);
      }
    });
  }
  function chooseModel(id: string) {
    const model = snapshot.models.find((option) => option.id === id);
    if (!model) return;
    const remembered = draft.efforts[id] ?? draft.thinking;
    const nextThinking = model.supportsThinking ? remembered : 'off';
    updateDraft({
      modelId: id,
      thinking: nextThinking,
      efforts: { ...draft.efforts, [draft.modelId]: draft.thinking },
    });
    setSelectionNotice(
      model.configurationIssue
        ? '此连接需要修正，请打开模型连接设置更正后再运行。'
        : nextThinking !== remembered
          ? '此连接未声明可调思考，已改为默认。'
          : '',
    );
  }
  async function send(event: FormEvent) {
    event.preventDefault();
    if (!canSend || !project) return;
    const text = draft.text.trim();
    const input = {
      projectId: project.id,
      ...(sessionId ? { sessionId } : {}),
      prompt: text,
      modelId: draft.modelId,
      thinking,
    };
    const active = currentBusy ? currentRun : undefined;
    await action('send', async () => {
      const next = await request(active ? { method: 'steer', runId: active.id, text } : { method: 'startRun', input });
      setDrafts((previous) => {
        const latest = previous[scope] ?? draft;
        const cleared = latest.text === draft.text ? { ...latest, text: '' } : latest;
        const result = { ...previous, [scope]: cleared };
        if (!active && next.project?.id === project.id && next.selectedSessionId) {
          const destination = `${project.id}:${next.selectedSessionId}`;
          // A broadcast may open the new session before this response arrives.
          // Its draft already belongs to the user's next input and selections.
          if (destination !== scope && !previous[destination]) result[destination] = cleared;
        }
        return result;
      });
      followEnd.current = true;
      composer.current?.focus();
    });
  }
  function onComposerKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && !composing.current) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }
  function openReview() {
    setReviewOpen(true);
    if (project) void action('review', () => request({ method: 'review', projectId: project.id }));
  }
  const phase =
    currentRun?.status === 'thinking' || currentRun?.status === 'running'
      ? 'thinking'
      : closing
        ? 'cancelled'
        : awaiting
          ? 'waiting'
          : 'full';

  return (
    <div className={`app ${sidebarOpen ? 'sidebar-open' : ''}`}>
      <aside className="sidebar" aria-label="项目与会话">
        <div className="brand">
          <Moon className="brand-moon" />
          <span>mini-harness</span>
        </div>
        <Button
          className="new-session"
          disabled={!project || busy || !!operation}
          onClick={() =>
            project && void action('session', () => request({ method: 'newSession', projectId: project.id }))
          }
        >
          <Icon name="plus" />
          新建会话
        </Button>
        <Button className="sidebar-project" disabled={busy || !!operation} onClick={chooseProject}>
          <Icon name="folder" />
          <span>{project ? '切换项目' : '打开项目'}</span>
        </Button>
        {project && (
          <div className="project-label" title={project.path}>
            <span className="project-dot" />
            <strong>{project.name}</strong>
          </div>
        )}
        <div className="section-label">最近会话</div>
        <nav className="sessions" aria-label="会话记录">
          {snapshot.sessions.map((session) => (
            <button
              key={session.id}
              type="button"
              className={`session ${sessionId === session.id ? 'selected' : ''}`}
              aria-current={sessionId === session.id ? 'page' : undefined}
              title={session.title}
              disabled={busy || !!operation}
              onClick={() =>
                project &&
                void action('session', () =>
                  request({ method: 'openSession', projectId: project.id, sessionId: session.id }),
                )
              }
            >
              <span>{session.title || '未命名会话'}</span>
              <small>
                {session.updatedAt
                  ? new Date(session.updatedAt).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
                  : ''}
              </small>
            </button>
          ))}
        </nav>
        {!snapshot.sessions.length && (
          <p className="sidebar-empty">{project ? '你的会话会保存在这里。' : '打开一个本地项目，开始工作。'}</p>
        )}
        <div className="sidebar-footer">
          <Button onClick={() => setSettings({})}>
            <Icon name="settings" />
            模型连接
          </Button>
          <div className="local-label">
            <span className="local-dot" />
            本地工作区<span>Desktop MVP</span>
          </div>
        </div>
      </aside>
      {sidebarOpen && (
        <button className="sidebar-scrim" type="button" aria-label="关闭侧栏" onClick={() => setSidebarOpen(false)} />
      )}
      <main className="workspace">
        <header className="topbar">
          <div className="breadcrumbs">
            <button
              type="button"
              className="icon-button mobile-toggle"
              aria-label="切换侧栏"
              aria-expanded={sidebarOpen}
              onClick={() => setSidebarOpen(!sidebarOpen)}
            >
              <Icon name="panel" />
            </button>
            <span title={project?.path}>{project?.name ?? '工作台'}</span>
            <span className="crumb-divider">/</span>
            <strong>{title}</strong>
          </div>
          <div className="top-actions">
            <button
              type="button"
              className="icon-button"
              title={dark ? '切换浅色主题' : '切换深色主题'}
              aria-label={dark ? '切换浅色主题' : '切换深色主题'}
              onClick={() => setDark(!dark)}
            >
              <Icon name="theme" />
            </button>
            <Button disabled={!project || !!operation} onClick={openReview}>
              <Icon name="panel" />
              查看变更
            </Button>
          </div>
        </header>
        {(error || snapshot.error) && (
          <div className="notice error app-notice" role="alert">
            <span>{error || snapshot.error}</span>
            <button
              className="text-button"
              type="button"
              onClick={() => {
                setError('');
                void action('refresh', () => request({ method: 'snapshot' }));
              }}
            >
              重新同步
            </button>
          </div>
        )}
        {snapshot.warning && (
          <div className="notice app-notice" role="status">
            {snapshot.warning}
          </div>
        )}
        <div className={`content ${reviewOpen ? 'with-review' : ''}`}>
          <section className="conversation-column" aria-label="任务对话">
            <div
              className="conversation-scroll"
              ref={feed}
              onScroll={(event) => {
                const node = event.currentTarget;
                followEnd.current = node.scrollHeight - node.scrollTop - node.clientHeight < 100;
              }}
            >
              {!snapshot.messages.length && !snapshot.streamingText ? (
                <div className="welcome">
                  <Moon className="welcome-moon" />
                  <p className="eyebrow">从一个清楚的目标开始</p>
                  <h1>{loading ? '正在连接工作台…' : project ? '今天，想一起完成什么？' : '让想法在本地落地。'}</h1>
                  <p>
                    {project
                      ? '理解代码、修复问题、运行检查。每一步都有迹可循。'
                      : '选择项目文件夹，让 mini-harness 在你的工作区阅读、修改和验证。'}
                  </p>
                  {!project && (
                    <Button className="primary" disabled={loading || !!operation} onClick={chooseProject}>
                      <Icon name="folder" />
                      选择本地项目
                    </Button>
                  )}
                  {project && !snapshot.models.length && (
                    <Button className="primary" onClick={() => setSettings({})}>
                      添加模型连接
                    </Button>
                  )}
                  <div className="welcome-notes">
                    <span>本地会话</span>
                    <span>按需审批</span>
                    <span>真实检查</span>
                  </div>
                </div>
              ) : (
                <article className="transcript">
                  {snapshot.messages.map((message) => (
                    <section key={message.id} className={`message ${message.role}`}>
                      <div className="message-heading">
                        {message.role === 'assistant' ? <Moon /> : <span className="user-avatar">你</span>}
                        <span>{message.role === 'assistant' ? 'mini-harness' : '你'}</span>
                        {message.model && <small>{message.model}</small>}
                      </div>
                      <div className="message-text">{message.text || '（没有文本内容）'}</div>
                    </section>
                  ))}
                  {snapshot.streamingText && (
                    <section className="message assistant streaming">
                      <div className="message-heading">
                        <Moon phase={phase} />
                        <span>mini-harness</span>
                        <small>正在生成</small>
                      </div>
                      <div className="message-text">{snapshot.streamingText}</div>
                    </section>
                  )}
                </article>
              )}
              {(snapshot.activities.length > 0 || sessionId) && (
                <section className="activities-section" aria-label="工具活动">
                  <div className="section-heading">
                    <h2>执行记录</h2>
                    <span>{snapshot.activities.length ? `${snapshot.activities.length} 项活动` : '历史详情'}</span>
                  </div>
                  {snapshot.activities.map((activity) => (
                    <ActivityCard key={activity.id} activity={activity} />
                  ))}
                  {!snapshot.activities.length && (
                    <p className="history-note">现有历史可能没有完整工具参数、输出或 diff。这里仅展示已保存的内容。</p>
                  )}
                </section>
              )}
              {snapshot.approvals.map((approval) => (
                <section className="approval-card" key={approval.id} aria-labelledby={`approval-${approval.id}`}>
                  <p className="eyebrow">需要你的确认</p>
                  <h2 id={`approval-${approval.id}`}>{approval.title}</h2>
                  <pre>{approval.detail}</pre>
                  <div className="approval-actions">
                    <Button
                      disabled={!!operation || closing}
                      onClick={() =>
                        void action('approve', () =>
                          request({
                            method: 'approve',
                            runId: approval.runId,
                            approvalId: approval.id,
                            decision: 'deny',
                          }),
                        )
                      }
                    >
                      拒绝
                    </Button>
                    <Button
                      disabled={!!operation || closing}
                      onClick={() =>
                        void action('approve', () =>
                          request({
                            method: 'approve',
                            runId: approval.runId,
                            approvalId: approval.id,
                            decision: 'session',
                          }),
                        )
                      }
                    >
                      本会话允许
                    </Button>
                    <Button
                      className="primary"
                      disabled={!!operation || closing}
                      onClick={() =>
                        void action('approve', () =>
                          request({
                            method: 'approve',
                            runId: approval.runId,
                            approvalId: approval.id,
                            decision: 'once',
                          }),
                        )
                      }
                    >
                      允许本次
                    </Button>
                  </div>
                </section>
              ))}
              {currentRun && (
                <section className="run-summary" aria-label="运行与验证状态">
                  <div className="run-state" role="status">
                    <Moon phase={phase} />
                    <strong>{runLabels[currentRun.status]}</strong>
                  </div>
                  <div className="run-facts">
                    <span
                      className={
                        currentRun.verification === 'passed'
                          ? 'verification passed'
                          : currentRun.verification === 'failed'
                            ? 'verification failed'
                            : 'verification'
                      }
                    >
                      {verificationLabels[currentRun.verification]}
                    </span>
                    <span>
                      {currentRun.modelName} · {effortLabels[currentRun.thinking]}
                    </span>
                    <span>
                      {currentRun.inputTokens.toLocaleString()} 输入 / {currentRun.outputTokens.toLocaleString()} 输出
                      token
                    </span>
                  </div>
                  {closing && <p>正在等待工具与子进程清理，确认停止后会更新状态。</p>}
                  {currentRun.error && <p className="run-error">{currentRun.error}</p>}
                </section>
              )}
            </div>
            <div className="composer-wrap">
              <form className="composer" onSubmit={(event) => void send(event)}>
                <label className="sr-only" htmlFor="prompt">
                  {currentBusy ? '补充本轮任务要求' : '描述任务'}
                </label>
                <textarea
                  id="prompt"
                  ref={composer}
                  value={draft.text}
                  disabled={!project || closing || operation === 'send'}
                  placeholder={
                    !project
                      ? '先选择一个项目文件夹…'
                      : currentBusy
                        ? '补充要求，当前运行继续使用固定配置…'
                        : '描述你想完成的工作…'
                  }
                  onChange={(event) => updateDraft({ text: event.target.value })}
                  onInput={(event) => {
                    if (!(event.nativeEvent as InputEvent).isComposing) composing.current = false;
                  }}
                  onBlur={() => {
                    composing.current = false;
                  }}
                  onCompositionStart={() => {
                    composing.current = true;
                  }}
                  onCompositionEnd={() => {
                    composing.current = false;
                  }}
                  onKeyDown={onComposerKey}
                />
                <div className="composer-footer">
                  <div className="composer-controls">
                    <label className="select-control">
                      <span className="sr-only">下一次运行的模型</span>
                      <select
                        value={draft.modelId}
                        disabled={!snapshot.models.length}
                        onChange={(event) => chooseModel(event.target.value)}
                      >
                        {!snapshot.models.length && <option value="">选择模型</option>}
                        {snapshot.models.map((model) => (
                          <option key={model.id} value={model.id}>
                            {model.name}
                            {model.configurationIssue ? ' · 需要修正' : model.credentialReady ? '' : ' · 未配置密钥'}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="select-control effort-select">
                      <span className="sr-only">下一次运行的思考深度</span>
                      <select
                        value={thinking}
                        disabled={!selectedModel?.supportsThinking || !!selectedModel.configurationIssue}
                        title={
                          selectedModel?.supportsThinking
                            ? '按连接声明提供档位，尚未验证远端支持情况'
                            : '此连接未声明可调思考；默认不额外指定参数'
                        }
                        onChange={(event) => {
                          const level = event.target.value as ThinkingLevel;
                          updateDraft({ thinking: level, efforts: { ...draft.efforts, [draft.modelId]: level } });
                          setSelectionNotice('');
                        }}
                      >
                        {efforts.map((level) => (
                          <option key={level} value={level}>
                            思考：{effortLabels[level]}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button
                      className="icon-button connection-shortcut"
                      type="button"
                      title="模型连接设置"
                      aria-label="模型连接设置"
                      onClick={() => setSettings({ modelId: draft.modelId })}
                    >
                      <Icon name="settings" />
                    </button>
                  </div>
                  <div className="send-actions">
                    {currentBusy && (
                      <button
                        type="button"
                        className="stop-button"
                        disabled={closing || !!operation}
                        onClick={() => void action('cancel', () => request({ method: 'cancel', runId: currentRun.id }))}
                      >
                        <Icon name="stop" />
                        <span>{closing ? '正在停止' : '停止'}</span>
                      </button>
                    )}
                    <button
                      className="send-button"
                      type="submit"
                      disabled={!canSend}
                      title={currentBusy ? '补充本轮输入' : '开始运行'}
                      aria-label={currentBusy ? '补充本轮输入' : '开始运行'}
                    >
                      <Icon name="arrow" />
                    </button>
                  </div>
                </div>
              </form>
              <div className="composer-caption" aria-live="polite">
                {selectionNotice ||
                  (currentBusy
                    ? modelChanged
                      ? `下次：${selectedModel?.name ?? '未选择模型'} · ${effortLabels[thinking]}；本轮仍为 ${currentRun.modelName} · ${effortLabels[currentRun.thinking]}。${selectedModel?.configurationIssue ? '下次运行前需要修正连接。' : selectedModel?.credentialReady ? '' : '下次运行前需要配置密钥。'}`
                      : '本轮配置已固定；输入将补充到当前任务。模型切换用于下一次完整运行。'
                    : !selectedModel
                      ? '添加一个模型连接后即可开始。'
                      : selectedModel.configurationIssue
                        ? '此连接需要修正。打开模型连接设置，更正模型 ID 或服务地址后再运行。'
                        : !selectedModel.credentialReady
                          ? '此连接缺少密钥。打开设置输入本次密钥或指定环境变量。'
                          : 'Enter 发送 · Shift + Enter 换行。默认思考遵循端点行为。')}
              </div>
            </div>
          </section>
          {reviewOpen && (
            <aside className="review-panel" aria-label="工作区变更">
              <header>
                <div>
                  <p className="eyebrow">只读审阅</p>
                  <h2>工作区当前变更</h2>
                </div>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="关闭变更面板"
                  onClick={() => setReviewOpen(false)}
                >
                  <Icon name="close" />
                </button>
              </header>
              <p className="review-scope">包括你已有的修改，不能归因为本轮任务。历史工具 diff 仅为预览。</p>
              <Button disabled={!project || !!operation} onClick={openReview}>
                {operation === 'review' ? '正在读取…' : '刷新工作区差异'}
              </Button>
              {snapshot.review ? (
                <>
                  <p className="review-summary">{snapshot.review.summary}</p>
                  {snapshot.review.error && <p className="notice error">{snapshot.review.error}</p>}
                  {snapshot.review.available && (
                    <pre className="review-diff">{snapshot.review.diff || '当前没有可显示的 Git 差异。'}</pre>
                  )}
                  {snapshot.review.truncated && <p className="notice">差异过长，仅显示已截取的部分。</p>}
                  <small className="capture-time">
                    读取于 {new Date(snapshot.review.capturedAt).toLocaleTimeString('zh-CN')}
                  </small>
                </>
              ) : (
                <p className="muted">
                  {operation === 'review' ? '正在读取 Git 工作区…' : '点击刷新读取当前项目的差异。'}
                </p>
              )}
            </aside>
          )}
        </div>
      </main>
      {settings && (
        <ConnectionDialog
          models={snapshot.models}
          initialId={settings.modelId}
          onClose={() => setSettings(null)}
          onSave={async (connection, apiKey) => {
            setError('');
            await request({ method: 'saveConnection', connection, ...(apiKey ? { apiKey } : {}) });
          }}
        />
      )}
    </div>
  );
}
