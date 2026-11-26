import { afterEach, describe, expect, it } from 'bun:test';
import express, { type Express } from 'express';
import type { Server } from 'node:http';
import { RATE_LIMITED_ROUTES, applyRateLimits } from '../rate-limit-routes.js';
import { createRateLimiter, rateLimitEnabled, tierRule, type RateLimiterOptions } from './rate-limit.js';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
});

async function serve(app: Express): Promise<string> {
  app.set('trust proxy', 1); // tests choose the client IP with X-Forwarded-For
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  servers.push(server);
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  return `http://127.0.0.1:${addr.port}`;
}

const hit = (base: string, path: string, ip = '1.1.1.1', method = 'GET') =>
  fetch(`${base}${path}`, { method, headers: { 'x-forwarded-for': ip } });

function limited(options: RateLimiterOptions) {
  const limiter = createRateLimiter({ enabled: () => true, rule: () => ({ max: 2, windowMs: 10_000 }), ...options });
  const app = express();
  app.get('/a', limiter.limit('a', 'strict'), (_req, res) => void res.send('ok'));
  app.get('/b', limiter.limit('b', 'strict'), (_req, res) => void res.send('ok'));
  return { limiter, app };
}

describe('rate limiter', () => {
  it('answers 429 with Retry-After in the usual envelope once the limit is hit', async () => {
    const base = await serve(limited({}).app);
    expect((await hit(base, '/a')).status).toBe(200);
    expect((await hit(base, '/a')).status).toBe(200);
    const res = await hit(base, '/a');
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect(Number(res.headers.get('retry-after'))).toBeLessThanOrEqual(10);
    expect(await res.json()).toEqual({ status: 'error', data: null, message: 'Too many requests. Try again later.' });
  });

  it('starts a new window once the old one has ended', async () => {
    let clock = 1_000_000;
    const base = await serve(limited({ now: () => clock }).app);
    await hit(base, '/a');
    await hit(base, '/a');
    const blocked = await hit(base, '/a');
    expect(blocked.status).toBe(429);
    clock += 4_000;
    expect(Number((await hit(base, '/a')).headers.get('retry-after'))).toBe(6); // 10 s window, 4 s gone
    clock += 6_000;
    expect((await hit(base, '/a')).status).toBe(200);
  });

  it('keeps route groups and client IPs apart', async () => {
    const base = await serve(limited({}).app);
    await hit(base, '/a');
    await hit(base, '/a');
    expect((await hit(base, '/a')).status).toBe(429);
    expect((await hit(base, '/b')).status).toBe(200); // other group, same IP
    expect((await hit(base, '/a', '2.2.2.2')).status).toBe(200); // same group, other IP
  });

  it('cannot grow without bound: expired entries are swept and the cap holds', async () => {
    let clock = 0;
    const { limiter, app } = limited({ now: () => clock, maxKeys: 5 });
    const base = await serve(app);
    for (let i = 0; i < 20; i++) await hit(base, '/a', `10.0.0.${i}`);
    expect(limiter.size()).toBeLessThanOrEqual(5);

    clock += 11_000; // every window has ended
    await hit(base, '/a', '9.9.9.9');
    expect(limiter.size()).toBe(1);
  });

  it('does nothing unless enabled, which is the default in development and tests', async () => {
    expect(rateLimitEnabled({})).toBe(false);
    expect(rateLimitEnabled({ NODE_ENV: 'development' })).toBe(false);
    expect(rateLimitEnabled({ NODE_ENV: 'test' })).toBe(false);
    expect(rateLimitEnabled({ NODE_ENV: 'staging' })).toBe(true);
    expect(rateLimitEnabled({ NODE_ENV: 'production' })).toBe(true);
    expect(rateLimitEnabled({ NODE_ENV: 'development', RATE_LIMIT_ENABLED: '1' })).toBe(true);
    expect(rateLimitEnabled({ NODE_ENV: 'production', RATE_LIMIT_ENABLED: '0' })).toBe(false);

    // The default limiter in this test process (development, RATE_LIMIT_ENABLED unset or 0) lets everything through.
    expect(rateLimitEnabled()).toBe(false);
    const app = express();
    const limiter = createRateLimiter({ rule: () => ({ max: 1, windowMs: 10_000 }) });
    app.get('/a', limiter.limit('a', 'strict'), (_req, res) => void res.send('ok'));
    const base = await serve(app);
    for (let i = 0; i < 5; i++) expect((await hit(base, '/a')).status).toBe(200);
    expect(limiter.size()).toBe(0);
  });

  it('takes limits from the environment and falls back to defaults on bad values', () => {
    expect(tierRule('strict', {})).toEqual({ max: 20, windowMs: 900_000 });
    expect(tierRule('moderate', {})).toEqual({ max: 60, windowMs: 60_000 });
    expect(tierRule('generous', {})).toEqual({ max: 300, windowMs: 60_000 });
    expect(tierRule('strict', { RATE_LIMIT_STRICT_MAX: '5', RATE_LIMIT_STRICT_WINDOW_SECONDS: '30' })).toEqual({ max: 5, windowMs: 30_000 });
    expect(tierRule('generous', { RATE_LIMIT_GENEROUS_MAX: 'lots', RATE_LIMIT_GENEROUS_WINDOW_SECONDS: '-1' })).toEqual({ max: 300, windowMs: 60_000 });
  });
});

describe('rate-limited route table', () => {
  it('limits every listed route, one bucket per group and IP', async () => {
    const limiter = createRateLimiter({ enabled: () => true, rule: () => ({ max: 1, windowMs: 10_000 }) });
    const router = express.Router();
    applyRateLimits(router, limiter);
    for (const { method, path } of RATE_LIMITED_ROUTES) router[method](path, (_req, res) => void res.sendStatus(204));
    const app = express();
    app.use(router);
    const base = await serve(app);

    let n = 0;
    for (const { method, path } of RATE_LIMITED_ROUTES) {
      const concrete = path.replace(/:\w+/g, 'x');
      const ip = `10.1.0.${++n}`; // fresh IP per entry: groups shared by several routes do not interfere
      expect((await hit(base, concrete, ip, method.toUpperCase())).status).toBe(204);
      expect((await hit(base, concrete, ip, method.toUpperCase())).status).toBe(429);
    }
  });

  it('covers the routes the task names, and not the Better Auth routes', () => {
    const paths = RATE_LIMITED_ROUTES.map((r) => `${r.method} ${r.path}`);
    for (const wanted of [
      'post /auth/login', 'post /auth/register', 'post /auth/forgot-password', 'post /auth/reset-password',
      'post /auth/refresh', 'post /auth/admin-invites/accept', 'get /commute', 'get /search/buildings',
      'post /files/evidence', 'post /buildings/:buildingId/photos',
    ]) expect(paths).toContain(wanted);
    expect(paths.some((p) => p.includes('/api/auth'))).toBe(false);
  });
});
