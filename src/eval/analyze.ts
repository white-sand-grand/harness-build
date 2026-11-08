import { mkdtemp, cp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { readFileSync } from 'node:fs';
import type { Provider } from '../ai/index.ts';
import type { Config } from '../app/config.ts';
import { startRun } from '../app/run.ts';
import { loadPrompts } from '../app/prompts.ts';
import { renderSession } from '../session/index.ts';
import type { SessionEntry } from '../session/index.ts';
import { sessionId } from '../util/ids.ts';
import { readManifest, readResults } from './runner.ts';
export async function analyzeRun(opts: {
  runDir: string;
  variantsDir: string;
  config: Config;
  provider?: Provider;
  signal?: AbortSignal;
}) {
  const manifest = readManifest(opts.runDir),
    dev = new Set(manifest.tasks.filter((t) => t.split === 'dev').map((t) => t.id)),
    failures = readResults(opts.runDir).filter((r) => dev.has(r.taskId) && r.status !== 'pass');
  const temp = await mkdtemp(join(tmpdir(), 'mh-analyze-')),
    variantDir = join(opts.variantsDir, sessionId());
  try {
    await mkdir(join(temp, 'traces'));
    await cp(join(opts.runDir, 'prompts'), join(temp, 'prompts'), { recursive: true });
    await writeFile(join(temp, 'results.jsonl'), failures.map((r) => JSON.stringify(r)).join('\n') + '\n');
    for (const r of failures) {
      let transcript = 'No agent session (setup or harness failed before starting).';
      if (r.sessionPath) {
        const entries = readFileSync(join(r.sessionPath, 'session.jsonl'), 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l) as SessionEntry);
        transcript = renderSession(entries);
      }
      await writeFile(join(temp, 'traces', r.taskId + '-' + r.attempt + '.md'), transcript);
    }
    if (failures.length) {
      const run = await startRun({
        cwd: temp,
        home: join(temp, 'home'),
        config: { ...opts.config, promptsDir: join(temp, 'prompts') },
        prompt:
          'Please analyze the dev failures in results.jsonl and traces/. Write analysis.md and make only evidence-supported prompt changes.\nAvailable trace files:\n' +
          failures.map((r) => 'traces/' + r.taskId + '-' + r.attempt + '.md').join('\n'),
        systemOverride: loadPrompts(join(temp, 'prompts')).analyze,
        toolsFilter: ['read', 'write', 'edit'],
        writeRoots: [temp],
        maxTurns: 40,
        provider: opts.provider,
        signal: opts.signal,
      });
      if (run.reason !== 'done') throw new Error(`Analyze did not complete: ${run.reason}. ${run.finalText}`);
    } else
      await writeFile(
        join(temp, 'analysis.md'),
        '# Analysis\n\nNo dev failures; prompts unchanged. Heldout attempts were excluded.\n',
      );
    const analysis = await readFile(join(temp, 'analysis.md'), 'utf8');
    await mkdir(variantDir, { recursive: true });
    await cp(join(temp, 'prompts'), variantDir, { recursive: true });
    await writeFile(join(variantDir, 'analysis.md'), analysis);
    return {
      variantDir,
      analysis,
      taskIds: [...new Set(failures.map((r) => r.taskId))],
      sourceVariant: manifest.variant,
    };
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
