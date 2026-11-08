export function systemCacheBoundary(system: string): number {
  const boundaries = ['\n\n# Memory\n', '\n\n# Environment\n']
    .map((marker) => system.lastIndexOf(marker))
    .filter((i) => i >= 0);
  return Math.min(system.length, ...boundaries);
}
export function assembleSystemPrompt(opts: {
  base: string;
  instructions: { path: string; content: string }[];
  memory?: string;
  env: { cwd: string; platform: string; date: string; shell: string; git?: string };
}): string {
  return [
    opts.base.trim(),
    ...(opts.instructions.length
      ? [
          '# Project instructions\n' +
            opts.instructions.map((i) => `<!-- from: ${i.path} -->\n${i.content}`).join('\n\n'),
        ]
      : []),
    ...(opts.memory ? ['# Memory\n' + opts.memory] : []),
    `# Environment\ncwd: ${opts.env.cwd}\nplatform: ${opts.env.platform}\ndate: ${opts.env.date.slice(0, 10)}\nshell: ${opts.env.shell}\ngit: ${opts.env.git ?? 'not a repository'}\n`,
  ].join('\n\n');
}
