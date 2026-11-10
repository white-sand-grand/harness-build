import { analyzeRun } from './analyze.ts';

export type PromptOptimizer = {
  id: string;
  version: string;
  propose: typeof analyzeRun;
};

export const evidenceOptimizer: PromptOptimizer = {
  id: 'evidence',
  version: '1',
  propose: analyzeRun,
};
