import { isStrictEnv, parseCorsOrigins, parseTrustProxy, type Env } from './http-config.js';

const filled = (env: Env, name: string): boolean => (env[name] ?? '').trim() !== '';

/**
 * Problems with the environment of a staging or production process, as variable NAMES only: a
 * value (a password, a key) must never reach a log line. Development is permissive and returns [].
 * `GOOGLE_MAPS_API_KEY` is optional on purpose: the commute endpoint is fail-soft without it.
 */
export function findEnvProblems(env: Env = process.env): string[] {
  if (!isStrictEnv(env)) return [];

  const production = env.NODE_ENV === 'production';
  const dbPrefix = production ? 'PROD_' : 'STAGING_';
  const problems: string[] = [];
  const need = (...names: string[]) => {
    for (const name of names) if (!filled(env, name)) problems.push(name);
  };

  need(...['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME'].map((name) => `${dbPrefix}${name}`));
  // lib/auth-secret.ts throws in production only; staging would silently use its built-in default.
  if (!filled(env, 'BETTER_AUTH_SECRET') && !filled(env, 'AUTH_SECRET')) problems.push('BETTER_AUTH_SECRET (or AUTH_SECRET)');
  need('FRONTEND_URL', 'BETTER_AUTH_URL');
  need(...(production ? ['USESENDY_API_KEY', 'MAIL_FROM'] : ['GMAIL_USER', 'GMAIL_APP_PASSWORD']));
  need('CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET');

  const origins = parseCorsOrigins(env.CORS_ORIGIN);
  if (origins.length === 0) problems.push('CORS_ORIGIN');
  else if (origins.some((origin) => origin.includes('*'))) problems.push('CORS_ORIGIN (explicit origins only, no "*")');

  try {
    parseTrustProxy(env.TRUST_PROXY);
  } catch {
    problems.push('TRUST_PROXY (a hop count, "loopback" or a CIDR list, not "true")');
  }

  return problems;
}

/** Call once at boot, before anything connects. Throws an error that lists names, never values. */
export function validateEnv(env: Env = process.env): void {
  const problems = findEnvProblems(env);
  if (problems.length > 0) {
    throw new Error(`Invalid ${env.NODE_ENV} configuration. Missing or invalid: ${problems.join(', ')}`);
  }
}
