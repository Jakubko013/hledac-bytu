import type { APIRoute } from 'astro';
import { z } from 'zod';
import {
  AuthConfigError,
  authenticate,
  createSessionToken,
  isSecureRequest,
  loadAuthConfig,
  sanitizeNext,
  SESSION_COOKIE,
  sessionCookieOptions,
} from '../../lib/auth';
import { createDbRateLimiter } from '../../lib/rate-limit';

export const prerender = false;

const USER_MAX_FAILURES = 10;

const LoginForm = z.object({
  username: z.string().min(1).max(100),
  password: z.string().min(1).max(1024),
  next: z.string().max(2048).optional(),
});

function loginRedirect(error: 'error' | 'rate', next: string | undefined): Response {
  const qs = new URLSearchParams(error === 'rate' ? { error: 'rate' } : { error: '1' });
  const safe = sanitizeNext(next, '');
  if (safe) qs.set('next', safe);
  return new Response(null, { status: 303, headers: { Location: `/login?${qs}` } });
}

export const POST: APIRoute = async ({ request, cookies, url, clientAddress }) => {
  let config: ReturnType<typeof loadAuthConfig>;
  try {
    config = loadAuthConfig();
  } catch (err) {
    if (err instanceof AuthConfigError) {
      console.error(`Auth misconfigured: ${err.message}`);
      return new Response('Server misconfigured', { status: 500 });
    }
    throw err;
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return loginRedirect('error', undefined);
  }
  const rawNext = form.get('next');
  const nextParam = typeof rawNext === 'string' ? rawNext : undefined;
  const parsed = LoginForm.safeParse({
    username: form.get('username'),
    password: form.get('password'),
    next: nextParam,
  });
  if (!parsed.success) return loginRedirect('error', nextParam);
  const { username, password, next } = parsed.data;

  const limiter = createDbRateLimiter();
  const ip = clientAddress || 'unknown';
  const userKey = `user:${username.toLowerCase()}`;
  if ((await limiter.isLimited(ip)) || (await limiter.isLimited(userKey, USER_MAX_FAILURES))) {
    return loginRedirect('rate', next);
  }

  const user = authenticate(config.users, username, password);
  if (!user) {
    await limiter.recordFailure(ip);
    await limiter.recordFailure(userKey);
    return loginRedirect('error', next);
  }

  cookies.set(
    SESSION_COOKIE,
    createSessionToken(user, config.secret),
    sessionCookieOptions(isSecureRequest(url)),
  );
  return new Response(null, { status: 303, headers: { Location: sanitizeNext(next) } });
};
