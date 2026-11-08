export function isContextOverflow(message = ''): boolean {
  return /prompt is too long|context_length_exceeded|maximum context length|\[context_overflow\]/i.test(message);
}
export function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return isContextOverflow(text) && !text.startsWith('[context_overflow]') ? '[context_overflow] ' + text : text;
}
export class HTTPError extends Error {
  status: number;
  retryAfter?: string;
  constructor(status: number, body: string, retryAfter?: string) {
    super(`HTTP ${status}: ${body.slice(0, 1500)}`);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}
