import type { AgentEvent } from '../agent/index.ts';
export const renderJSON = (event: AgentEvent) => JSON.stringify(event);
/**
 * Strips terminal control sequences (CSI/OSC/DCS and other C0 bytes) from untrusted content
 * before it reaches the terminal: model text and tool output could otherwise hijack the window
 * title, hide the cursor, write the clipboard (OSC 52) or fake harness UI while the user is
 * answering a permission prompt. Newlines and tabs are preserved.
 */
export function stripEscapes(text: string): string {
  return text
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[PX^_].*?\x1b\\/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0d\x0e-\x1f\x7f]/g, (c) => (c === '\t' ? c : ''))
    .replace(/\x1b./g, '');
}
export function createRenderer(opts: { hideThinking?: boolean; write?: (s: string) => void } = {}) {
  const write = opts.write ?? ((s: string) => process.stdout.write(s));
  const color = !!process.stdout.isTTY && !process.env.NO_COLOR;
  const style = (s: string, c: string) => (color ? `\u001b[${c}m${s}\u001b[0m` : s);
  let hidden = false;
  return (e: AgentEvent) => {
    if (e.type === 'stream') {
      if (e.event.type === 'textDelta') write(stripEscapes(e.event.text));
      if (e.event.type === 'thinkingDelta') {
        if (opts.hideThinking) {
          if (!hidden) write('[thinking…]');
          hidden = true;
        } else write(style(stripEscapes(e.event.text), '2'));
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
      write(
        style(
          `● ${e.call.name}  ${stripEscapes(String(e.call.args.command ?? e.call.args.path ?? '')).slice(0, 180)}\n`,
          '36',
        ),
      );
    if (e.type === 'toolEnd') {
      const text = stripEscapes(
        e.result.content
          .filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join('\n'),
      );
      const lines = text.split('\n').map((line) => line.slice(0, 2000));
      write(
        style(
          lines.slice(0, 10).join('\n') + (lines.length > 10 ? `\n… (${lines.length - 10} more lines)` : '') + '\n',
          e.result.isError ? '31' : '2',
        ),
      );
      const diff = (e.result.details as { diff?: string } | undefined)?.diff;
      if (diff)
        write(
          stripEscapes(diff)
            .split('\n')
            .map((l) => style(l.slice(0, 2000), l.startsWith('+') ? '32' : l.startsWith('-') ? '31' : '2'))
            .join('\n') + '\n',
        );
    }
    if (e.type === 'agentEnd' && e.error) write(style(stripEscapes(e.error) + '\n', '31'));
  };
}
