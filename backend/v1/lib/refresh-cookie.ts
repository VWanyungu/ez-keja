import type { IncomingHttpHeaders } from 'node:http';

export const REFRESH_COOKIE_NAME = 'khunt_refresh';

// Only /auth/* routes (refresh, logout) ever need the refresh token, so scope it there.
// shortcut: SameSite=Lax assumes the frontend and API share a registrable domain; a cross-site
// deployment needs SameSite=None (which requires Secure) plus a CSRF check beyond the api-v header.
const PATH = '/auth';

function baseAttributes(): string {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `Path=${PATH}; HttpOnly; SameSite=Lax${secure}`;
}

export function refreshCookie(token: string, expiresAt: Date): string {
  const maxAge = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
  return `${REFRESH_COOKIE_NAME}=${token}; ${baseAttributes()}; Max-Age=${maxAge}`;
}

export function clearRefreshCookie(): string {
  return `${REFRESH_COOKIE_NAME}=; ${baseAttributes()}; Max-Age=0`;
}

export function readRefreshCookie(headers: IncomingHttpHeaders): string | null {
  const raw = headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === REFRESH_COOKIE_NAME) return rest.join('=') || null;
  }
  return null;
}
