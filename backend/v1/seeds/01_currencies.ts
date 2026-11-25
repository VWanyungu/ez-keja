import type { Knex } from 'knex';

// Required reference data (design §5.2). Idempotent: inserts only missing rows, never overwrites
// what an Admin changed, so it is safe to run on every deployment.
export async function seed(knex: Knex): Promise<void> {
  await knex('currencies')
    .insert([
      { code: 'KES', name: 'Kenyan shilling', sort_order: 1 },
      { code: 'USD', name: 'US dollar', sort_order: 2 },
    ])
    .onConflict('code')
    .ignore();
}
