import type { Knex } from 'knex';

// UUIDv7 default, T1 (set_updated_at) and T2 (forbid_mutation). Design §3.3, §7.2, §7.4.
export async function up(knex: Knex): Promise<void> {
  const { rows } = await knex.raw('SHOW server_version_num');
  const native = Number(rows[0].server_version_num) >= 180000;

  // Native uuidv7() exists from PostgreSQL 18; before that, overlay a 48-bit ms timestamp on
  // gen_random_uuid() and set the version nibble to 7 (bits 52 and 53 of the byte string).
  await knex.raw(
    native
      ? `CREATE FUNCTION app_uuidv7() RETURNS uuid LANGUAGE sql VOLATILE AS $$ SELECT uuidv7() $$`
      : `CREATE FUNCTION app_uuidv7() RETURNS uuid LANGUAGE sql VOLATILE AS $$
           SELECT encode(
             set_bit(set_bit(
               overlay(uuid_send(gen_random_uuid())
                       placing substring(int8send(floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3)
                       FROM 1 FOR 6),
               52, 1), 53, 1),
             'hex')::uuid
         $$`,
  );

  await knex.raw(`
    CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql
    SET search_path = public, pg_temp AS $$
    BEGIN
      NEW.updated_at := now();
      RETURN NEW;
    END $$`);

  await knex.raw(`
    CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql
    SET search_path = public, pg_temp AS $$
    BEGIN
      RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP
        USING ERRCODE = 'restrict_violation';
    END $$`);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP FUNCTION IF EXISTS forbid_mutation()');
  await knex.raw('DROP FUNCTION IF EXISTS set_updated_at()');
  await knex.raw('DROP FUNCTION IF EXISTS app_uuidv7()');
}
