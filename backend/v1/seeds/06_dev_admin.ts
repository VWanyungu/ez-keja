import { randomBytes, scryptSync } from 'node:crypto';
import type { Knex } from 'knex';

// DEVELOPMENT ONLY: a known-password Admin for local work. Skips itself in any other NODE_ENV,
// because seeds run on every deployment. Idempotent: does nothing if the email already exists.
// Real Admins are created out of band, never by registration (design §5.1 user_roles).
const ADMIN_EMAIL = 'admin@khunt.local';
const ADMIN_PASSWORD = 'password';
const SYSTEM_EMAIL = 'system@khunt.invalid';

// scrypt in Better Auth's stored format "<salt hex>:<key hex>" (N=16384, r=16, p=1, 64 bytes,
// NFKC-normalised). Reproduced from memory of Better Auth's default; Better Auth is not installed
// yet, so confirm that login works once it is added.
function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const key = scryptSync(password.normalize('NFKC'), salt, 64, {
    N: 16384, r: 16, p: 1, maxmem: 128 * 16384 * 16 * 2,
  });
  return `${salt}:${key.toString('hex')}`;
}

export async function seed(knex: Knex): Promise<void> {
  if ((process.env.NODE_ENV ?? 'development') !== 'development') {
    console.log('06_dev_admin: skipped (not development)');
    return;
  }
  if (await knex('auth_users').where({ email: ADMIN_EMAIL }).first()) return;

  await knex.transaction(async (trx) => {
    // user_roles forbids self-granted admins, so a credential-less system user is the grantor.
    const system = await trx('auth_users').where({ email: SYSTEM_EMAIL }).first('id')
      ?? (await trx('auth_users')
        .insert({ name: 'System', email: SYSTEM_EMAIL, email_verified: true })
        .returning('id'))[0];

    const [admin] = await trx('auth_users')
      .insert({ name: 'Admin', email: ADMIN_EMAIL, email_verified: true })
      .returning('id');

    await trx('auth_accounts').insert({
      account_id: admin.id,
      provider_id: 'credential',
      user_id: admin.id,
      password: hashPassword(ADMIN_PASSWORD),
    });
    await trx('profiles').insert({ user_id: admin.id, display_name: 'Admin' });
    await trx('user_roles').insert({ user_id: admin.id, role: 'admin', granted_by: system.id });

    const notice = await trx('privacy_notice_versions').orderBy('effective_at', 'desc').first('id');
    if (notice) await trx('consent_records').insert({ user_id: admin.id, notice_version_id: notice.id });
  });
  console.log(`06_dev_admin: created ${ADMIN_EMAIL}`);
}
