import { parseArgs } from 'node:util';
export function parseCLI(args: string[]) {
  const result = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean' },
      print: { type: 'boolean', short: 'p' },
      json: { type: 'boolean' },
      continue: { type: 'boolean', short: 'c' },
      resume: { type: 'string', short: 'r' },
      provider: { type: 'string' },
      model: { type: 'string' },
      thinking: { type: 'string' },
      prompts: { type: 'string' },
      yolo: { type: 'boolean' },
      'trust-project': { type: 'boolean' },
      'max-turns': { type: 'string' },
      'hide-thinking': { type: 'boolean' },
      cwd: { type: 'string' },
      sessions: { type: 'string' },
      'dry-run': { type: 'boolean' },
      check: { type: 'string' },
      'max-iter': { type: 'string' },
      tasks: { type: 'string' },
      split: { type: 'string' },
      repeat: { type: 'string' },
      variant: { type: 'string' },
      concurrency: { type: 'string' },
      output: { type: 'string' },
      rounds: { type: 'string' },
      candidates: { type: 'string' },
      targets: { type: 'string' },
      'max-calls': { type: 'string' },
      'max-tokens': { type: 'string' },
      timeout: { type: 'string' },
      'optimizer-model': { type: 'string' },
      'optimizer-provider': { type: 'string' },
    },
  });
  for (const key of [
    'max-turns',
    'sessions',
    'max-iter',
    'repeat',
    'concurrency',
    'rounds',
    'candidates',
    'max-calls',
    'max-tokens',
    'timeout',
  ] as const) {
    const raw = result.values[key];
    if (raw !== undefined && (!/^\d+$/.test(raw) || Number(raw) < 1))
      throw new Error(`--${key} must be a positive integer`);
  }
  if (result.values.provider && !['anthropic', 'openai'].includes(result.values.provider))
    throw new Error('--provider must be anthropic or openai');
  if (result.values['optimizer-provider'] && !['anthropic', 'openai'].includes(result.values['optimizer-provider']))
    throw new Error('--optimizer-provider must be anthropic or openai');
  if (result.values.thinking && !['off', 'low', 'medium', 'high'].includes(result.values.thinking))
    throw new Error('--thinking must be off, low, medium, high');
  if (result.values.split && !['dev', 'heldout', 'all'].includes(result.values.split))
    throw new Error('--split must be dev, heldout, all');
  return result;
}
export const help = `mini-harness 0.1.0
Usage: mh [prompt] | mh -p "prompt" [--json]
  -c, --continue           Resume the latest session
  -r, --resume <id>        Resume a session
  --provider <id>          anthropic | openai
  --model <id>             Model identifier
  --thinking <level>       off | low | medium | high
  --prompts <dir>          Override prompt directory
  --max-turns <n>          Run budget (default 50)
  --cwd <dir>              Working directory
  --yolo                   Allow all ordinary tool actions
  --trust-project          Trust project hook commands
  --hide-thinking          Hide thinking text in interactive output
  --json                   JSONL events / JSON command output
  --help, --version
Commands: sessions | trace [id] | memory [show|path|undo]
          dream [--sessions N] [--dry-run]
          ralph "prompt" --check "cmd" [--max-iter N]
          eval run [--tasks glob] [--split dev|heldout|all] [--repeat N]
                   [--variant dir] [--concurrency N] [--output dir]
          eval compare <runA> <runB> | analyze <run>
          evolve [--rounds N] [--candidates N] [--targets system.md,tools/edit.md]
                 [--repeat N] [--max-calls N] [--max-tokens N] [--timeout seconds]
                 [--optimizer-model id] [--optimizer-provider id] [--output dir]
Evolve preserves default prompts; search/selection use dev, then heldout is audited once.
Windows shell: Git Bash → pwsh → powershell. The bash tool reports active syntax.
Permissions are accident-prevention guardrails, not a security boundary (不是安全边界).
For unattended work use a container or another OS-level sandbox.
`;
