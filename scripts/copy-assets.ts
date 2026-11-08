import { copyFileSync, mkdirSync } from 'node:fs';
mkdirSync('dist/util', { recursive: true });
copyFileSync('src/util/windows-job.ps1', 'dist/util/windows-job.ps1');
