import { parentPort, workerData } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { registerHooks } from 'node:module';
import type { PluginDefinition } from './plugin-types.ts';

const port = parentPort;
if (!port) throw new Error('The plugin worker must be started by its host.');
// Keep initialization alive even when a module awaits without opening another handle.
port.ref();
// Worker teardown cannot reap OS process trees. Command execution belongs to the
// host's bash tool; these APIs are outside the worker plugin contract.
const processModule = /^(?:node:)?(?:child_process|cluster)$/;
const rejectProcesses = (name: string) => {
  if (processModule.test(name))
    throw new Error('Worker plugins cannot create subprocesses; use the built-in bash tool.');
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    rejectProcesses(specifier);
    return nextResolve(specifier, context);
  },
});
const getBuiltin = process.getBuiltinModule.bind(process);
process.getBuiltinModule = ((name: string) => {
  rejectProcesses(name);
  return getBuiltin(name);
}) as typeof process.getBuiltinModule;
const identifier = /^[a-zA-Z][a-zA-Z0-9_-]{0,31}$/;
const controllers = new Map<number, AbortController>();
const maxBytes = 1024 * 1024;
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 4096);
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function fields(value: unknown, allowed: string[], label: string): asserts value is Record<string, unknown> {
  if (!object(value) || Object.keys(value).some((key) => !allowed.includes(key)))
    throw new Error(`Unsupported ${label} fields.`);
}
function id(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !identifier.test(value)) throw new Error(`Invalid ${label} identifier.`);
}
function array(value: unknown, label: string): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 64) throw new Error(`Invalid ${label} list (maximum 64).`);
  return value;
}
function unique(values: string[], label: string) {
  if (new Set(values).size !== values.length) throw new Error(`Duplicate ${label} identifiers.`);
}
function schema(value: unknown, depth = 0) {
  fields(
    value,
    ['type', 'description', 'properties', 'required', 'items', 'enum', 'additionalProperties', 'minimum', 'maximum'],
    'JSON schema',
  );
  if (depth > 16) throw new Error('Plugin JSON schema exceeds the nesting limit.');
  if (
    value.type !== undefined &&
    !['object', 'string', 'number', 'integer', 'boolean', 'array'].includes(String(value.type))
  )
    throw new Error('Unsupported plugin JSON schema type.');
  if (value.description !== undefined && typeof value.description !== 'string')
    throw new Error('Invalid schema description.');
  if (value.properties !== undefined) {
    if (!object(value.properties)) throw new Error('Invalid schema properties.');
    for (const child of Object.values(value.properties)) schema(child, depth + 1);
  }
  if (value.items !== undefined) schema(value.items, depth + 1);
  if (
    value.required !== undefined &&
    (!Array.isArray(value.required) || value.required.some((name) => typeof name !== 'string'))
  )
    throw new Error('Invalid required schema fields.');
  if (
    value.enum !== undefined &&
    (!Array.isArray(value.enum) ||
      value.enum.some((item) => typeof item !== 'string' && (typeof item !== 'number' || !Number.isFinite(item))))
  )
    throw new Error('Invalid schema enum.');
  if (value.additionalProperties !== undefined && typeof value.additionalProperties !== 'boolean')
    throw new Error('Invalid additionalProperties.');
  for (const key of ['minimum', 'maximum'])
    if (value[key] !== undefined && (typeof value[key] !== 'number' || !Number.isFinite(value[key])))
      throw new Error('Invalid schema range.');
}
function send(message: unknown) {
  const encoded = JSON.stringify(message);
  if (Buffer.byteLength(encoded) > maxBytes) throw new Error('Plugin response exceeds the 1 MiB limit.');
  port!.postMessage(JSON.parse(encoded));
}
function metadata(value: unknown) {
  fields(value, ['id', 'version', 'tools', 'context', 'memory', 'prompts', 'hooks', 'dispose'], 'plugin');
  if (value.id !== workerData.id || value.version !== workerData.version)
    throw new Error('Plugin id/version must match mh-plugin.json.');
  if (value.dispose !== undefined && typeof value.dispose !== 'function') throw new Error('Invalid plugin dispose.');
  const tools = array(value.tools, 'tools').map((tool) => {
    fields(tool, ['name', 'description', 'parameters', 'readOnly', 'execute'], 'tool');
    id(tool.name, 'tool');
    if (['read', 'write', 'edit', 'bash'].includes(tool.name))
      throw new Error(`Reserved built-in tool name: ${tool.name}`);
    if (`${value.id}__${tool.name}`.length > 64)
      throw new Error('Namespaced tool names must not exceed 64 characters.');
    if (
      typeof tool.description !== 'string' ||
      typeof tool.readOnly !== 'boolean' ||
      !object(tool.parameters) ||
      typeof tool.execute !== 'function'
    )
      throw new Error('Invalid tool definition.');
    schema(tool.parameters);
    if (tool.parameters.type !== 'object') throw new Error('Tool parameters must have object type.');
    return { name: tool.name, description: tool.description, readOnly: tool.readOnly, parameters: tool.parameters };
  });
  unique(
    tools.map((tool) => tool.name),
    'tool',
  );
  const context = array(value.context, 'context').map((provider) => {
    fields(provider, ['id', 'provide'], 'context provider');
    id(provider.id, 'context');
    if (typeof provider.provide !== 'function') throw new Error('Invalid context provider.');
    return provider.id;
  });
  unique(context, 'context');
  const memory = array(value.memory, 'memory').map((strategy) => {
    fields(strategy, ['id', 'recall', 'remember'], 'memory strategy');
    id(strategy.id, 'memory');
    if (
      typeof strategy.recall !== 'function' ||
      (strategy.remember !== undefined && typeof strategy.remember !== 'function')
    )
      throw new Error('Invalid memory strategy.');
    return { id: strategy.id, remember: strategy.remember !== undefined };
  });
  unique(
    memory.map((strategy) => strategy.id),
    'memory',
  );
  const prompts = value.prompts ?? {};
  if (!object(prompts) || Object.keys(prompts).length > 64) throw new Error('Invalid prompt contributions.');
  for (const [name, text] of Object.entries(prompts)) {
    id(name, 'prompt');
    if (typeof text !== 'string') throw new Error('Prompt contributions must be strings.');
  }
  const hooks = array(value.hooks, 'hooks').map((hook) => {
    fields(hook, ['id', 'beforeTool', 'afterTool', 'onStop'], 'hook');
    id(hook.id, 'hook');
    for (const name of ['beforeTool', 'afterTool', 'onStop'])
      if (hook[name] !== undefined && typeof hook[name] !== 'function') throw new Error(`Invalid ${name} hook.`);
    return {
      id: hook.id,
      beforeTool: hook.beforeTool !== undefined,
      afterTool: hook.afterTool !== undefined,
      onStop: hook.onStop !== undefined,
    };
  });
  unique(
    hooks.map((hook) => hook.id),
    'hook',
  );
  return { id: value.id, version: value.version, tools, context, memory, prompts, hooks };
}

