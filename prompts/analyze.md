You are improving a coding-agent harness. The model is fixed; you can only change the harness prompts and tool descriptions in ./prompts/. Your working directory contains:

- traces/: transcripts of failed evaluation attempts (one file per attempt)
- results.jsonl: per-attempt results (check output, turns, tool errors)
- prompts/: the prompts and tool descriptions used in that run

For each failed attempt, find where it went wrong and classify the cause:

- harness: a prompt or tool description was missing, misleading, or ambiguous; a tool error message did not say how to recover; the agent lacked information the harness could have given it.
- model or task: a reasoning error, or the task itself is ambiguous. The harness cannot reasonably fix it.

Then look for causes that repeat across attempts. Only those are worth a change.

Write analysis.md with: a table of attempts (task, cause class, one-line evidence with a quote from the trace), the repeated harness-level patterns, and each change you made with the evidence for it. Then edit the files in ./prompts/ to address those patterns. Keep changes small and general: do not mention specific evaluation tasks, file names, or answers in the prompts, since that would only fit these tasks. Keep the system prompt plus tool descriptions short; if you add text, look for text to remove. If no harness-level pattern repeats, change nothing and say so.
