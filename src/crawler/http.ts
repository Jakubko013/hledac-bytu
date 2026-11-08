import type { FetchFn } from './types';

export interface HttpOptions {
  delayMs: number;
  retries: number;
  userAgent: string;
  timeoutMs?: number;
  /** Base for exponential backoff; defaults to 1000 ms. */
  backoffMs?: number;
}

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'HttpError';
  }
}

const RETRY_STATUS = (s: number) => s === 429 || s >= 500;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal!.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function retryAfterMs(res: Response): number | undefined {
  const h = res.headers.get('retry-after');
  if (!h) return undefined;
  const secs = Number(h);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(h);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/**
 * Throttled fetch: requests are serialized with at least `delayMs` between starts,
 * retried with exponential backoff on 429/5xx/network errors, with a per-attempt timeout.
 * Non-retryable responses (e.g. 404) are returned as-is; exhausted retries on 429/5xx throw HttpError.
 */
export function createHttp(opts: HttpOptions): FetchFn {
  const { delayMs, retries, userAgent, timeoutMs = 20_000, backoffMs = 1000 } = opts;
  let queue: Promise<unknown> = Promise.resolve();
  let lastStart = 0;

  const throttle = async (signal?: AbortSignal) => {
    const wait = lastStart + delayMs - Date.now();
    if (wait > 0) await sleep(wait, signal);
    lastStart = Date.now();
  };

  const attemptOnce = async (url: string | URL, init: RequestInit | undefined, signal?: AbortSignal) => {
    const headers = new Headers(init?.headers);
    if (!headers.has('user-agent')) headers.set('user-agent', userAgent);
    const timeout = AbortSignal.timeout(timeoutMs);
    const callerSignal = init?.signal ?? undefined;
    const signals = [timeout, signal, callerSignal].filter((s): s is AbortSignal => !!s);
    return fetch(url, { ...init, headers, signal: AbortSignal.any(signals) });
  };

  const run = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const signal = init?.signal ?? undefined;
    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      signal?.throwIfAborted();
      await throttle(signal);
      let wait = backoffMs * 2 ** attempt;
      try {
        const res = await attemptOnce(url, init, signal);
        if (!RETRY_STATUS(res.status)) return res;
        lastError = new HttpError(`HTTP ${res.status} for ${String(url)}`, res.status);
        wait = Math.max(wait, retryAfterMs(res) ?? 0);
        await res.body?.cancel().catch(() => undefined);
      } catch (err) {
        if (signal?.aborted) throw err;
        lastError = err;
      }
      if (attempt < retries) await sleep(wait, signal);
    }
    if (lastError instanceof HttpError) throw lastError;
    throw new HttpError(`Request failed after ${retries + 1} attempts: ${String(url)}`, undefined, { cause: lastError });
  };

  return (url, init) => {
    const p = queue.then(() => run(url, init));
    queue = p.catch(() => undefined);
    return p;
  };
}
