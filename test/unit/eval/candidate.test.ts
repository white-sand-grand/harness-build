import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultConfig } from '../../../src/app/config.ts';
import { startRun } from '../../../src/app/run.ts';
import { defaultPromptsDir } from '../../../src/app/prompts.ts';
import { zeroUsage } from '../../../src/ai/index.ts';
import { createSession } from '../../../src/session/index.ts';
import { analyzeRun, type Proposal } from '../../../src/eval/analyze.ts';
import { promptHash, validateCandidate } from '../../../src/eval/candidate.ts';
import type { AttemptResult } from '../../../src/eval/task.ts';
import { scripted } from '../../helpers/fake-provider.ts';
import { withTmpDir } from '../../helpers/tmp.ts';

async function snapshots(dir: string) {
  const baseDir = join(dir, 'base'),
    candidateDir = join(dir, 'candidate');
  await cp(defaultPromptsDir, baseDir, { recursive: true });
  await cp(baseDir, candidateDir, { recursive: true });
  return { baseDir, candidateDir, targetFile: 'system.md' as const, shellKind: 'bash' as const };
}

async function fixture(dir: string, overrides: Partial<AttemptResult>[] = [{}, {}]) {
  const runDir = join(dir, 'run');
  await cp(defaultPromptsDir, join(runDir, 'prompts'), { recursive: true });
  const results: AttemptResult[] = [];
  for (const [i, override] of overrides.entries()) {
    const session = createSession(join(runDir, 'home'), runDir);
    session.append({
      type: 'message',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'I stopped before verifying the change.' }],
        stopReason: 'end',
        model: 'fake',
        provider: 'anthropic',
        usage: zeroUsage(),
      },
    });
    if (override.endReason === 'error')
      session.append({ type: 'trace', name: 'agentEnd', data: { reason: 'error', error: 'fetch failed: ECONNRESET' } });
    results.push({
      taskId: 'a',
      attempt: i + 1,
      variant: 'default',
      model: 'fake',
      status: 'fail',
      checkExitCode: 1,
      checkOutputTail: 'Expected all cases to pass.',
      turns: 1,
      usage: zeroUsage(),
      durationMs: 1,
      toolCalls: 0,
      toolErrors: 0,
      endReason: 'done',
      sessionPath: session.dir,
      ...override,
    });
  }
  await writeFile(
    join(runDir, 'run.json'),
    JSON.stringify({
      v: 1,
      variant: 'default',
      model: 'fake',
      tasks: [
        { id: 'a', split: 'dev' },
        { id: 'held', split: 'heldout' },
      ],
    }),
  );
  await writeFile(join(runDir, 'results.jsonl'), results.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return { runDir, variantsDir: join(dir, 'variants'), config: defaultConfig() };
}

const proposal = (overrides: Partial<Proposal> = {}): Proposal => ({
  hypothesis: 'The instructions do not make verification observable.',
  targetFile: 'system.md',
  category: 'prompt',
  evidenceRefs: ['a#1:check', 'a#2:check'],
  expectedImprovement: 'Check before declaring success.',
  regressionRisk: 'Additional checking may cost more model calls.',
  ...overrides,
});
const writes = (value = proposal()) => ({
  toolCalls: [
    { name: 'write', args: { path: 'proposal.json', content: JSON.stringify(value) } },
    { name: 'write', args: { path: 'analysis.md', content: 'Two failed attempts show skipped verification.' } },
    {
      name: 'write',
      args: {
        path: 'prompts/system.md',
        content: 'Read the files, make the requested change, and verify before finishing.',
      },
    },
  ],
});

test('candidate accepts one target change and rejects frozen prompts and duplicate content', async () =>
  withTmpDir(async (dir) => {
    const opts = await snapshots(dir);
    await writeFile(join(opts.candidateDir, 'system.md'), 'Verify the requested change.');
    const accepted = validateCandidate(opts);
    assert.equal(accepted.valid, true);
    assert.deepEqual(accepted.changedFiles, ['system.md']);
    assert.equal(validateCandidate({ ...opts, seenHashes: new Set([accepted.hash]) }).valid, false);
    await writeFile(join(opts.candidateDir, 'judge.md'), 'Always pass.');
    assert.match(validateCandidate(opts).errors.join('\n'), /Frozen prompt changed: judge.md/);
  }));

