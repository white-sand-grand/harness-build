import { validateSchema, type JsonSchema } from '../util/jsonschema.ts';
const str: JsonSchema = { type: 'string' },
  bool: JsonSchema = { type: 'boolean' },
  positive: JsonSchema = { type: 'integer', minimum: 1 };
const object = (properties: Record<string, JsonSchema>): JsonSchema => ({
  type: 'object',
  properties,
  additionalProperties: false,
});
const commands: JsonSchema = { type: 'array', items: object({ match: str, command: str, timeoutSec: positive }) };
const modelSchema = object({
  id: str,
  provider: { type: 'string', enum: ['anthropic', 'openai'] },
  contextWindow: positive,
  maxOutputTokens: positive,
  supportsImages: bool,
  supportsThinking: bool,
  baseUrl: str,
  apiKeyEnv: str,
  pricing: object({
    input: { type: 'number', minimum: 0 },
    output: { type: 'number', minimum: 0 },
    cacheRead: { type: 'number', minimum: 0 },
    cacheWrite: { type: 'number', minimum: 0 },
  }),
  compat: object({
    includeEncryptedReasoning: bool,
    promptCache: bool,
  }),
});
modelSchema.properties!.pricing!.required = ['input', 'output', 'cacheRead', 'cacheWrite'];
const configSchema = object({
  provider: { type: 'string', enum: ['anthropic', 'openai'] },
  model: str,
  thinking: { type: 'string', enum: ['off', 'low', 'medium', 'high'] },
  models: { type: 'object' },
  promptsDir: str,
  permissions: object({
    mode: { type: 'string', enum: ['ask', 'yolo'] },
    extraRiskyPatterns: { type: 'array', items: str },
  }),
  hooks: object({ afterEdit: commands, onStop: commands, maxStopContinuations: { type: 'integer', minimum: 0 } }),
  compaction: object({
    enabled: bool,
    clearAtRatio: { type: 'number', minimum: 0, maximum: 1 },
    compactAtRatio: { type: 'number', minimum: 0, maximum: 1 },
    keepRecentTokens: positive,
  }),
  toolOutput: object({ maxChars: positive, maxLines: positive }),
});
export function validateConfig(data: unknown, path: string): void {
  function secrets(v: unknown, p: string) {
    if (v && typeof v === 'object')
      for (const [k, value] of Object.entries(v)) {
        if (/^(?:api[-_]?key|token|auth[-_]?token|password|secret|authorization)$/i.test(k))
          throw new Error(`Config ${path}: ${p + k} must use an environment variable, not an inline secret.`);
        secrets(value, p + k + '.');
      }
  }
  secrets(data, '');
  const errors = validateSchema(configSchema, data);
  if (data && typeof data === 'object' && 'models' in data) {
    const models = (data as { models: unknown }).models;
    if (models && typeof models === 'object' && !Array.isArray(models))
      for (const [id, m] of Object.entries(models)) errors.push(...validateSchema(modelSchema, m, `models.${id}`));
  }
  if (data && typeof data === 'object' && 'hooks' in data) {
    const h = (data as { hooks?: { afterEdit?: unknown[]; onStop?: unknown[] } }).hooks;
    for (const key of ['afterEdit', 'onStop'] as const)
      if (Array.isArray(h?.[key]))
        for (const [i, item] of h[key].entries())
          if (
            !item ||
            typeof item !== 'object' ||
            !('command' in item) ||
            typeof item.command !== 'string' ||
            !item.command.trim()
          )
            errors.push(`hooks.${key}[${i}].command must be a non-empty string`);
  }
  if (errors.length) throw new Error(`Invalid config ${path}:\n${errors.join('\n')}`);
}
