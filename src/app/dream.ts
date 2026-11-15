import { mkdir, writeFile, cp, mkdtemp, rm, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { memoryDir, readIndex } from '../memory/memory-dir.ts';
import { ensureRepo, commitAll, gitHead, diffStat } from '../memory/git.ts';
import { listSessions, openSession, renderSession, createSession } from '../session/index.ts';
import { sessionId } from '../util/ids.ts';
import { startRun, type StartRunOptions } from './run.ts';
import { loadPrompts, renderTemplate } from './prompts.ts';
import { acquireWorkspace, workspaceOwnerFile } from './background/ownership.ts';
import type { Ownership } from '../util/ownership.ts';
function completedSession(session: import('../session/index.ts').SessionStore): boolean {
  const entries = session.entries();
  const end = entries.findLastIndex((entry) => entry.type === 'trace' && entry.name === 'agentEnd');
  const last = entries[end];
  if (
    last?.type !== 'trace' ||
    last.data.reason !== 'done' ||
    entries.slice(end + 1).some((entry) => entry.type === 'message')
  )
    return false;
  const pending = new Set<string>();
  for (const entry of entries)
    if (entry.type === 'message') {
      if (entry.message.role === 'assistant')
        for (const block of entry.message.content) if (block.type === 'toolCall') pending.add(block.id);
      if (entry.message.role === 'toolResult') pending.delete(entry.message.toolCallId);
    }
  return pending.size === 0;
}
export async function runDream(
  opts: Omit<StartRunOptions, 'prompt'> & { sessions?: number; dryRun?: boolean; completedOnly?: boolean },
) {
  const parent = opts.workspaceOwnership ?? acquireWorkspace(opts.home, opts.cwd);
  let memoryOwnership: Ownership | undefined;
  let temporary: string | undefined;
  try {
    if (parent.file !== workspaceOwnerFile(opts.home, opts.cwd)) throw new Error('Dream workspace ownership mismatch.');
    parent.assert();
    const original = memoryDir(opts.home, opts.cwd);
    temporary = opts.dryRun ? await mkdtemp(join(tmpdir(), 'mh-dream-')) : undefined;
    const dir = temporary ? join(temporary, 'memory') : original;
    await mkdir(dir, { recursive: true });
    if (temporary && existsSync(original))
      await cp(original, dir, { recursive: true, filter: (source) => basename(source) !== '.git' });
    ensureRepo(dir);
    memoryOwnership = workspaceOwnerFile(opts.home, dir) === parent.file ? parent : acquireWorkspace(opts.home, dir);
    commitAll(dir, 'pre-dream snapshot');
    const before = gitHead(dir);
    const inputs = join(temporary ?? join(original, '..'), 'dream-input', sessionId());
    await mkdir(inputs, { recursive: true });
    const selected = listSessions(opts.home, opts.cwd)
      .filter((item) => !opts.completedOnly || completedSession(openSession(opts.home, opts.cwd, item.id)))
      .slice(0, opts.sessions ?? 10);
    for (const item of selected)
      await writeFile(
        join(inputs, item.id + '.md'),
        renderSession(openSession(opts.home, opts.cwd, item.id).entries()),
      );
    const prompts = loadPrompts(opts.config.promptsDir),
      session = opts.session ?? createSession(opts.home, opts.cwd);
    const result = await startRun({
      ...opts,
      cwd: dir,
      session,
      workspaceOwnership: memoryOwnership,
      prompt:
        'Review the session transcripts and organize the project memory as instructed.\nAvailable transcript files:\n' +
        selected.map((item) => join(inputs, item.id + '.md')).join('\n') +
        '\nExisting memory files:\n' +
        (await readdir(dir, { recursive: true }))
          .filter((path) => !path.split(/[\\/]/).includes('.git') && path.endsWith('.md'))
          .sort()
          .slice(0, 200)
          .join('\n'),
      systemOverride: renderTemplate(prompts.dream, { inputDir: inputs }),
      toolsFilter: ['read', 'write', 'edit'],
      writeRoots: [dir],
      ...(opts.completedOnly ? { strictReadRoots: [inputs, dir] } : {}),
      ask: undefined,
      maxTurns: opts.maxTurns ?? 40,
    });
    const warnings = readIndex(dir).truncated
      ? ['MEMORY.md exceeds the 200-line / 25KB index limit. Review and shorten it.']
      : [];
    const after = commitAll(dir, 'dream: ' + new Date().toISOString().slice(0, 10)) ?? before;
    return {
      reason: result.reason,
      finalText: result.finalText,
      before,
      after,
      diffStat: diffStat(dir, before, after),
      warnings,
      dryRun: !!temporary,
      sessionPath: result.session.dir,
      usage: result.usage,
      turns: result.turns,
    };
  } finally {
    try {
      if (memoryOwnership && memoryOwnership !== parent) memoryOwnership.release();
      if (temporary) await rm(temporary, { recursive: true, force: true });
    } finally {
      if (!opts.workspaceOwnership) parent.release();
    }
  }
}
