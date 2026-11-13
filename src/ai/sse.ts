/** A single SSE event larger than this is hostile (unbounded buffer → OOM/CPU exhaustion); abort the stream. */
const MAX_EVENT_CHARS = 2 * 1024 * 1024;
export type SSEEvent = { event: string; data: string };
export async function* parseSSE(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<SSEEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', cancel, { once: true });
  function event(raw: string): SSEEvent | undefined {
    let name = 'message';
    const data: string[] = [];
    for (const line of raw.split(/\r?\n/)) {
      if (line.startsWith('event:')) name = line.slice(6).replace(/^ /, '');
      if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    return data.length ? { event: name, data: data.join('\n') } : undefined;
  }
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        const next = event(buffer.slice(0, boundary.index));
        buffer = buffer.slice(boundary.index + boundary[0].length);
        if (next) yield next;
      }
      // The scan above removes complete events; anything left here has no boundary yet.
      if (buffer.length > MAX_EVENT_CHARS)
        throw new Error(`SSE event exceeded the ${MAX_EVENT_CHARS} character buffer without a message boundary.`);
      if (done) {
        if (buffer) {
          const last = event(buffer);
          if (last) yield last;
        }
        break;
      }
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
