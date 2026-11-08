export function matchesGlob(pattern: string, path: string): boolean {
  pattern = pattern.replaceAll('\\', '/');
  path = path.replaceAll('\\', '/').replace(/^\.\//, '');
  const brace = /\{([^{}]+)\}/.exec(pattern);
  if (brace)
    return brace[1]!
      .split(',')
      .some((p) => matchesGlob(pattern.slice(0, brace.index) + p + pattern.slice(brace.index + brace[0].length), path));
  let re = '^';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === '*' && pattern[i + 1] === '*') {
      i++;
      if (pattern[i + 1] === '/') {
        re += '(?:.*/)?';
        i++;
      } else re += '.*';
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^$()|[\]{}]/g, '\\$&');
  }
  return new RegExp(re + '$').test(path);
}
