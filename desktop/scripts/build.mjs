import { build as viteBuild } from 'vite';
import { build as bundle } from 'tsup';
import { cpSync, mkdirSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
const desktop = fileURLToPath(new URL('../', import.meta.url));
const common = {
  outDir: `${desktop}/dist`,
  platform: 'node',
  target: 'node24',
  bundle: true,
  splitting: false,
  sourcemap: true,
  clean: false,
  external: ['electron'],
};
await bundle({
  ...common,
  entry: {
    'main/index': `${desktop}/main/index.ts`,
    'host/index': `${desktop}/host/index.ts`,
    'host/plugin-worker': `${desktop}/../src/app/plugin-worker.ts`,
  },
  format: ['esm'],
});
await bundle({
  ...common,
  entry: { 'preload/index': `${desktop}/preload/index.ts` },
  format: ['cjs'],
  outExtension: () => ({ js: '.cjs' }),
});
await viteBuild({ configFile: `${desktop}/vite.config.ts` });
mkdirSync(`${desktop}/dist/assets`, { recursive: true });
cpSync(`${desktop}/../prompts`, `${desktop}/dist/assets/prompts`, { recursive: true });
cpSync(`${desktop}/../src/util/windows-job.ps1`, `${desktop}/dist/host/windows-job.ps1`);
cpSync(`${desktop}/assets/moon.png`, `${desktop}/dist/assets/moon.png`);
cpSync(`${desktop}/assets/host-job.ps1`, `${desktop}/dist/assets/host-job.ps1`);
mkdirSync(`${desktop}/dist/licenses`, { recursive: true });
cpSync(`${desktop}/node_modules/react/LICENSE`, `${desktop}/dist/licenses/react.txt`);
cpSync(`${desktop}/node_modules/react-dom/LICENSE`, `${desktop}/dist/licenses/react-dom.txt`);
const rendererRequire = createRequire(realpathSync(`${desktop}/node_modules/react-dom/package.json`));
cpSync(
  join(dirname(rendererRequire.resolve('scheduler/package.json')), 'LICENSE'),
  `${desktop}/dist/licenses/scheduler.txt`,
);
cpSync(`${desktop}/assets/THIRD_PARTY_NOTICES.md`, `${desktop}/dist/licenses/THIRD_PARTY_NOTICES.md`);
