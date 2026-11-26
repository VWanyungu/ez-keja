import { afterEach, describe, expect, it } from 'bun:test';
import { clearRefreshCookie, refreshCookie } from './refresh-cookie.js';

const original = process.env.NODE_ENV;
afterEach(() => {
  process.env.NODE_ENV = original;
});

const future = new Date(Date.now() + 3600_000);

describe('refresh cookie Secure flag', () => {
  it('is set only when NODE_ENV=production', () => {
    process.env.NODE_ENV = 'production';
    expect(refreshCookie('t', future)).toContain('; Secure');
    expect(clearRefreshCookie()).toContain('; Secure');

    for (const env of ['development', 'staging', 'test']) {
      process.env.NODE_ENV = env;
      expect(refreshCookie('t', future)).not.toContain('Secure');
    }
  });

  it('is always HttpOnly, SameSite=Lax and scoped to /auth', () => {
    process.env.NODE_ENV = 'production';
    const cookie = refreshCookie('t', future);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/auth');
  });
});
