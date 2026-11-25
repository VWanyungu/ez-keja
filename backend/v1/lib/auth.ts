import { APIError, betterAuth } from 'better-auth';
import { createAuthMiddleware } from 'better-auth/api';
import { fromNodeHeaders } from 'better-auth/node';
import type { IncomingHttpHeaders } from 'node:http';
import { Pool } from 'pg';
import type { Knex } from 'knex';
import knexConfig from '../../knexfile.js';
import db from '../db/knex.js';
import { getAuthSecret } from './auth-secret.js';
import { sendPasswordResetEmail } from './mailer.js';
import { revokeAllUserTokens } from './tokens.js';
import { generateUuidV7 } from './uuid.js';

const STATEMENT_TIMEOUT_MS = 30_000;
const IDLE_IN_TRANSACTION_TIMEOUT_MS = 30_000;

const pgConn = knexConfig.connection as Knex.PgConnectionConfig;

export const authPool = new Pool({
  host: pgConn.host,
  port: pgConn.port,
  user: pgConn.user,
  database: pgConn.database,
  password: pgConn.password,
  max: 10,
  idleTimeoutMillis: 30_000,
  statement_timeout: STATEMENT_TIMEOUT_MS,
  idle_in_transaction_session_timeout: IDLE_IN_TRANSACTION_TIMEOUT_MS,
});

const port = Number(process.env.PORT) || 3000;
const baseURL = process.env.BETTER_AUTH_URL || `http://localhost:${port}`;

function resolveTrustedOrigins(): string[] {
  const fromEnv = process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(',').map((origin) => origin.trim()).filter(Boolean)
    : [];
  const frontendUrl = process.env.FRONTEND_URL ? [process.env.FRONTEND_URL.trim()] : [];
  const defaults =
    process.env.NODE_ENV === 'production'
      ? [baseURL]
      : [baseURL, 'http://localhost:*', 'http://127.0.0.1:*'];
  return Array.from(new Set([...defaults, ...frontendUrl, ...fromEnv]));
}

function buildResetUrl(betterAuthUrl: string, token: string): string {
  const frontendUrl = process.env.FRONTEND_URL?.trim();
  if (frontendUrl && !betterAuthUrl.includes('callbackURL=http')) {
    return `${frontendUrl.replace(/\/$/, '')}/reset-password?token=${encodeURIComponent(token)}`;
  }
  return betterAuthUrl;
}

export const auth = betterAuth({
  appName: 'khunt',
  baseURL,
  basePath: '/api/auth',
  secret: getAuthSecret(),
  trustedOrigins: resolveTrustedOrigins(),
  database: authPool,
  emailAndPassword: {
    enabled: true,
    // Registration must pass through v1 /auth/register so profile, role and consent are
    // created atomically in one transaction (FR-PRV-001, FR-ADM-006).
    disableSignUp: true,
    minPasswordLength: 8,
    maxPasswordLength: 128,
    resetPasswordTokenExpiresIn: 3600,
    revokeSessionsOnPasswordReset: true,
    sendResetPassword: async ({ user, url, token }) => {
      await sendPasswordResetEmail({
        to: user.email,
        name: user.name,
        resetUrl: buildResetUrl(url, token),
        token,
      });
    },
    onPasswordReset: async ({ user }) => {
      await revokeAllUserTokens(user.id, 'password_reset');
    },
  },
  user: {
    modelName: 'auth_users',
    fields: {
      emailVerified: 'email_verified',
      createdAt: 'created_at',
      updatedAt: 'updated_at',
    },
  },
  session: {
    modelName: 'auth_sessions',
    fields: {
      expiresAt: 'expires_at',
      ipAddress: 'ip_address',
      userAgent: 'user_agent',
      userId: 'user_id',
      createdAt: 'created_at',
      updatedAt: 'updated_at',
    },
  },
  account: {
    modelName: 'auth_accounts',
    fields: {
      accountId: 'account_id',
      providerId: 'provider_id',
      userId: 'user_id',
      accessToken: 'access_token',
      refreshToken: 'refresh_token',
      idToken: 'id_token',
      accessTokenExpiresAt: 'access_token_expires_at',
      refreshTokenExpiresAt: 'refresh_token_expires_at',
      createdAt: 'created_at',
      updatedAt: 'updated_at',
    },
  },
  verification: {
    modelName: 'auth_verifications',
    fields: {
      expiresAt: 'expires_at',
      createdAt: 'created_at',
      updatedAt: 'updated_at',
    },
  },
  advanced: {
    database: {
      generateId: () => generateUuidV7(),
    },
  },
  hooks: {
    after: createAuthMiddleware(async (ctx) => {
      if (ctx.path === '/revoke-sessions') {
        const userId = ctx.context.session?.user?.id;
        if (userId) {
          await revokeAllUserTokens(userId, 'logout_all');
        }
      }
    }),
  },
  databaseHooks: {
    user: {
      create: {
        before: async (user) => ({
          data: {
            ...user,
            email: user.email.trim().toLowerCase(),
          },
        }),
      },
      update: {
        before: async (user) => {
          if (typeof user.email !== 'string') return;
          return {
            data: {
              ...user,
              email: user.email.trim().toLowerCase(),
            },
          };
        },
      },
    },
    session: {
      create: {
        before: async (session) => {
          const profile = await db('profiles')
            .where({ user_id: session.userId })
            .first('account_status', 'erased_at');

          if (!profile || profile.erased_at !== null) {
            throw new APIError('FORBIDDEN', {
              code: 'ACCOUNT_INACTIVE',
              message: 'Account is not active',
            });
          }

          if (profile.account_status === 'suspended') {
            throw new APIError('FORBIDDEN', {
              code: 'ACCOUNT_SUSPENDED',
              message: 'Account is suspended',
            });
          }
        },
        after: async (session) => {
          await db('profiles')
            .where({ user_id: session.userId })
            .update({ last_login_at: new Date() });
        },
      },
    },
  },
});

export type BetterAuthSession = Awaited<ReturnType<typeof auth.api.getSession>>;

export async function getSessionFromHeaders(headers: IncomingHttpHeaders): Promise<BetterAuthSession> {
  return auth.api.getSession({
    headers: fromNodeHeaders(headers),
  });
}

export async function closeAuthPool(): Promise<void> {
  await authPool.end();
}
