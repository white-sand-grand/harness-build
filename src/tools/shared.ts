import type { JsonSchema } from '../ai/index.ts';
import type { ToolResult } from '../agent/index.ts';
export const pathSchema: JsonSchema = {
  type: 'string',
  description: 'File path, absolute or relative to the working directory',
};
export const objectSchema = (properties: Record<string, JsonSchema>, required: string[]): JsonSchema => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
export const textResult = (text: string, details?: unknown): ToolResult => ({
  content: [{ type: 'text', text }],
  ...(details !== undefined ? { details } : {}),
});
