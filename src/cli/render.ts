import type { AgentEvent } from '../agent/index.ts';
export const renderJSON = (event: AgentEvent) => JSON.stringify(event);
export function createRenderer(opts: { hideThinking?: boolean; write?: (s: string) => void } = {}) {
  const write = opts.write ?? ((s: string) => process.stdout.write(s));
  const color = !!process.stdout.isTTY && !process.env.NO_COLOR;
  const style = (s: string, c: string) => (color ? `\u001b[${c}m${s}\u001b[0m` : s);
  let hidden = false;
  return (e: AgentEvent) => {
    if (e.type === 'stream') {
      if (e.event.type === 'textDelta') write(e.event.text);
      if (e.event.type === 'thinkingDelta') {
        if (opts.hideThinking) {
          if (!hidden) write('[thinking…]');
          hidden = true;
        } else write(style(e.event.text, '2'));
      }
    }
    if (e.type === 'message' && e.message.role === 'assistant') {
      write('\n');
      const cache = e.message.cache;
      if (cache?.compatibilityFallback)
        write('[cache] Gateway rejected native cache controls; using compatible Responses.\n');
      if (cache?.diagnostics?.type === 'cache_miss')
        write(`[cache] Miss: ${cache.diagnostics.reason ?? 'unclassified'}.\n`);
      hidden = false;
    }
    if (e.type === 'toolStart')
      write(style(`● ${e.call.name}  ${String(e.call.args.command ?? e.call.args.path ?? '').slice(0, 180)}\n`, '36'));
    if (e.type === 'toolEnd') {
      const text = e.result.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
      const lines = text.split('\n');
      write(
        style(
          lines.slice(0, 10).join('\n') + (lines.length > 10 ? `\n… (${lines.length - 10} more lines)` : '') + '\n',
          e.result.isError ? '31' : '2',
        ),
      );
      const diff = (e.result.details as { diff?: string } | undefined)?.diff;
      if (diff)
        write(
          diff
            .split('\n')
            .map((l) => style(l, l.startsWith('+') ? '32' : l.startsWith('-') ? '31' : '2'))
            .join('\n') + '\n',
        );
    }
    if (e.type === 'agentEnd' && e.error) write(style(e.error + '\n', '31'));
  };
}
