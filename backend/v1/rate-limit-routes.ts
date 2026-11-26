import type { Router } from 'express';
import { createRateLimiter, type RateLimiter, type Tier } from './middlewares/rate-limit.js';

interface LimitedRoute {
  method: 'get' | 'post';
  path: string;
  group: string;
  tier: Tier;
}

// Paths are as seen by the v1 router. Better Auth's own /api/auth/* routes keep Better Auth's limiter.
// Each strict route has its own group so a burst of token refreshes never uses up login attempts.
export const RATE_LIMITED_ROUTES: LimitedRoute[] = [
  { method: 'post', path: '/auth/login', group: 'auth-login', tier: 'strict' },
  { method: 'post', path: '/auth/register', group: 'auth-register', tier: 'strict' },
  { method: 'post', path: '/auth/forgot-password', group: 'auth-forgot-password', tier: 'strict' },
  { method: 'post', path: '/auth/reset-password', group: 'auth-reset-password', tier: 'strict' },
  { method: 'post', path: '/auth/refresh', group: 'auth-refresh', tier: 'strict' },
  { method: 'post', path: '/auth/admin-invites/accept', group: 'auth-invite', tier: 'strict' },
  { method: 'get', path: '/auth/admin-invites/:token', group: 'auth-invite', tier: 'strict' },

  { method: 'post', path: '/buildings/:buildingId/contact-events', group: 'contact-events', tier: 'moderate' },
  { method: 'get', path: '/commute', group: 'commute', tier: 'moderate' },
  { method: 'post', path: '/buildings/:buildingId/photos', group: 'uploads', tier: 'moderate' },
  { method: 'post', path: '/space-types/:spaceTypeId/photos', group: 'uploads', tier: 'moderate' },
  { method: 'post', path: '/files/evidence', group: 'uploads', tier: 'moderate' },

  { method: 'get', path: '/search/buildings', group: 'search', tier: 'generous' },
  { method: 'get', path: '/buildings/:buildingId/public', group: 'public-pages', tier: 'generous' },
  { method: 'get', path: '/space-types/:spaceTypeId/public', group: 'public-pages', tier: 'generous' },
  { method: 'get', path: '/listers/:userId', group: 'public-pages', tier: 'generous' },
];

export function applyRateLimits(router: Router, limiter: RateLimiter = createRateLimiter()): void {
  for (const { method, path, group, tier } of RATE_LIMITED_ROUTES) {
    router[method](path, limiter.limit(group, tier));
  }
}
