import type { Knex } from 'knex';

// Admin-editable thresholds (design §5.2, FR-ADM-004). Required data: the publish gate (T5)
// fails closed if a key is missing. Values are the SRS defaults. Insert-if-missing, so a value an
// Admin has changed is never reset by a redeploy.
const settings = [
  { key: 'freshness_days', value: 7, description: 'Days after a count confirmation before a space type is considered outdated (BR-001)' },
  { key: 'reminder_lead_days', value: 1, description: 'Days before the freshness threshold to send the first reminder (BR-010)' },
  { key: 'reminder_repeat_days', value: 7, description: 'Days between repeat reminders once outdated (BR-010)' },
  { key: 'hide_after_days', value: 14, description: 'Days without confirmation before a space type is ranked lower or hidden (BR-011, TBD OQ-09)' },
  { key: 'max_promoted_per_building', value: 5, description: 'Maximum promoted services shown on a building page (BR-025, TBD OQ-36)' },
  { key: 'min_building_photos', value: 3, description: 'Minimum cover plus grounds photos to publish a building (BR-018, OQ-40)' },
  { key: 'min_surroundings_photos', value: 1, description: 'Minimum surroundings photos to publish a building (BR-018, OQ-40)' },
  { key: 'min_space_type_photos', value: 3, description: 'Minimum photos per space type to publish a building (BR-018, OQ-40)' },
  {
    key: 'require_verified_lister_to_publish',
    value: 1,
    min_value: 0,
    max_value: 1,
    description: '1 = lister must be Verified to publish, 0 = not required (BR-005, TBD OQ-03)',
  },
];

export async function seed(knex: Knex): Promise<void> {
  await knex('settings').insert(settings).onConflict('key').ignore();
}
