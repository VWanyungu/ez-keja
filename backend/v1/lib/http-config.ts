export type Env = Record<string, string | undefined>;

export const isStrictEnv = (env: Env = process.env): boolean =>
  env.NODE_ENV === 'staging' || env.NODE_ENV === 'production';

export function parseCorsOrigins(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

/**
 * CORS allow-list. Development keeps the permissive behaviour (unset or `*` reflects any origin);
 * staging and production refuse anything but an explicit list, because credentials are enabled and
 * a reflected origin would let any website call the API with the user's cookie.
 */
export function resolveCorsOrigin(env: Env = process.env): boolean | string[] {
  const origins = parseCorsOrigins(env.CORS_ORIGIN);
  if (isStrictEnv(env)) {
    if (origins.length === 0 || origins.some((origin) => origin.includes('*'))) {
      throw new Error('CORS_ORIGIN must be an explicit comma-separated list of origins (no "*") in staging and production.');
    }
    return origins;
  }
  if (origins.length === 0 || env.CORS_ORIGIN?.trim() === '*') return true;
  return origins;
}

/**
 * Express `trust proxy` setting from TRUST_PROXY. Off by default: trusting X-Forwarded-For without a
 * proxy in front lets any client pick its own IP (and so dodge the rate limiter).
 * A number is the count of proxy hops (1 for nginx in front of the app); anything else is passed to
 * Express as is ("loopback", a CIDR list). `true` is refused because it trusts every hop.
 */
export function parseTrustProxy(raw: string | undefined): boolean | number | string {
  const value = raw?.trim() ?? '';
  if (value === '' || value === 'false' || value === '0') return false;
  if (value === 'true') {
    throw new Error('TRUST_PROXY=true trusts every client-supplied hop; use a hop count, "loopback" or a CIDR list.');
  }
  return /^\d+$/.test(value) ? Number(value) : value;
}
