import type { RequestHandler } from 'express';
import { isStrictEnv, type Env } from '../lib/http-config.js';
import { error } from '../lib/respond.js';

export type Tier = 'strict' | 'moderate' | 'generous';

export interface Rule {
  max: number;
  windowMs: number;
}

const DEFAULT_RULES: Record<Tier, Rule> = {
  strict: { max: 20, windowMs: 15 * 60_000 },
  moderate: { max: 60, windowMs: 60_000 },
  generous: { max: 300, windowMs: 60_000 },
};

const positiveInt = (raw: string | undefined): number | undefined => {
  const n = Number(raw);
  return raw !== undefined && Number.isInteger(n) && n > 0 ? n : undefined;
};

/** Limit of a tier: RATE_LIMIT_<TIER>_MAX requests per RATE_LIMIT_<TIER>_WINDOW_SECONDS, else the default. */
export function tierRule(tier: Tier, env: Env = process.env): Rule {
  const raw = {
    strict: [env.RATE_LIMIT_STRICT_MAX, env.RATE_LIMIT_STRICT_WINDOW_SECONDS],
    moderate: [env.RATE_LIMIT_MODERATE_MAX, env.RATE_LIMIT_MODERATE_WINDOW_SECONDS],
    generous: [env.RATE_LIMIT_GENEROUS_MAX, env.RATE_LIMIT_GENEROUS_WINDOW_SECONDS],
  }[tier];
  const windowSeconds = positiveInt(raw[1]);
  return {
    max: positiveInt(raw[0]) ?? DEFAULT_RULES[tier].max,
    windowMs: windowSeconds !== undefined ? windowSeconds * 1000 : DEFAULT_RULES[tier].windowMs,
  };
}

/**
 * Off in development and tests (their suites call login dozens of times from one IP), on in staging
 * and production. RATE_LIMIT_ENABLED=1 or 0 overrides either way.
 */
export function rateLimitEnabled(env: Env = process.env): boolean {
  const flag = env.RATE_LIMIT_ENABLED?.trim().toLowerCase();
  if (flag === '1' || flag === 'true') return true;
  if (flag === '0' || flag === 'false') return false;
  return isStrictEnv(env);
}

export interface RateLimiterOptions {
  enabled?: () => boolean;
  rule?: (tier: Tier) => Rule;
  now?: () => number;
  /** Upper bound on tracked (group, IP) pairs. */
  maxKeys?: number;
}

interface Entry {
  count: number;
  resetAt: number;
}

const SWEEP_EVERY_MS = 60_000;

/**
 * Fixed-window limiter keyed by route group and client IP (`req.ip`, so set TRUST_PROXY behind a proxy).
 * shortcut: the counters live in this process's memory. With PM2 cluster mode the effective limit is
 * limit x instances, and a restart resets every counter; upgrade path is a shared store (Redis, or a
 * Postgres table) behind the same middleware. Fixed windows allow up to 2x the limit across a window edge.
 * The map cannot grow without bound: expired entries are swept every minute and whenever the map is
 * full, and past `maxKeys` the oldest entry is dropped.
 */
export function createRateLimiter(options: RateLimiterOptions = {}) {
  const enabled = options.enabled ?? (() => rateLimitEnabled());
  const rule = options.rule ?? ((tier: Tier) => tierRule(tier));
  const now = options.now ?? Date.now;
  const maxKeys = options.maxKeys ?? 10_000;
  const hits = new Map<string, Entry>();
  let nextSweepAt = 0;

  function sweep(at: number): void {
    for (const [key, entry] of hits) if (entry.resetAt <= at) hits.delete(key);
    nextSweepAt = at + SWEEP_EVERY_MS;
  }

  function limit(group: string, tier: Tier): RequestHandler {
    return (req, res, next) => {
      if (!enabled()) {
        next();
        return;
      }
      const at = now();
      const key = `${group}|${req.ip ?? 'unknown'}`;
      if (at >= nextSweepAt || hits.size >= maxKeys) sweep(at);

      let entry = hits.get(key);
      if (!entry || entry.resetAt <= at) {
        while (hits.size >= maxKeys) hits.delete(hits.keys().next().value as string);
        entry = { count: 0, resetAt: at + rule(tier).windowMs };
        hits.set(key, entry);
      }
      entry.count += 1;

      if (entry.count > rule(tier).max) {
        res.setHeader('Retry-After', String(Math.max(1, Math.ceil((entry.resetAt - at) / 1000))));
        error(res, 429, 'Too many requests. Try again later.');
        return;
      }
      next();
    };
  }

  return { limit, size: () => hits.size, clear: () => hits.clear() };
}

export type RateLimiter = ReturnType<typeof createRateLimiter>;
