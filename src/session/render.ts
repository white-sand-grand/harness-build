import type { Message } from '../ai/index.ts';
import type { SessionEntry } from './types.ts';
export function renderMessages(messages: Message[]): string {
  return messages
    .map(
      (m) =>
        `## ${m.role}\n` +
        m.content
          .map((b) =>
            b.type === 'text'
              ? m.role === 'toolResult'
                ? b.text.slice(0, 500)
                : b.text
              : b.type === 'thinking'
                ? `[thinking] ${b.text}`
                : b.type === 'toolCall'
                  ? `→ ${b.name}(${JSON.stringify(b.args).slice(0, 500)})`
                  : '[image]',
          )
          .join('\n') +
        (m.role === 'assistant' && m.errorMessage ? '\n[model error] ' + m.errorMessage : ''),
    )
    .join('\n\n');
}
export function renderSession(entries: SessionEntry[]): string {
  return renderMessages(entries.filter((e) => e.type === 'message').map((e) => e.message));
}
