import { readFileSync, readdirSync } from 'node:fs';
import { posix, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const ranks: Record<string, number> = {
  util: 0,
  ai: 1,
  agent: 2,
  session: 2,
  tools: 3,
  context: 3,
  memory: 3,
  hooks: 3,
  app: 4,
  eval: 5,
  cli: 6,
};
export type Violation = { file: string; line: number; message: string };
export function checkFile(file: string, source: string): Violation[] {
  file = file.replaceAll('\\', '/');
  const own = file.split('/')[1]!;
  const result: Violation[] = [];
  function fail(index: number, message: string) {
    result.push({ file, line: source.slice(0, index).split('\n').length, message });
  }
  function checkImport(index: number, target: string) {
    if (
      ['agent', 'ai'].includes(own) &&
      /^(node:)?(fs(?:\/promises)?|child_process|readline(?:\/promises)?)$/.test(target)
    ) {
      fail(index, `${own} may not import ${target}. Inject IO through callbacks.`);
    }
    if (!target.startsWith('.')) return;
    const dest = posix.normalize(posix.join(posix.dirname(file), target));
    if (dest.startsWith('dist/')) {
      fail(index, 'Tests may not import dist/. Import src/ instead.');
      return;
    }
    if (!file.startsWith('src/')) return;
    const other = dest.split('/')[1]!;
    if (!dest.startsWith('src/') || ranks[other] === undefined || (other !== own && ranks[other]! >= ranks[own]!)) {
      fail(
        index,
        `${file} imports ${dest} — ${own} (rank ${ranks[own]}) may not depend on ${other} (rank ${ranks[other]}). Inject the dependency instead.`,
      );
    }
  }
  // Deliberately small static checker, as specified in the plan; TS 7 has no JS compiler API.
  const imports =
    /(?:\b(?:import|export)\s+(?:type\s+)?[^;'"`]*?\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s*)['"]([^'"]+)['"]/g;
  for (const m of source.matchAll(imports)) checkImport(m.index, m[1]!);
  const code = source.replace(
    /\/\/[^\n]*|\/\*[\s\S]*?\*\/|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g,
    (s) => s.replace(/[^\n]/g, ' '),
  );
  for (const m of code.matchAll(/\bprocess\s*\.\s*chdir\s*\(/g))
    fail(m.index, 'process.chdir is forbidden. Pass cwd explicitly.');
  if (file.startsWith('src/') && own !== 'cli') {
    for (const m of code.matchAll(
      /\b(?:console\s*\.\s*(?:log|error)|process\s*\.\s*(?:stdout|stderr)\s*\.\s*write)\s*\(/g,
    ))
      fail(m.index, 'Only cli/ may write terminal output. Emit an event or return data.');
  }
  return result;
}
export function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? filesUnder(`${dir}/${e.name}`) : [`${dir}/${e.name}`],
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const violations = ['src', 'test']
    .flatMap(filesUnder)
    .filter((f) => f.endsWith('.ts'))
    .flatMap((f) => checkFile(relative('.', f), readFileSync(f, 'utf8')));
  for (const v of violations) process.stderr.write(`${v.file}:${v.line} ${v.message}\n`);
  process.stdout.write(`Layer checks: ${violations.length} violations\n`);
  process.exitCode = violations.length ? 1 : 0;
}
