import { HTTPError } from './errors.ts';
export type Sleep = (ms: number, signal: AbortSignal) => Promise<void>;
export const sleep: Sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { signal: AbortSignal; sleep?: Sleep; started?: () => boolean },
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    opts.signal.throwIfAborted();
    try {
      return await fn();
    } catch (error) {
      const retryable =
        error instanceof HTTPError ? [429, 500, 502, 503, 504, 529].includes(error.status) : error instanceof TypeError;
      if (opts.signal.aborted || opts.started?.() || !retryable || attempt >= 3) throw error;
      const raw = error instanceof HTTPError ? error.retryAfter : undefined;
      const seconds = raw
        ? /^\d+(?:\.\d+)?$/.test(raw)
          ? Number(raw)
          : Math.max(0, (Date.parse(raw) - Date.now()) / 1000)
        : undefined;
      const ms =
        seconds !== undefined && Number.isFinite(seconds)
          ? Math.min(60, seconds) * 1000
          : 1000 * 2 ** attempt + Math.random() * 200;
      await (opts.sleep ?? sleep)(ms, opts.signal);
    }
  }
}
