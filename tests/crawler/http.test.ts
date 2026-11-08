import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHttp, HttpError } from '../../src/crawler/http';

const opts = { delayMs: 0, retries: 2, userAgent: 'test-ua', backoffMs: 1 };
const mock = () => vi.spyOn(globalThis, 'fetch');

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('createHttp', () => {
  it('sends the user agent and returns ok responses', async () => {
    const f = mock().mockResolvedValue(new Response('ok'));
    const res = await createHttp(opts)('https://x.test/');
    expect(await res.text()).toBe('ok');
    expect(new Headers((f.mock.calls[0]![1] as RequestInit).headers).get('user-agent')).toBe('test-ua');
  });
  it('retries on 429/5xx and network errors, then succeeds', async () => {
    const f = mock()
      .mockResolvedValueOnce(new Response('', { status: 429 }))
      .mockRejectedValueOnce(new TypeError('network'))
      .mockResolvedValueOnce(new Response('done'));
    const res = await createHttp(opts)('https://x.test/');
    expect(await res.text()).toBe('done');
    expect(f).toHaveBeenCalledTimes(3);
  });
  it('throws HttpError after exhausting retries', async () => {
    const f = mock().mockImplementation(async () => new Response('', { status: 503 }));
    await expect(createHttp(opts)('https://x.test/')).rejects.toMatchObject({ name: 'HttpError', status: 503 });
    expect(f).toHaveBeenCalledTimes(3);
  });
  it('wraps persistent network errors', async () => {
    mock().mockRejectedValue(new TypeError('network'));
    await expect(createHttp({ ...opts, retries: 1 })('https://x.test/')).rejects.toBeInstanceOf(HttpError);
  });
  it('does not retry 404', async () => {
    const f = mock().mockResolvedValue(new Response('', { status: 404 }));
    const res = await createHttp(opts)('https://x.test/');
    expect(res.status).toBe(404);
    expect(f).toHaveBeenCalledTimes(1);
  });
  it('throttles consecutive requests', async () => {
    vi.useFakeTimers();
    try {
      const f = mock().mockImplementation(async () => new Response('ok'));
      const http = createHttp({ ...opts, delayMs: 50 });
      const all = Promise.all([http('https://x.test/1'), http('https://x.test/2')]);
      await vi.advanceTimersByTimeAsync(0);
      expect(f).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(49);
      expect(f).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(f).toHaveBeenCalledTimes(2);
      await all;
    } finally {
      vi.useRealTimers();
    }
  });
  it('rejects when the signal is aborted', async () => {
    const f = mock().mockResolvedValue(new Response('ok'));
    const ac = new AbortController();
    ac.abort(new Error('stop'));
    await expect(createHttp(opts)('https://x.test/', { signal: ac.signal })).rejects.toThrow('stop');
    expect(f).not.toHaveBeenCalled();
  });
  it('times out a hanging request', async () => {
    mock().mockImplementation((_u, init) => new Promise((_r, rej) => {
      (init as RequestInit).signal!.addEventListener('abort', () => rej(new Error('aborted')));
    }));
    await expect(createHttp({ ...opts, retries: 0, timeoutMs: 20 })('https://x.test/')).rejects.toBeInstanceOf(HttpError);
  });
});
