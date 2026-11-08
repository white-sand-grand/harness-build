import { createServer, type IncomingMessage } from 'node:http';
export type Reply = { status?: number; headers?: Record<string, string>; chunks?: string[]; disconnect?: boolean };
export async function withSSEServer<T>(
  reply: (body: unknown, attempt: number, req: IncomingMessage) => Reply,
  fn: (url: string) => Promise<T>,
): Promise<T> {
  let attempt = 0;
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += String(chunk);
    const spec = reply(raw ? JSON.parse(raw) : {}, ++attempt, req);
    res.writeHead(spec.status ?? 200, { 'content-type': 'text/event-stream', ...spec.headers });
    for (const chunk of spec.chunks ?? []) res.write(chunk);
    if (spec.disconnect) {
      res.flushHeaders();
      setImmediate(() => res.destroy());
    } else res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Server address unavailable');
  try {
    return await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
export const sse = (data: unknown, event?: string) =>
  `${event ? `event: ${event}\n` : ''}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;
export function anthropicFixture(blocks: Record<string, unknown>[], stop = 'end_turn'): string[] {
  return [
    sse({
      type: 'message_start',
      message: { usage: { input_tokens: 10, cache_read_input_tokens: 4, cache_creation_input_tokens: 2 } },
    }),
    ...blocks.flatMap((b, index) => {
      const delta =
        b.type === 'tool_use'
          ? { type: 'input_json_delta', partial_json: b.raw ?? '{"path":"a"}' }
          : b.type === 'thinking'
            ? { type: 'thinking_delta', thinking: 'reason' }
            : { type: 'text_delta', text: 'hello' };
      return [
        sse({ type: 'content_block_start', index, content_block: b }),
        sse({ type: 'content_block_delta', index, delta }),
        ...(b.type === 'thinking'
          ? [sse({ type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: 'signed' } })]
          : []),
        sse({ type: 'content_block_stop', index }),
      ];
    }),
    sse({ type: 'message_delta', delta: { stop_reason: stop }, usage: { output_tokens: 7 } }),
    sse({ type: 'message_stop' }),
  ];
}
