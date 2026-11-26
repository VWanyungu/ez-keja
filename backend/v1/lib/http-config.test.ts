import { describe, expect, it } from 'bun:test';
import { parseTrustProxy, resolveCorsOrigin } from './http-config.js';
import { findEnvProblems, validateEnv } from './validate-env.js';

const SECRET_VALUE = 'super-secret-value-do-not-print';

const stagingOk = {
  NODE_ENV: 'staging',
  STAGING_DB_HOST: 'db',
  STAGING_DB_PORT: '5432',
  STAGING_DB_USER: 'khunt',
  STAGING_DB_PASSWORD: SECRET_VALUE,
  STAGING_DB_NAME: 'khunt',
  BETTER_AUTH_SECRET: SECRET_VALUE,
  CORS_ORIGIN: 'https://staging.example.com',
  FRONTEND_URL: 'https://staging.example.com',
  BETTER_AUTH_URL: 'https://api.staging.example.com',
  GMAIL_USER: 'a@example.com',
  GMAIL_APP_PASSWORD: SECRET_VALUE,
  CLOUDINARY_CLOUD_NAME: 'c',
  CLOUDINARY_API_KEY: 'k',
  CLOUDINARY_API_SECRET: SECRET_VALUE,
};

const productionOk = {
  ...Object.fromEntries(Object.entries(stagingOk).filter(([k]) => !k.startsWith('STAGING_') && !k.startsWith('GMAIL_'))),
  NODE_ENV: 'production',
  PROD_DB_HOST: 'db',
  PROD_DB_PORT: '5432',
  PROD_DB_USER: 'khunt',
  PROD_DB_PASSWORD: SECRET_VALUE,
  PROD_DB_NAME: 'khunt',
  USESENDY_API_KEY: SECRET_VALUE,
  MAIL_FROM: 'noreply@example.com',
  CORS_ORIGIN: 'https://khunt.example.com',
};

describe('validateEnv', () => {
  it('is permissive in development and test', () => {
    expect(findEnvProblems({ NODE_ENV: 'development' })).toEqual([]);
    expect(findEnvProblems({})).toEqual([]);
    expect(() => validateEnv({ NODE_ENV: 'development' })).not.toThrow();
  });

  it('accepts a complete staging and production environment (Maps key optional)', () => {
    expect(findEnvProblems(stagingOk)).toEqual([]);
    expect(findEnvProblems(productionOk)).toEqual([]);
  });

  it('lists every missing name for an empty staging environment, with the STAGING_ DB prefix', () => {
    expect(findEnvProblems({ NODE_ENV: 'staging' })).toEqual([
      'STAGING_DB_HOST', 'STAGING_DB_PORT', 'STAGING_DB_USER', 'STAGING_DB_PASSWORD', 'STAGING_DB_NAME',
      'BETTER_AUTH_SECRET (or AUTH_SECRET)', 'FRONTEND_URL', 'BETTER_AUTH_URL', 'GMAIL_USER', 'GMAIL_APP_PASSWORD',
      'CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET', 'CORS_ORIGIN',
    ]);
  });

  it('needs the PROD_ prefix and Usesendy plus MAIL_FROM in production, not Gmail', () => {
    const problems = findEnvProblems({ NODE_ENV: 'production' });
    expect(problems).toContain('PROD_DB_HOST');
    expect(problems).toContain('USESENDY_API_KEY');
    expect(problems).toContain('MAIL_FROM');
    expect(problems).not.toContain('GMAIL_USER');
    expect(problems).not.toContain('STAGING_DB_HOST');
  });

  it('treats a blank value as missing and accepts AUTH_SECRET in place of BETTER_AUTH_SECRET', () => {
    expect(findEnvProblems({ ...stagingOk, GMAIL_USER: '   ' })).toEqual(['GMAIL_USER']);
    const { BETTER_AUTH_SECRET: _drop, ...rest } = stagingOk;
    expect(findEnvProblems({ ...rest, AUTH_SECRET: 'x' })).toEqual([]);
  });

  it('rejects a wildcard CORS_ORIGIN and a trust-everything TRUST_PROXY', () => {
    expect(findEnvProblems({ ...stagingOk, CORS_ORIGIN: '*' })).toEqual(['CORS_ORIGIN (explicit origins only, no "*")']);
    expect(findEnvProblems({ ...stagingOk, TRUST_PROXY: 'true' })).toHaveLength(1);
    expect(findEnvProblems({ ...stagingOk, TRUST_PROXY: '1' })).toEqual([]);
  });

  it('throws an error naming the variables and never containing a value', () => {
    const broken = { ...stagingOk, STAGING_DB_NAME: '', CLOUDINARY_API_SECRET: undefined };
    let message = '';
    try {
      validateEnv(broken);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('STAGING_DB_NAME');
    expect(message).toContain('CLOUDINARY_API_SECRET');
    expect(message).not.toContain(SECRET_VALUE);
    expect(message).not.toContain('staging.example.com');
  });
});

describe('resolveCorsOrigin', () => {
  it('keeps development permissive', () => {
    expect(resolveCorsOrigin({ NODE_ENV: 'development' })).toBe(true);
    expect(resolveCorsOrigin({ CORS_ORIGIN: '*' })).toBe(true);
    expect(resolveCorsOrigin({ CORS_ORIGIN: 'http://a.test, http://b.test' })).toEqual(['http://a.test', 'http://b.test']);
  });

  it.each(['staging', 'production'])('refuses an unset, empty or wildcard origin in %s', (NODE_ENV) => {
    expect(() => resolveCorsOrigin({ NODE_ENV })).toThrow(/CORS_ORIGIN/);
    expect(() => resolveCorsOrigin({ NODE_ENV, CORS_ORIGIN: '*' })).toThrow(/CORS_ORIGIN/);
    expect(() => resolveCorsOrigin({ NODE_ENV, CORS_ORIGIN: 'https://a.test,*' })).toThrow(/CORS_ORIGIN/);
    expect(() => resolveCorsOrigin({ NODE_ENV, CORS_ORIGIN: 'https://*.a.test' })).toThrow(/CORS_ORIGIN/);
    expect(resolveCorsOrigin({ NODE_ENV, CORS_ORIGIN: 'https://a.test' })).toEqual(['https://a.test']);
  });
});

describe('parseTrustProxy', () => {
  it('is off unless set', () => {
    expect(parseTrustProxy(undefined)).toBe(false);
    expect(parseTrustProxy('')).toBe(false);
    expect(parseTrustProxy('false')).toBe(false);
  });

  it('takes a hop count, a keyword or a CIDR list, and refuses "true"', () => {
    expect(parseTrustProxy('1')).toBe(1);
    expect(parseTrustProxy('loopback')).toBe('loopback');
    expect(parseTrustProxy('10.0.0.0/8, 127.0.0.1')).toBe('10.0.0.0/8, 127.0.0.1');
    expect(() => parseTrustProxy('true')).toThrow();
  });
});