try {
  const loaded: unknown = (await import(pathToFileURL(workerData.entry as string).href)).default;
  const description = metadata(loaded);
  const plugin = loaded as PluginDefinition;
  port.on('message', (message: unknown) => {
    if (!object(message) || typeof message.id !== 'number') return;
    if (message.type === 'abort') {
      controllers.get(message.id)?.abort();
      return;
    }
    if (message.type !== 'request' || !Array.isArray(message.args) || typeof message.index !== 'number') return;
    const requestId = message.id,
      index = message.index,
      args = message.args,
      op = message.op;
    if (controllers.size >= 64) {
      send({ type: 'error', id: requestId, error: 'Too many plugin operations.' });
      return;
    }
    const controller = new AbortController();
    controllers.set(requestId, controller);
    void (async () => {
      try {
        let value: unknown;
        if (op === 'execute') {
          const context = {
            ...(args[1] as object),
            signal: controller.signal,
            onUpdate: (text: string) => send({ type: 'update', id: requestId, text }),
          };
          value = await plugin.tools![index]!.execute(
            args[0] as Record<string, unknown>,
            context as Parameters<NonNullable<PluginDefinition['tools']>[number]['execute']>[1],
          );
          if (!object(value) || !Array.isArray(value.content))
            throw new Error('Tool result must have a content array.');
        } else if (op === 'provide' || op === 'recall' || op === 'remember') {
          const context = { ...(args[0] as object), signal: controller.signal } as Parameters<
            NonNullable<PluginDefinition['context']>[number]['provide']
          >[0];
          if (op === 'provide') value = await plugin.context![index]!.provide(context);
          else if (op === 'recall') value = await plugin.memory![index]!.recall(context);
          else
            value = await plugin.memory![index]!.remember!(
              context,
              args[1] as Parameters<NonNullable<NonNullable<PluginDefinition['memory']>[number]['remember']>>[1],
            );
          if (op !== 'remember' && typeof value !== 'string')
            throw new Error('Context and memory providers must return strings.');
        } else if (op === 'beforeTool' || op === 'afterTool' || op === 'onStop') {
          const fn = plugin.hooks![index]![op] as (...values: unknown[]) => unknown;
          value = await fn(...args);
          if (
            op === 'beforeTool' &&
            (!object(value) ||
              !['allow', 'deny'].includes(String(value.action)) ||
              (value.action === 'deny' && typeof value.reason !== 'string'))
          )
            throw new Error('Invalid beforeTool decision.');
          if (op === 'afterTool' && (!object(value) || !Array.isArray(value.content)))
            throw new Error('Invalid afterTool result.');
          if (
            op === 'onStop' &&
            (!object(value) ||
              !['stop', 'continue'].includes(String(value.action)) ||
              (value.action === 'continue' && typeof value.message !== 'string'))
          )
            throw new Error('Invalid onStop decision.');
        } else if (op === 'dispose') value = await plugin.dispose?.();
        else throw new Error('Unknown plugin operation.');
        send({ type: 'result', id: requestId, value });
      } catch (error) {
        send({ type: 'error', id: requestId, error: errorText(error) });
      } finally {
        controllers.delete(requestId);
      }
    })();
  });
  send({ type: 'ready', metadata: description });
} catch (error) {
  send({ type: 'initError', error: errorText(error) });
}
