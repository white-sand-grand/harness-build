import { createInterface } from 'node:readline';
import type { Message } from '../ai/index.ts';
import { resolveModel, cost } from '../ai/index.ts';
import { summarizeTrace } from '../eval/report.ts';
import { startRun, type StartRunOptions } from '../app/run.ts';
import type { SessionStore } from '../session/index.ts';
import { createRenderer } from './render.ts';
import { createAsker } from './ask.ts';
import { compactSession } from '../app/compact.ts';
import { memoryDir, readIndex } from '../memory/memory-dir.ts';
export async function runREPL(opts: Omit<StartRunOptions, 'prompt'>, initial = '', hideThinking = false) {
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: 'mh> ' });
  const ask = createAsker(rl),
    render = createRenderer({ hideThinking });
  let session: SessionStore | undefined = opts.session,
    busy: Promise<void> | undefined,
    controller: AbortController | undefined,
    lastInterrupt = 0,
    multiline: string[] | undefined;
  const queue: Message[] = [];
  function launch(prompt: string) {
    const entryStart = session?.entries().length ?? 0;
    controller = new AbortController();
    busy = startRun({
      ...opts,
      prompt,
      session,
      ask,
      signal: controller.signal,
      onEvent: render,
      getSteering: () => queue.splice(0),
    })
      .then((r) => {
        session = r.session;
        const input = r.usage.input + r.usage.cacheRead + r.usage.cacheWrite,
          cache = summarizeTrace(r.session.entries().slice(entryStart)).cache,
          price = cost(r.usage, resolveModel(opts.config.model, opts.config.models, opts.config.provider));
        console.log(
          `tokens ${input} in / ${r.usage.output} out · cache read ${cache.readReported ? r.usage.cacheRead : 'n/a'} / write ${cache.writeReported ? r.usage.cacheWrite : 'n/a'} · cache hit ${cache.hitRate === null ? 'n/a' : (cache.hitRate * 100).toFixed(1) + '%'} · cost ${price === undefined ? 'n/a' : '$' + price.toFixed(6)} · ${r.reason}`,
        );
        if (
          r.session
            .entries()
            .slice(entryStart)
            .some((e) => e.type === 'trace' && e.name === 'hook' && e.data.exhausted)
        )
          console.error('检查仍失败：stop-check 已达到自动继续次数上限。');
      })
      .catch((e) => console.error(e instanceof Error ? e.message : String(e)))
      .finally(() => {
        busy = undefined;
        controller = undefined;
        rl.prompt();
      });
  }
  rl.on('line', (line) => {
    if (line === '"""') {
      if (multiline) {
        const text = multiline.join('\n');
        multiline = undefined;
        if (busy) queue.push({ role: 'user', content: [{ type: 'text', text }] });
        else launch(text);
      } else multiline = [];
      return;
    }
    if (multiline) {
      multiline.push(line);
      return;
    }
    if (!line.trim()) {
      rl.prompt();
      return;
    }
    if (busy) {
      queue.push({ role: 'user', content: [{ type: 'text', text: line }] });
      console.log('[queued]');
      return;
    }
    if (line.startsWith('/')) {
      const [command, ...args] = line.trim().split(/\s+/);
      if (command === '/exit') {
        rl.close();
        return;
      }
      if (command === '/clear') {
        session = undefined;
        queue.length = 0;
      } else if (command === '/session') console.log(session?.id ?? '(no session)');
      else if (command === '/model') {
        if (args[0]) {
          opts.config = { ...opts.config, model: args[0] };
          session?.append({ type: 'modelChange', provider: opts.config.provider, model: args[0] });
          console.log('Model changed; request cache may be invalidated.');
        } else console.log(opts.config.model);
      } else if (command === '/compact') {
        controller = new AbortController();
        busy = compactSession({ ...opts, prompt: '', session, signal: controller.signal })
          .then((ok) => console.log(ok ? 'Context compacted.' : 'No compaction performed.'))
          .catch((e) => console.error(String(e)))
          .finally(() => {
            busy = undefined;
            controller = undefined;
            rl.prompt();
          });
        return;
      } else if (command === '/memory') {
        const dir = memoryDir(opts.home, opts.cwd);
        console.log(dir + '\n' + readIndex(dir).text);
      } else if (command === '/cost') {
        const stats = summarizeTrace(session?.entries() ?? []);
        console.log(
          JSON.stringify({
            model: opts.config.model,
            usage: stats.usage,
            cache: stats.cache,
            modelCalls: stats.modelCalls,
            cost: stats.cost ?? 'n/a',
          }),
        );
      } else console.log('/help /model <id> /compact /clear /cost /session /exit');
      rl.prompt();
      return;
    }
    launch(line);
  });
  rl.on('SIGINT', () => {
    if (busy) {
      controller?.abort();
      return;
    }
    const now = Date.now();
    if (now - lastInterrupt < 2000) rl.close();
    else {
      lastInterrupt = now;
      console.log('再按一次 Ctrl+C 退出。');
      rl.prompt();
    }
  });
  const closed = new Promise<void>((resolve) =>
    rl.once('close', () => {
      controller?.abort();
      resolve();
    }),
  );
  if (initial) launch(initial);
  else rl.prompt();
  await closed;
  await busy;
}
