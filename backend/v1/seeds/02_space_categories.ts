import type { Knex } from 'knex';

// Nine categories (FR-UNT-003). Swahili labels are first-draft translations: have a Swahili
// speaker confirm them. Idempotent insert-if-missing (OQ-47: Admins may extend or edit the list).
const categories = [
  { code: 'bedsitter', name_en: 'Bedsitter', name_sw: 'Bedsitter', kind: 'residential' },
  { code: 'one_bedroom', name_en: 'One bedroom', name_sw: 'Chumba kimoja cha kulala', kind: 'residential' },
  { code: 'two_bedroom', name_en: 'Two bedroom', name_sw: 'Vyumba viwili vya kulala', kind: 'residential' },
  { code: 'three_bedroom', name_en: 'Three bedroom', name_sw: 'Vyumba vitatu vya kulala', kind: 'residential' },
  { code: 'townhouse', name_en: 'Townhouse', name_sw: 'Townhouse', kind: 'residential' },
  { code: 'villa', name_en: 'Villa', name_sw: 'Villa', kind: 'residential' },
  { code: 'office', name_en: 'Office', name_sw: 'Ofisi', kind: 'commercial' },
  { code: 'shop', name_en: 'Shop', name_sw: 'Duka', kind: 'commercial' },
  { code: 'warehouse', name_en: 'Warehouse', name_sw: 'Ghala', kind: 'commercial' },
];

export async function seed(knex: Knex): Promise<void> {
  await knex('space_categories')
    .insert(categories.map((c, i) => ({ ...c, sort_order: i + 1 })))
    .onConflict('code')
    .ignore();
}
