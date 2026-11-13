import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  root: fileURLToPath(new URL('./renderer/', import.meta.url)),
  base: './',
  build: {
    outDir: fileURLToPath(new URL('./dist/renderer/', import.meta.url)),
    emptyOutDir: true,
    target: 'es2023',
  },
});
