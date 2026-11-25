import type { Knex } from 'knex';

// Advertising service categories (FR-ADV-004, OQ-35). Swahili labels are first-draft translations.
// Needs the advertising migration; idempotent insert-if-missing.
const categories = [
  { code: 'wifi', name_en: 'Wi-Fi', name_sw: 'Wi-Fi' },
  { code: 'water_refill', name_en: 'Water refill', name_sw: 'Kujaza maji' },
  { code: 'gas_refill', name_en: 'Gas refill', name_sw: 'Kujaza gesi' },
];

export async function seed(knex: Knex): Promise<void> {
  await knex('service_categories')
    .insert(categories.map((c, i) => ({ ...c, sort_order: i + 1 })))
    .onConflict('code')
    .ignore();
}
