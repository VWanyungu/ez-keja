// Matches Better Auth's secret resolution order so JWTs and session cookies share one config.
export function getAuthSecret(): string {
  const secret = process.env.BETTER_AUTH_SECRET || process.env.AUTH_SECRET;
  if (secret) return secret;

  if (process.env.NODE_ENV === 'production') {
    throw new Error('BETTER_AUTH_SECRET (or AUTH_SECRET) must be set in production.');
  }

  return 'better-auth-secret-123456789';
}
