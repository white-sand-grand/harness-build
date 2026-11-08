export default async function* reporter(
  events: AsyncIterable<{ type: string; data: { name: string; file?: string; nesting?: number } }>,
) {
  const parents = new Map<string, string[]>();
  for await (const event of events) {
    if (!['test:pass', 'test:fail', 'test:start'].includes(event.type)) continue;
    const { file = '', name, nesting = 0 } = event.data;
    const chain = parents.get(file) ?? [];
    chain[nesting] = name;
    chain.length = nesting + 1;
    parents.set(file, chain);
    if (event.type !== 'test:start') yield JSON.stringify({ type: event.type, file, name: chain.join(' > ') }) + '\n';
  }
}
