import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

function capture(): string {
  const root = fileURLToPath(new URL('../', import.meta.url)),
    hash = createHash('sha256');
  hash.update(JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch }));
  if (!existsSync(join(root, 'agent')) || !existsSync(join(root, 'tools')))
    return hash.update(readFileSync(fileURLToPath(import.meta.url))).digest('hex');
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (/\.(?:ts|js|ps1)$/.test(entry.name))
        hash.update(relative(root, file).replaceAll('\\', '/')).update('\0').update(readFileSync(file)).update('\0');
    }
  };
  visit(root);
  return hash.digest('hex');
}
/** Built-in modules stay loaded for this process generation; disk edits require a restart. */
export const loadedImplementationHash = capture();
