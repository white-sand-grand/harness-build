#!/usr/bin/env node
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig, readProjectSensitive, type Config } from '../app/config.ts';
import { createInterface } from 'node:readline';
import { startRun } from '../app/run.ts';
import { listSessions, openSession } from '../session/index.ts';
import { parseCLI, help } from './args.ts';
import { renderJSON, stripEscapes } from './render.ts';
import { runREPL } from './repl.ts';
import { handleCommand } from './commands.ts';
import { createRuntime, type RuntimeManager } from '../app/runtime.ts';
import type { Asker } from '../hooks/permission.ts';
import { createAsker } from './ask.ts';
// On Windows a bare executable name also resolves against the current directory; a planted
// git.exe/taskkill.exe in a repo would otherwise hijack harness-internal process launches.
process.env.NoDefaultCurrentDirectoryInExePath ??= '1';
export async function main(argv = process.argv.slice(2)): Promise<number> {
  let args: ReturnType<typeof parseCLI>;
  try {
    args = parseCLI(argv);
  } catch (error) {
    console.error((error instanceof Error ? error.message : String(error)) + '\n' + help);
    return 2;
  }
  const v = args.values;
  if (v.help) {
    console.log(help);
    return 0;
  }
  if (v.version) {
    console.log('0.1.0');
    return 0;
  }
  const cwd = resolve(v.cwd ?? process.cwd()),
    home = resolve(process.env.MH_HOME ?? join(homedir(), '.mh'));
  const overrides: Partial<Config> = {};
  if (v.provider) overrides.provider = v.provider as Config['provider'];
  if (v.model) overrides.model = v.model;
  if (v.thinking) overrides.thinking = v.thinking as Config['thinking'];
  if (v.prompts) overrides.promptsDir = resolve(v.prompts);
  if (v.profile !== undefined || v.watch !== undefined)
    overrides.runtime = {
      ...(v.profile !== undefined ? { profile: v.profile } : {}),
      ...(v.watch !== undefined ? { watch: v.watch } : {}),
    };
  if (v.yolo) overrides.permissions = { mode: 'yolo', extraRiskyPatterns: [] };
  const projectSensitive = readProjectSensitive(cwd);
  let trustProject = v['trust-project'];
  if (!trustProject && process.stdin.isTTY && projectSensitive && Object.keys(projectSensitive.sensitive).length) {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    const answer = await new Promise<string>((resolve) =>
      rl.question(
        `Trust this project's configuration (hooks, permissions, models, provider, prompts)?\n${JSON.stringify(projectSensitive.sensitive, null, 2)}\nStore trust for this exact configuration? [y/N] `,
        resolve,
      ),
    );
    rl.close();
    trustProject = answer.trim().toLowerCase() === 'y';
  }
  const config = loadConfig({
    home,
    cwd,
    overrides,
    trustProject,
    warn: (s) => console.error(s),
    projectData: projectSensitive?.data,
  });
  const command = args.positionals[0];
  let runtime: RuntimeManager | undefined;
  let runtimeAsk: Asker | undefined = process.stdin.isTTY
    ? async (question) => {
        const rl = createInterface({ input: process.stdin, output: process.stderr });
        try {
          return await createAsker(rl)(question);
        } finally {
          rl.close();
        }
      }
    : undefined;
  const initializeRuntime = async () => {
    runtime = await createRuntime({
      cwd,
      home,
      config,
      readConfig: () => loadConfig({ home, cwd, overrides, warn: (s) => console.error(s) }),
      ask: (question) => runtimeAsk?.(question) ?? Promise.resolve('deny'),
      trustPlugins: v['trust-project'],
      onDiagnostic: (message) => console.error(message),
    });
  };
  try {
    const runtimeCommand =
      ['plugins', 'evolve'].includes(command ?? '') || (command === 'eval' && args.positionals[1] === 'run');
    if (runtimeCommand && (config.runtime || command === 'plugins')) await initializeRuntime();
    const commandExit = await handleCommand(args, { cwd, home, config, runtime });
    if (commandExit !== undefined) return commandExit;
    if (command === 'sessions') {
      const sessions = listSessions(home, cwd);
      console.log(
        v.json ? JSON.stringify(sessions) : sessions.map((s) => `${s.id}  ${stripEscapes(s.firstUserText)}`).join('\n'),
      );
      return 0;
    }
    const session = v.resume
      ? openSession(home, cwd, v.resume)
      : v.continue
        ? openSession(home, cwd, 'latest')
        : undefined;
    const lastModel = session
      ?.entries()
      .findLast((e) => e.type === 'modelChange' || (e.type === 'message' && e.message.role === 'assistant'));
    const previous =
      lastModel?.type === 'modelChange'
        ? lastModel
        : lastModel?.type === 'message' && lastModel.message.role === 'assistant'
          ? lastModel.message
          : undefined;
    if (previous) {
      if (!v.provider) config.provider = previous.provider;
      if (!v.model && !v.provider) config.model = previous.model;
    }
    let prompt = args.positionals.join(' ');
    if (!v.print && !v.json && process.stdin.isTTY) {
      if (config.runtime && !runtime) await initializeRuntime();
      await runREPL(
        {
          cwd,
          home,
          config,
          session,
          runtime,
          onAsker: (ask) => {
            runtimeAsk = ask;
          },
          maxTurns: v['max-turns'] ? Number(v['max-turns']) : undefined,
        },
        prompt,
        v['hide-thinking'],
      );
      return 0;
    }
    if (!prompt && !process.stdin.isTTY) {
      for await (const chunk of process.stdin) prompt += String(chunk);
    }
    if (!prompt.trim()) {
      console.error('A prompt is required in print mode.\n' + help);
      return 2;
    }
    if (config.runtime && !runtime) await initializeRuntime();
    const controller = new AbortController(),
      interrupt = () => controller.abort();
    process.on('SIGINT', interrupt);
    const entryStart = session?.entries().length ?? 0;
    try {
      const result = await startRun({
        cwd,
        home,
        config,
        runtime,
        session,
        prompt,
        signal: controller.signal,
        maxTurns: v['max-turns'] ? Number(v['max-turns']) : 50,
        onEvent: (e) => {
          if (v.json) process.stdout.write(renderJSON(e) + '\n');
          else if (e.type === 'agentEnd' && e.error) console.error(stripEscapes(e.error));
        },
      });
      if (!v.json && result.finalText) console.log(stripEscapes(result.finalText));
      if (
        result.session
          .entries()
          .slice(entryStart)
          .some((e) => e.type === 'trace' && e.name === 'hook' && e.data.exhausted)
      )
        console.error('检查仍失败：stop-check 已达到自动继续次数上限。');
      return result.reason === 'done' ? 0 : result.reason === 'aborted' ? 130 : 1;
    } finally {
      process.removeListener('SIGINT', interrupt);
    }
  } finally {
    await runtime?.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
