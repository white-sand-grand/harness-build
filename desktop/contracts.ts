export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high';
export type ProviderId = 'anthropic' | 'openai';
export type Connection = {
  id: string;
  name: string;
  provider: ProviderId;
  model: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  supportsThinking: boolean;
  supportsImages: boolean;
  contextWindow: number;
  maxOutputTokens: number;
};
export type ModelOption = Connection & {
  credentialReady: boolean;
  source: 'desktop' | 'project';
  configurationIssue?: string;
};

const systemEnvironmentVariables = new Set([
  'PATH',
  'HOME',
  'CODEX_HOME',
  'MH_HOME',
  'USERPROFILE',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'APPDATA',
  'LOCALAPPDATA',
  'TEMP',
  'TMP',
  'PATHEXT',
  'NODE_OPTIONS',
  'NODE_PATH',
]);

export function isSystemEnvironmentVariable(name: string): boolean {
  return systemEnvironmentVariables.has(name.toUpperCase());
}

/** Shared form/Host validation. Messages deliberately never include supplied field values. */
export function connectionFieldErrors(
  input: Pick<Connection, 'model' | 'baseUrl' | 'apiKeyEnv'>,
): Partial<Record<'model' | 'baseUrl' | 'apiKeyEnv', string>> {
  const errors: Partial<Record<'model' | 'baseUrl' | 'apiKeyEnv', string>> = {};
  if (typeof input.model !== 'string' || !input.model.trim())
    errors.model = '请填写模型 ID，例如 step-5-preview 或 org/model；接口地址请填入 Base URL。';
  else if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(input.model.trim()))
    errors.model =
      '模型 ID 不能填写接口 URL；请填写如 step-5-preview 或 org/model 的模型名称，接口地址请填入 Base URL。';
  if (input.baseUrl !== undefined && input.baseUrl !== '') {
    if (typeof input.baseUrl !== 'string') errors.baseUrl = 'Base URL 必须是完整的 HTTP(S) 接口地址。';
    else if (input.baseUrl.trim()) {
      try {
        const url = new URL(input.baseUrl);
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
          errors.baseUrl = 'Base URL 只接受不含用户名、密码、查询参数或片段的 HTTP(S) 接口地址。';
      } catch {
        errors.baseUrl = 'Base URL 必须是完整的 HTTP(S) 接口地址。';
      }
    }
  }
  if (input.apiKeyEnv !== undefined && input.apiKeyEnv !== '') {
    if (
      typeof input.apiKeyEnv !== 'string' ||
      (input.apiKeyEnv.trim() && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(input.apiKeyEnv.trim()))
    )
      errors.apiKeyEnv =
        '环境变量名只能包含字母、数字和下划线，且不能以数字开头；这里只填如 STEP_API_KEY 的名称，实际密钥请放在 API Key。';
    else if (input.apiKeyEnv.trim() && isSystemEnvironmentVariable(input.apiKeyEnv.trim()))
      errors.apiKeyEnv = '不能使用系统运行变量；这里只填写如 STEP_API_KEY 的密钥环境变量名，实际密钥请放在 API Key。';
  }
  return errors;
}
export type Project = { id: string; name: string; path: string };
export type SessionSummary = { id: string; title: string; updatedAt: string };
export type ConversationMessage = { id: string; role: 'user' | 'assistant'; text: string; model?: string };
export type Activity = {
  id: string;
  name: string;
  status: 'running' | 'completed' | 'failed';
  input: string;
  output: string;
  durationMs?: number;
  diff?: string;
};
export type RunState = 'running' | 'thinking' | 'waitingApproval' | 'cancelling' | 'completed' | 'cancelled' | 'failed';
export type VerificationState = 'notConfigured' | 'notRun' | 'passed' | 'failed' | 'incomplete';
export type Run = {
  id: string;
  sessionId: string;
  status: RunState;
  modelId: string;
  modelName: string;
  thinking: ThinkingLevel;
  verification: VerificationState;
  error?: string;
  inputTokens: number;
  outputTokens: number;
};
export type Approval = { id: string; runId: string; title: string; detail: string };
export type Review = {
  available: boolean;
  scope: 'workingTree';
  summary: string;
  diff: string;
  truncated: boolean;
  capturedAt: string;
  error?: string;
};
export type Snapshot = {
  protocolVersion: 1;
  seq: number;
  project?: Project;
  sessions: SessionSummary[];
  selectedSessionId?: string;
  messages: ConversationMessage[];
  activities: Activity[];
  streamingText: string;
  run?: Run;
  approvals: Approval[];
  models: ModelOption[];
  warning?: string;
  error?: string;
  review?: Review;
};
export type StartRun = {
  projectId: string;
  sessionId?: string;
  prompt: string;
  modelId: string;
  thinking: ThinkingLevel;
};
export type HostCommand =
  | { method: 'snapshot' }
  | { method: 'openProject'; path: string }
  | { method: 'openSession'; projectId: string; sessionId: string }
  | { method: 'newSession'; projectId: string }
  | { method: 'startRun'; input: StartRun }
  | { method: 'steer'; runId: string; text: string }
  | { method: 'cancel'; runId: string }
  | { method: 'approve'; runId: string; approvalId: string; decision: 'once' | 'session' | 'deny' }
  | { method: 'review'; projectId: string }
  | { method: 'saveConnection'; connection: Connection; apiKey?: string }
  | { method: 'shutdown' };
export type HostRequest = { id: string; command: HostCommand };
export type HostMessage =
  | { type: 'response'; id: string; snapshot?: Snapshot; error?: string }
  | { type: 'snapshot'; snapshot: Snapshot }
  | { type: 'ready'; nodeVersion: string };
export type DesktopBridge = {
  request(command: HostCommand): Promise<Snapshot>;
  chooseProject(): Promise<Snapshot | null>;
  subscribe(listener: (snapshot: Snapshot) => void): () => void;
};