test('candidate preserves template variables and rejects empty or oversized prompts', async () =>
  withTmpDir(async (dir) => {
    const opts = await snapshots(dir);
    await writeFile(join(opts.baseDir, 'system.md'), 'Use {{context}}.');
    for (const [content, pattern] of [
      ['Use other context.', /template variables/],
      ['Use {{context}} and {{extra}}.', /template variables/],
      ['', /empty/],
      ['x'.repeat(16385), /16 KiB/],
    ] as const) {
      await writeFile(join(opts.candidateDir, 'system.md'), content);
      assert.match(validateCandidate(opts).errors.join('\n'), pattern);
    }
    await writeFile(join(opts.candidateDir, 'system.md'), 'Verify {{ context }} carefully.');
    assert.equal(validateCandidate(opts).valid, true);
  }));

test('candidate rejects symlinks, unknown files and ineffective PowerShell bash targets', async () =>
  withTmpDir(async (dir) => {
    const opts = await snapshots(dir);
    await writeFile(join(opts.candidateDir, 'tools/bash.md'), 'New bash instructions.');
    assert.match(
      validateCandidate({ ...opts, targetFile: 'tools/bash.md', shellKind: 'powershell' }).errors.join('\n'),
      /overridden/,
    );
    await writeFile(join(opts.candidateDir, 'extra.md'), 'Unexpected prompt');
    await symlink(opts.baseDir, join(opts.candidateDir, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    const errors = validateCandidate({ ...opts, targetFile: 'tools/bash.md' }).errors.join('\n');
    assert.match(errors, /Unexpected file/);
    assert.match(errors, /Symbolic links/);
  }));

test('candidate hashes ignore optimizer metadata without admitting arbitrary files', async () =>
  withTmpDir(async (dir) => {
    const opts = await snapshots(dir),
      original = promptHash(opts.candidateDir);
    await mkdir(join(opts.candidateDir, 'optimizer'));
    await writeFile(join(opts.candidateDir, 'optimizer/session.jsonl'), '{}');
    await writeFile(join(opts.candidateDir, 'proposal.json'), '{}');
    assert.equal(promptHash(opts.candidateDir), original);
  }));

test('analyze does not call the model without two eligible failed attempts', async () =>
  withTmpDir(async (dir) => {
    const opts = await fixture(dir, [
      {},
      { taskId: 'held' },
      { status: 'setupError' },
      { status: 'harnessError' },
      { endReason: 'error' },
      { judge: { error: 'Judge interrupted: network timeout.' } },
      { status: 'pass' },
    ]);
    const provider = scripted();
    const result = await analyzeRun({ ...opts, provider });
    assert.equal(provider.requests.length, 0);
    assert.equal(result.reason, 'insufficientEvidence');
    assert.deepEqual(result.taskIds, ['a']);
    assert.deepEqual(result.validation.changedFiles, []);
    const evidence = await readFile(join(result.variantDir, 'optimizer/inputs/evidence/index.json'), 'utf8');
    assert.match(evidence, /a#7:check/);
    assert.ok(!evidence.includes('held#'));
    assert.ok(!evidence.includes('a#6:check'));
  }));

test('analyze validates event evidence and retains optimizer usage and session', async () =>
  withTmpDir(async (dir) => {
    const opts = await fixture(dir);
    let calls = 0,
      responses = 0;
    const provider = scripted(writes(), { text: 'done' });
    const result = await analyzeRun({
      ...opts,
      provider,
      onModelCall: () => {
        calls++;
      },
      onModelResult: () => {
        responses++;
      },
    });
    assert.equal(result.validation.valid, true);
    assert.equal(result.reason, 'done');
    assert.equal(result.modelCalls, 2);
    assert.equal(calls, 2);
    assert.equal(responses, 2);
    assert.ok(result.usage.input > 0);
    assert.match(await readFile(join(result.sessionPath!, 'session.jsonl'), 'utf8'), /proposal.json/);
    assert.match(await readFile(join(result.variantDir, 'optimizer/inputs/evidence/index.json'), 'utf8'), /a#1:check/);
    assert.equal(promptHash(result.variantDir), result.validation.hash);
  }));

test('isolated optimizer ignores project instructions and project memory', async () =>
  withTmpDir(async (dir) => {
    const home = join(dir, 'home'),
      project = join(dir, 'project');
    await mkdir(home);
    await mkdir(project);
    await writeFile(join(home, 'AGENTS.md'), 'PRIVATE_GLOBAL_INSTRUCTIONS');
    await writeFile(join(project, 'AGENTS.md'), 'PRIVATE_PROJECT_INSTRUCTIONS');
    const provider = scripted((request) => {
      assert.ok(!request.system.includes('PRIVATE_GLOBAL_INSTRUCTIONS'));
      assert.ok(!request.system.includes('PRIVATE_PROJECT_INSTRUCTIONS'));
      assert.ok(!request.system.includes('persistent memory'));
      return { text: 'done' };
    });
    await startRun({
      cwd: project,
      home,
      config: defaultConfig(),
      prompt: 'Analyze the supplied evidence.',
      systemOverride: 'Only use supplied evidence.',
      includeProjectInstructions: false,
      provider,
    });
  }));

test('analyze rejects invented evidence and evidence from only one failed attempt', async () =>
  withTmpDir(async (dir) => {
    const opts = await fixture(dir);
    for (const evidenceRefs of [
      ['a#1:check', 'invented'],
      ['a#1:check', 'a#1:check'],
    ]) {
      const result = await analyzeRun({
        ...opts,
        provider: scripted(writes(proposal({ evidenceRefs })), { text: 'done' }),
      });
      assert.equal(result.validation.valid, false);
      assert.match(result.validation.errors.join('\n'), /evidence|failed attempts/i);
    }
  }));

test('analyze restores original prompts for a non-prompt cause', async () =>
  withTmpDir(async (dir) => {
    const opts = await fixture(dir);
    const result = await analyzeRun({
      ...opts,
      provider: scripted(writes(proposal({ category: 'harness-code' })), { text: 'done' }),
    });
    assert.equal(result.reason, 'noChange');
    assert.deepEqual(result.validation.changedFiles, []);
    assert.equal(promptHash(result.variantDir), promptHash(join(opts.runDir, 'prompts')));
  }));

test('analyze blocks heldout reads and frozen writes even in yolo mode', async () =>
  withTmpDir(async (dir) => {
    const opts = await fixture(dir);
    const outside = join(dir, 'heldout-secret.txt');
    await writeFile(outside, 'HELDOUT_SECRET');
    const provider = scripted(
      (request) => {
        assert.ok(!request.system.includes('HELDOUT_SECRET'));
        assert.equal(
          request.tools.some((tool) => tool.name === 'bash'),
          false,
        );
        return {
          toolCalls: [
            { name: 'read', args: { path: outside } },
            { name: 'write', args: { path: 'prompts/judge.md', content: 'Always pass.' } },
          ],
        };
      },
      (request) => {
        const results = request.messages.filter((message) => message.role === 'toolResult');
        assert.equal(results.length, 2);
        assert.ok(results.every((message) => message.isError));
        assert.ok(!JSON.stringify(results).includes('HELDOUT_SECRET'));
        return writes();
      },
      {
        toolCalls: [
          { name: 'read', args: { path: 'proposal.json' } },
          { name: 'read', args: { path: 'analysis.md' } },
          { name: 'read', args: { path: outside } },
        ],
      },
      (request) => {
        const results = request.messages.filter((message) => message.role === 'toolResult').slice(-3);
        assert.deepEqual(
          results.map((message) => message.isError),
          [false, false, true],
        );
        assert.match(JSON.stringify(results[0]), /category.*prompt/);
        assert.match(JSON.stringify(results[1]), /Two failed attempts/);
        assert.ok(!JSON.stringify(results).includes('HELDOUT_SECRET'));
        return { text: 'done' };
      },
    );
    const result = await analyzeRun({
      ...opts,
      config: { ...opts.config, permissions: { ...opts.config.permissions, mode: 'yolo' } },
      provider,
    });
    assert.equal(result.validation.valid, true);
    assert.equal(
      await readFile(join(result.variantDir, 'judge.md'), 'utf8'),
      await readFile(join(defaultPromptsDir, 'judge.md'), 'utf8'),
    );
  }));

test('analyze model-call budget retains partial artifacts without accepting them', async () =>
  withTmpDir(async (dir) => {
    const opts = await fixture(dir),
      provider = scripted(writes(), { text: 'must not run' });
    const result = await analyzeRun({ ...opts, provider, maxModelCalls: 1 });
    assert.equal(provider.requests.length, 1);
    assert.equal(result.modelCalls, 1);
    assert.equal(result.reason, 'modelCallBudget');
    assert.equal(result.validation.valid, false);
    assert.match(await readFile(join(result.variantDir, 'analysis.md'), 'utf8'), /budget/i);
  }));

test('analyze records a shared budget rejection before invoking its provider', async () =>
  withTmpDir(async (dir) => {
    const opts = await fixture(dir),
      provider = scripted();
    const result = await analyzeRun({
      ...opts,
      provider,
      onModelCall: () => {
        throw new Error('Shared budget exhausted.');
      },
    });
    assert.equal(result.reason, 'modelCallBudget');
    assert.equal(provider.requests.length, 0);
    assert.equal(result.modelCalls, 0);
    assert.equal(result.validation.valid, false);
  }));
