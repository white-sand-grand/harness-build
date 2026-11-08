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
