import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSSE } from '../../../src/ai/sse.ts';
async function parse(chunks: Uint8Array[]) {
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (const chunk of chunks) c.enqueue(chunk);
      c.close();
    },
  });
  const events = [];
  for await (const event of parseSSE(stream, new AbortController().signal)) events.push(event);
  return events;
}
const encode = (s: string) => new TextEncoder().encode(s);
test('splits events across arbitrary chunk boundaries', async () => {
  const bytes = encode('event: hi\ndata: one\n\ndata: two\n\n');
  for (let n = 1; n < bytes.length; n++)
    assert.deepEqual(await parse([bytes.slice(0, n), bytes.slice(n)]), [
      { event: 'hi', data: 'one' },
      { event: 'message', data: 'two' },
    ]);
});
test('handles CRLF', async () =>
  assert.deepEqual(await parse([encode('data: a\r\n\r\n')]), [{ event: 'message', data: 'a' }]));
test('joins multi-line data', async () =>
  assert.equal((await parse([encode('data: a\ndata: b\n\n')]))[0]?.data, 'a\nb'));
test('ignores comments', async () =>
  assert.deepEqual(await parse([encode(': ping\n\ndata: a\n\n')]), [{ event: 'message', data: 'a' }]));
test('decodes multi-byte UTF-8 split across chunks', async () => {
  const bytes = encode('data: 中文🙂\n\n');
  assert.equal((await parse([...bytes].map((b) => new Uint8Array([b]))))[0]?.data, '中文🙂');
});
test('aborts the stream when an event exceeds the buffer limit', async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(encode('data: ' + 'x'.repeat(3 * 1024 * 1024)));
      c.close();
    },
  });
  await assert.rejects(
    (async () => {
      for await (const _ of parseSSE(stream, new AbortController().signal)) {
        /* consume until the guard fires */
      }
    })(),
    /buffer without a message boundary/,
  );
});
test('a legitimately large but bounded stream still parses', async () => {
  const events = await parse([encode('data: ' + 'x'.repeat(1024 * 1024) + '\n\n')]);
  assert.equal(events.length, 1);
});
