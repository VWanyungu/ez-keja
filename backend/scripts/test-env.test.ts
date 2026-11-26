import { describe, expect, it } from 'bun:test';
import { MAIL_ENV_VARS, sendsRealMail, testEnv } from './test-env.js';

const withKeys = {
  GMAIL_USER: 'real@example.com',
  GMAIL_APP_PASSWORD: 'real-app-password',
  USESENDY_API_KEY: 'real-sendy-key',
  MAIL_FROM: 'noreply@example.com',
  DB_NAME: 'khunt',
};

describe('testEnv (the child environment of the unit and integration runners)', () => {
  it('blanks every mail provider variable, as empty strings so .env cannot refill them', () => {
    const env = testEnv(withKeys);
    for (const name of MAIL_ENV_VARS) {
      expect(Object.hasOwn(env, name)).toBe(true);
      expect(env[name]).toBe('');
    }
    expect(env.MAIL_FROM).toBe('noreply@example.com'); // only the credentials are blanked
  });

  it('blanks them even when they were never set, so a later .env load cannot fill them', () => {
    const env = testEnv({});
    for (const name of MAIL_ENV_VARS) expect(env[name]).toBe('');
  });

  it('keeps the keys only for INTEGRATION_SEND_MAIL=1', () => {
    expect(sendsRealMail({ INTEGRATION_SEND_MAIL: '1' })).toBe(true);
    expect(sendsRealMail({ INTEGRATION_SEND_MAIL: 'true' })).toBe(false);
    const env = testEnv({ ...withKeys, INTEGRATION_SEND_MAIL: '1' });
    expect(env.GMAIL_USER).toBe('real@example.com');
    expect(env.USESENDY_API_KEY).toBe('real-sendy-key');
  });

  it('forces development mode and no rate limiting, and lets overrides win', () => {
    const env = testEnv({ ...withKeys, NODE_ENV: 'production', RATE_LIMIT_ENABLED: '1' }, { DB_NAME: 'khunt_test_1' });
    expect(env.NODE_ENV).toBe('development');
    expect(env.RATE_LIMIT_ENABLED).toBe('0');
    expect(env.DB_NAME).toBe('khunt_test_1');
  });

  it('really reaches a child process: Bun does not refill blanked variables from .env', async () => {
    const proc = Bun.spawn(
      ['bun', '-e', 'import "dotenv/config"; console.log(JSON.stringify(["GMAIL_USER","GMAIL_APP_PASSWORD","USESENDY_API_KEY"].map((k) => process.env[k])))'],
      { env: testEnv({ ...process.env, GMAIL_USER: 'real@example.com' }), cwd: `${import.meta.dir}/..`, stdout: 'pipe', stderr: 'pipe' },
    );
    expect(JSON.parse((await new Response(proc.stdout).text()).trim())).toEqual(['', '', '']);
  });
});

// Run through `bun run test` this proves the runner did its job; a bare `bun test` with real keys in .env fails here on purpose.
describe('this test process', () => {
  it('has no mail credentials (use `bun run test`, or INTEGRATION_SEND_MAIL=1 to send real mail on purpose)', () => {
    if (sendsRealMail(process.env)) return;
    for (const name of MAIL_ENV_VARS) expect(process.env[name] ?? '').toBe('');
  });
});
