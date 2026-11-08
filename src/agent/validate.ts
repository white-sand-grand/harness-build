import { validateSchema } from '../util/jsonschema.ts';
import type { Tool } from './types.ts';
import type { ToolCallBlock } from '../ai/index.ts';
export function validateCall(tool: Tool, call: ToolCallBlock): string | undefined {
  if (Object.hasOwn(call.args, '__invalidJson'))
    return `Tool call arguments were not valid JSON: ${String(call.args.__invalidJson).slice(0, 200)}. Re-issue the call with a valid JSON object.`;
  const errors = validateSchema(tool.parameters, call.args);
  return errors.length
    ? `Invalid arguments for tool "${tool.name}":\n${errors.map((e) => '- ' + e).join('\n')}\nReceived: ${JSON.stringify(call.args).slice(0, 500)}`
    : undefined;
}
