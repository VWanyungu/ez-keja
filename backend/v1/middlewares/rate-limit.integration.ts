import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Server } from 'node:http';
import { createApp } from '../../app.js';
import { closeDb } from '../db/knex.js';
import { closeAuthPool } from '../lib/auth.js';

// The rate limiter on the real app: the wiring in v1/index.ts, the env-driven limits and TRUST_PROXY.
// The limiter is off in tests; this file turns it on, with tiny limits, and restores the environment.

const saved: Record<string, string | undefined> = {};
const setEnv = (values: Record<string, string | undefined>) => {
  for (const [key, value] of Object.entries(values)) {
    if (!(key in saved)) saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
};

let server: Server;
let base: string;

beforeAll(async () => {
  setEnv({ RATE_LIMIT_ENABLED: '1', RATE_LIMIT_STRICT_MAX: '2', RATE_LIMIT_STRICT_WINDOW_SECONDS: '60', TRUST_PROXY: undefined });
  server = await new Promise<Server>((resolve) => {
    const s = createApp().listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  base = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  await closeAuthPool();
  await closeDb();
});

const login = (forwardedFor?: string) =>
  fetch(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'api-v': 'v1', 'content-type': 'application/json', ...(forwardedFor ? { 'x-forwarded-for': forwardedFor } : {}) },
    body: JSON.stringify({ email: 'nobody@example.com', password: 'wrong-password' }),
  });

describe('rate limiting on the real app', () => {
  it('lets login through until the strict limit, then answers 429 with Retry-After in the envelope', async () => {
    const first = await login();
    const second = await login();
    expect(first.status).not.toBe(429);
    expect(second.status).not.toBe(429);
    const blocked = await login();
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect(await blocked.json()).toEqual({ status: 'error', data: null, message: 'Too many requests. Try again later.' });
  });

  it('keeps the other route groups, /health and unlimited routes unaffected', async () => {
    const refresh = await fetch(`${base}/auth/refresh`, { method: 'POST', headers: { 'api-v': 'v1' } });
    expect(refresh.status).not.toBe(429); // its own group: login attempts do not use it up
    for (let i = 0; i < 5; i++) expect((await fetch(`${base}/health?check=live`)).status).toBe(200);
  });

  it('ignores X-Forwarded-For unless TRUST_PROXY is set (a client cannot pick its own bucket)', async () => {
    // Same socket address, different spoofed headers: still the already-exhausted login bucket.
    expect((await login('203.0.113.7')).status).toBe(429);
    expect((await login('203.0.113.8')).status).toBe(429);
  });

  it('uses the forwarded client address when TRUST_PROXY=1', async () => {
    setEnv({ TRUST_PROXY: '1' });
    const behindProxy = await new Promise<Server>((resolve) => {
      const s = createApp().listen(0, '127.0.0.1', () => resolve(s));
    });
    try {
      const addr = behindProxy.address();
      if (!addr || typeof addr === 'string') throw new Error('no port');
      const call = (ip: string) =>
        fetch(`http://127.0.0.1:${addr.port}/auth/login`, {
          method: 'POST',
          headers: { 'api-v': 'v1', 'content-type': 'application/json', 'x-forwarded-for': ip },
          body: JSON.stringify({ email: 'nobody@example.com', password: 'wrong-password' }),
        });
      // The shared limiter already holds the real socket address's bucket; fresh forwarded addresses get their own.
      expect((await call('198.51.100.1')).status).not.toBe(429);
      expect((await call('198.51.100.2')).status).not.toBe(429);
    } finally {
      await new Promise<void>((resolve) => behindProxy.close(() => resolve()));
      setEnv({ TRUST_PROXY: undefined });
    }
  });
});
