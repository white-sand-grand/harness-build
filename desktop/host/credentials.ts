import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { connectionFieldErrors, isSystemEnvironmentVariable, type Connection } from '../contracts.ts';

export type PrivateCredential = { apiKey?: string; authToken?: string };
function parseConnection(input: Connection, restoringLegacyModel = false): Connection {
  if (!input || typeof input !== 'object') throw new Error('连接配置无效。');
  const keys = new Set([
    'id',
    'name',
    'provider',
    'model',
    'baseUrl',
    'apiKeyEnv',
    'supportsThinking',
    'supportsImages',
    'contextWindow',
    'maxOutputTokens',
  ]);
  if (Object.keys(input).some((key) => !keys.has(key))) throw new Error('连接包含未知字段；密钥只能单独提供。');
  for (const key of ['id', 'name', 'model'] as const)
    if (typeof input[key] !== 'string' || !input[key].trim() || input[key].length > 200)
      throw new Error(`连接的 ${key} 无效。`);
  if (!['anthropic', 'openai'].includes(input.provider)) throw new Error('不支持该模型协议。');
  for (const key of ['supportsThinking', 'supportsImages'] as const)
    if (typeof input[key] !== 'boolean') throw new Error(`连接的 ${key} 必须是布尔值。`);
  for (const key of ['contextWindow', 'maxOutputTokens'] as const)
    if (!Number.isSafeInteger(input[key]) || input[key] < 1 || input[key] > 100_000_000)
      throw new Error(`连接的 ${key} 必须是有效的正整数。`);
  const errors = connectionFieldErrors(input);
  if (restoringLegacyModel && /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(input.model.trim())) delete errors.model;
  const issue = Object.values(errors)[0];
  if (issue) throw new Error(issue);
  const { baseUrl, apiKeyEnv, ...metadata } = input;
  return {
    ...metadata,
    id: input.id.trim(),
    name: input.name.trim(),
    model: input.model.trim(),
    ...(baseUrl?.trim() ? { baseUrl: baseUrl.trim() } : {}),
    ...(apiKeyEnv?.trim() ? { apiKeyEnv: apiKeyEnv.trim() } : {}),
  };
}

export function validateConnection(input: Connection): Connection {
  return parseConnection(input);
}

/** Keys are captured once and never restored into an environment inherited by tools. */
export class DesktopCredentials {
  private environment = new Map<string, string>();
  private connections = new Map<string, PrivateCredential>();
  private usedSecrets = new Set<string>();
  constructor(environment: Record<string, string> = {}) {
    for (const [name, value] of Object.entries(environment))
      if (typeof value === 'string' && value && !isSystemEnvironmentVariable(name)) this.environment.set(name, value);
    for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY']) this.capture(name);
  }
  capture(name: string): void {
    if (isSystemEnvironmentVariable(name)) throw new Error('不能把系统运行变量用作模型密钥。');
    const value = process.env[name];
    if (value) this.environment.set(name, value);
    const captured = this.environment.get(name);
    if (captured) this.usedSecrets.add(captured);
    delete process.env[name];
  }
  set(connectionId: string, key: string): void {
    if (typeof key !== 'string' || !key.trim() || key.length > 32_768) throw new Error('密钥不能为空或过长。');
    this.connections.set(connectionId, { apiKey: key.trim() });
    this.usedSecrets.add(key.trim());
  }
  get(connection: Connection): PrivateCredential | undefined {
    if (connection.apiKeyEnv) this.capture(connection.apiKeyEnv);
    const direct = this.connections.get(connection.id);
    if (direct) return { ...direct };
    if (connection.apiKeyEnv) {
      const value = this.environment.get(connection.apiKeyEnv);
      if (value)
        return connection.provider === 'anthropic' && connection.apiKeyEnv === 'ANTHROPIC_AUTH_TOKEN'
          ? { authToken: value }
          : { apiKey: value };
      if (connection.provider === 'openai') return undefined;
    }
    const key = this.environment.get(connection.provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY');
    if (key) {
      this.usedSecrets.add(key);
      return { apiKey: key };
    }
    const token = connection.provider === 'anthropic' ? this.environment.get('ANTHROPIC_AUTH_TOKEN') : undefined;
    if (token) this.usedSecrets.add(token);
    return token ? { authToken: token } : undefined;
  }
  redact(text: string): string {
    for (const secret of this.usedSecrets) if (secret.length >= 4) text = text.split(secret).join('[redacted]');
    return text;
  }
  clear(): void {
    this.environment.clear();
    this.connections.clear();
    this.usedSecrets.clear();
  }
}

function readConnectionRecords(home: string): { raw: Connection[]; connections: Connection[] } {
  const file = join(home, 'desktop-connections.json');
  if (!existsSync(file)) return { raw: [], connections: [] };
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new Error('保存的桌面连接文件无法读取。');
  }
  if (!Array.isArray(data)) throw new Error('保存的桌面连接文件格式无效。');
  // Older desktop builds accepted a URL as the model ID. Retain only that legacy shape for repair.
  const connections = data.map((item) => parseConnection(item as Connection, true));
  if (new Set(connections.map((item) => item.id)).size !== connections.length)
    throw new Error('保存的桌面连接 ID 重复。');
  return { raw: data as Connection[], connections };
}

export function readConnections(home: string): Connection[] {
  return readConnectionRecords(home).connections;
}

export function writeConnections(home: string, connections: Connection[]): void {
  const existing = readConnectionRecords(home);
  const records = connections.map((connection) => {
    const index = existing.connections.findIndex((record) => record.id === connection.id);
    const original = existing.connections[index];
    if (original && connectionFieldErrors(original).model && isDeepStrictEqual(connection, original))
      return existing.raw[index]!;
    return validateConnection(connection);
  });
  mkdirSync(home, { recursive: true });
  const target = join(home, 'desktop-connections.json');
  const temporary = target + '.' + randomUUID() + '.tmp';
  writeFileSync(temporary, JSON.stringify(records, null, 2) + '\n', { mode: 0o600 });
  renameSync(temporary, target);
}
