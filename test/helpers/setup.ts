import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const home = mkdtempSync(join(tmpdir(), 'mh-test-home-'));
process.env.MH_HOME = home;
process.on('exit', () => rmSync(home, { recursive: true, force: true }));
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error(`Network access in unit tests is not allowed: ${url.origin}`);
  }
  return originalFetch(input, init);
};
