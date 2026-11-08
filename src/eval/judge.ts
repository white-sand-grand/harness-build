import type { Provider, ModelInfo, Usage, CacheInfo } from '../ai/index.ts';
import { renderTemplate } from '../util/template.ts';
export type JudgeVerdict = { score: number; pass: boolean; reason: string } | { error: string };
export function parseJudge(text: string): JudgeVerdict {
  const start = text.indexOf('{');
  if (start < 0) return { error: 'Judge reply did not contain a JSON object.' };
  let depth = 0,
    quoted = false,
    escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quoted = false;
      continue;
    }
    if (c === '"') {
      quoted = true;
      continue;
    }
    if (c === '{') depth++;
    if (c === '}' && --depth === 0) {
      try {
        const v = JSON.parse(text.slice(start, i + 1)) as { score: unknown; pass: unknown; reason: unknown };
        if (
          typeof v.score !== 'number' ||
          !Number.isFinite(v.score) ||
          v.score < 0 ||
          v.score > 1 ||
          typeof v.pass !== 'boolean' ||
          typeof v.reason !== 'string'
        )
          return { error: 'Judge JSON must contain score in [0,1], boolean pass and string reason.' };
        return { score: v.score, pass: v.pass, reason: v.reason };
      } catch {
        return { error: 'Judge reply contained malformed JSON.' };
      }
    }
  }
  return { error: 'Judge JSON object was incomplete.' };
}
export async function runJudge(opts: {
  provider: Provider;
  model: ModelInfo;
  template: string;
  prompt: string;
  rubric: string;
  diff: string;
  finalText: string;
  signal: AbortSignal;
}): Promise<{ verdict: JudgeVerdict; usage: Usage; cache?: CacheInfo }> {
  const system = renderTemplate(opts.template, {
    prompt: opts.prompt,
    rubric: opts.rubric,
    diff: opts.diff.slice(0, 20000),
    finalText: opts.finalText.slice(0, 20000),
  });
  const out = await opts.provider.stream(
    {
      model: opts.model,
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Grade the result above using the rubric.' }] }],
      tools: [],
      thinking: 'off',
      maxOutputTokens: Math.min(2048, opts.model.maxOutputTokens),
    },
    opts.signal,
    () => {},
  );
  return {
    verdict:
      out.stopReason === 'error' || out.stopReason === 'aborted'
        ? { error: out.errorMessage ?? 'Judge interrupted' }
        : parseJudge(
            out.content
              .filter((b) => b.type === 'text')
              .map((b) => b.text)
              .join(''),
          ),
    usage: out.usage,
    ...(out.cache ? { cache: out.cache } : {}),
  };
}
