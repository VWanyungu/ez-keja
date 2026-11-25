import type { Knex } from 'knex';

type Table = Knex.CreateTableBuilder;

// E.164 phone (SQL literal). No "?" anywhere in migration SQL: knex turns it into a bind placeholder.
export const E164 = "'^\\+[1-9][0-9]{7,14}$'";

/** UUIDv7 primary key; app_uuidv7() is defined in the first migration (design §7.4). */
export const pk = (knex: Knex, t: Table) =>
  t.uuid('id').primary().defaultTo(knex.raw('app_uuidv7()'));

export const tstz = (t: Table, name: string) => t.timestamp(name, { useTz: true });

export const createdAt = (knex: Knex, t: Table) =>
  tstz(t, 'created_at').notNullable().defaultTo(knex.fn.now());

export const timestamps = (knex: Knex, t: Table) => {
  createdAt(knex, t);
  tstz(t, 'updated_at').notNullable().defaultTo(knex.fn.now());
};

/** uuid foreign key, ON DELETE RESTRICT unless `cascade` (design §3.3). */
export const fk = (
  t: Table,
  column: string,
  table: string,
  opts: { optional?: boolean; cascade?: boolean } = {},
) => {
  const col = t.uuid(column);
  if (!opts.optional) col.notNullable();
  return col.references('id').inTable(table).onDelete(opts.cascade ? 'CASCADE' : 'RESTRICT');
};

/** `col IN ('a', 'b')` for text value-set checks (design DD-02). */
export const oneOf = (col: string, values: string[]) =>
  `${col} IN (${values.map((v) => `'${v}'`).join(', ')})`;

/** Named CHECK constraints, added after the table so every one carries its ck_ name. */
export async function addChecks(knex: Knex, table: string, checks: Record<string, string>) {
  for (const [name, expr] of Object.entries(checks)) {
    await knex.raw(`ALTER TABLE ?? ADD CONSTRAINT ?? CHECK (${expr})`, [table, name]);
  }
}

/** T1: keep updated_at current. */
export const touchUpdatedAt = (knex: Knex, table: string) =>
  knex.raw(
    `CREATE TRIGGER ?? BEFORE UPDATE ON ?? FOR EACH ROW EXECUTE FUNCTION set_updated_at()`,
    [`trg_${table}_updated_at`, table],
  );

/** T2: block UPDATE, DELETE and TRUNCATE. */
export async function appendOnly(knex: Knex, table: string) {
  await knex.raw(
    `CREATE TRIGGER ?? BEFORE UPDATE OR DELETE ON ?? FOR EACH ROW EXECUTE FUNCTION forbid_mutation()`,
    [`trg_${table}_no_mutation`, table],
  );
  await knex.raw(
    `CREATE TRIGGER ?? BEFORE TRUNCATE ON ?? FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation()`,
    [`trg_${table}_no_truncate`, table],
  );
}

/** Drop tables in the given order (children first), for `down`. */
export async function dropTables(knex: Knex, tables: string[]) {
  for (const table of tables) await knex.schema.dropTableIfExists(table);
}
