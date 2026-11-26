/** Mail provider credentials. A suite that runs with these set can send real e-mail (and time out doing it). */
export const MAIL_ENV_VARS = ['GMAIL_USER', 'GMAIL_APP_PASSWORD', 'USESENDY_API_KEY'] as const;

export type TestEnv = Record<string, string | undefined>;

/** `INTEGRATION_SEND_MAIL=1` is the one deliberate way to let a test run send real mail. */
export const sendsRealMail = (env: TestEnv): boolean => env.INTEGRATION_SEND_MAIL === '1';

/**
 * Environment for a test child process: mail keys blanked (set to '' rather than deleted, because
 * dotenv and Bun's .env loading only fill variables that are missing, never ones that are set but empty),
 * development mode, and the rate limiter off. Overrides win, e.g. `{ DB_NAME: throwawayDb }`.
 */
export function testEnv(base: TestEnv, overrides: TestEnv = {}): TestEnv {
  const env: TestEnv = { ...base, NODE_ENV: 'development', RATE_LIMIT_ENABLED: '0' };
  if (!sendsRealMail(base)) for (const name of MAIL_ENV_VARS) env[name] = '';
  return { ...env, ...overrides };
}
