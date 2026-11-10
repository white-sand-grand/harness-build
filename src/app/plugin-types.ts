import type { Message } from '../ai/index.ts';
import type { AgentEndReason, Hooks, Tool } from '../agent/index.ts';

export type PluginContext = {
  cwd: string;
  home: string;
  sessionDir: string;
  prompt: string;
  messages: Message[];
  signal: AbortSignal;
};

export type ContextProvider = {
  id: string;
  provide(context: PluginContext): Promise<string>;
};
export type MemoryStrategy = {
  id: string;
  recall(context: PluginContext): Promise<string>;
  remember?(context: PluginContext, reason: AgentEndReason): Promise<void>;
};
export type PluginHooks = Pick<Hooks, 'beforeTool' | 'afterTool' | 'onStop'>;
export type HookContribution = PluginHooks & { id: string };

/** A trusted module exports this object. Each module generation runs in its own worker. */
export type PluginDefinition = {
  id: string;
  version: string;
  tools?: Tool[];
  context?: ContextProvider[];
  memory?: MemoryStrategy[];
  prompts?: Record<string, string>;
  hooks?: HookContribution[];
  dispose?(): Promise<void>;
};
export type PreparedPlugin = PluginDefinition & {
  fingerprint: string;
  files: string[];
};
export type PluginDescriptor = {
  id: string;
  version: string;
  fingerprint: string;
  files: string[];
  directory: string;
};

export type RuntimeProfile = {
  tools?: string[];
  context?: string[];
  memory?: string[];
  prompts?: string[];
  hooks?: string[];
  reducer?: 'default' | 'clear' | 'none';
  offload?: boolean;
  promptsDir?: string;
  promptArtifact?: string;
};
export type RuntimeConfig = {
  profile?: string;
  profiles?: Record<string, RuntimeProfile>;
  plugins?: string[];
  watch?: boolean;
};
