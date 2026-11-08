import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { relative } from 'node:path';
import { filesUnder } from './check-layers.ts';
const testFiles = filesUnder('test').filter((f) => f.endsWith('.test.ts'));
const violations: string[] = [];
for (const f of testFiles) {
  const text = readFileSync(f, 'utf8');
  if (/\.\s*only\s*\(/.test(text)) violations.push(`${f}: forbidden .only()`);
  if (!(f.startsWith('test/live/') && text.includes('MH_LIVE')) && /\.\s*skip\s*\(|\bskip\s*:/.test(text))
    violations.push(`${f}: forbidden skip`);
}
const run = spawnSync(
  process.execPath,
  [
    '--import',
    './test/helpers/setup.ts',
    '--test',
    '--test-reporter=./scripts/inventory-reporter.ts',
    ...testFiles.filter((f) => !f.startsWith('test/live/')),
  ],
  { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 },
);
if (run.status !== 0) violations.push(`Test run failed: ${run.stderr}\n${run.stdout}`);
const names = run.stdout
  .split('\n')
  .filter((l) => l.startsWith('{'))
  .map((l) => JSON.parse(l) as { type: string; file: string; name: string })
  .filter((e) => e.type === 'test:pass')
  .map((e) => relative('.', e.file).replaceAll('\\', '/') + ' > ' + e.name)
  .sort();
const baselinePath = 'test/test-baseline.json';
const baseline: string[] = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, 'utf8')) : [];
for (const n of baseline) if (!names.includes(n)) violations.push(`Baseline test disappeared: ${n}`);
if (!process.argv.includes('--update') && !existsSync(baselinePath))
  violations.push('Missing test baseline; run --update after checks pass.');
if (violations.length) {
  process.stderr.write(violations.join('\n') + '\n');
  process.exitCode = 1;
} else {
  if (process.argv.includes('--update'))
    writeFileSync(baselinePath, JSON.stringify([...new Set([...baseline, ...names])].sort(), null, 2) + '\n');
  process.stdout.write(`Test inventory: ${names.length} passing names; ${baseline.length} baseline names retained\n`);
}
