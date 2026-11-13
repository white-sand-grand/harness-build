import { readFileSync, readdirSync } from 'node:fs';
import { relative, resolve, dirname } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? files(resolve(dir, entry.name))
      : /\.tsx?$/.test(entry.name)
        ? [resolve(dir, entry.name)]
        : [],
  );
const violations: string[] = [];
for (const area of ['renderer', 'main', 'preload', 'host']) {
  for (const file of files(resolve(root, 'desktop', area))) {
    const source = readFileSync(file, 'utf8');
    const label = relative(root, file).replaceAll('\\', '/');
    const fail = (message: string) => violations.push(`${label}: ${message}`);
    for (const match of source.matchAll(
      /\b(?:import|export)\s+(?:type\s+)?[^;'"`]*?\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]/g,
    )) {
      const target = (match[1] ?? match[2])!;
      if (area === 'renderer' && /^(?:node:|electron$|fs$|child_process$|path$)/.test(target))
        fail(`renderer cannot import ${target}`);
      if (area === 'preload' && target.startsWith('node:')) fail(`preload cannot import ${target}`);
      if (!target.startsWith('.')) continue;
      const destination = relative(root, resolve(dirname(file), target)).replaceAll('\\', '/');
      const local = `desktop/${area}/`;
      const contract = destination === 'desktop/contracts.ts';
      const core =
        area === 'host' && /^src\/(?:app|ai|agent|session|tools|hooks|context|memory|util)\//.test(destination);
      if (!destination.startsWith(local) && !contract && !core) fail(`${area} may not import ${destination}`);
    }
    if (/\bprocess\s*\.\s*chdir\s*\(/.test(source)) fail('Pass cwd explicitly; process.chdir is forbidden.');
    if (/\b(?:console\s*\.\s*(?:log|error)|process\s*\.\s*(?:stdout|stderr)\s*\.\s*write)\s*\(/.test(source))
      fail('Use events/UI instead of terminal output.');
  }
}
for (const violation of violations) process.stderr.write(violation + '\n');
process.stdout.write(`Desktop layer checks: ${violations.length} violations\n`);
process.exitCode = violations.length ? 1 : 0;
