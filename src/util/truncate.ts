export function truncate(text: string, maxChars: number, maxLines: number) {
  const all = text.split('\n');
  if (text.length <= maxChars && all.length <= maxLines) return undefined;
  const count = Math.max(1, Math.floor(maxLines * 0.4)),
    chars = Math.max(1, Math.floor(maxChars * 0.4));
  const head = all.slice(0, count).join('\n').slice(0, chars),
    tail = all.slice(-count).join('\n').slice(-chars);
  return {
    head,
    tail,
    omittedChars: Math.max(0, text.length - head.length - tail.length),
    omittedLines: Math.max(0, all.length - head.split('\n').length - tail.split('\n').length),
  };
}
