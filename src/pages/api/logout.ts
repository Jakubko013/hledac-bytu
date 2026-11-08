import type { APIRoute } from 'astro';
import { isSecureRequest, SESSION_COOKIE, sessionCookieOptions } from '../../lib/auth';

export const prerender = false;

export const POST: APIRoute = ({ cookies, url }) => {
  cookies.set(SESSION_COOKIE, '', sessionCookieOptions(isSecureRequest(url), 0));
  return new Response(null, { status: 303, headers: { Location: '/login' } });
};
