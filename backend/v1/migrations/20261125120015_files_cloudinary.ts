import type { Knex } from 'knex';
import { addChecks, oneOf } from '../db/helpers.js';

const CHECKS = [
  'ck_files_resource_type',
  'ck_files_delivery_type',
  'ck_files_format',
  'ck_files_visibility_delivery',
];

// Files move from SharePoint (drive_id/item_id) to Cloudinary (public_id + delivery type).
// Nothing ever wrote a files row against SharePoint, so this fails loudly (NOT NULL without a
// default) instead of inventing values if rows do exist.
export async function up(knex: Knex): Promise<void> {
  // Dropping the columns also drops the unique constraint ux_files_drive_item.
  await knex.schema.alterTable('files', (t) => {
    t.dropColumn('drive_id');
    t.dropColumn('item_id');
    t.text('public_id').notNullable();
    t.text('resource_type').notNullable();
    t.text('delivery_type').notNullable();
    t.text('format').notNullable();
  });
  await knex.raw('CREATE UNIQUE INDEX ux_files_public_id ON files (public_id)');
  await addChecks(knex, 'files', {
    ck_files_resource_type: oneOf('resource_type', ['image', 'raw']),
    ck_files_delivery_type: oneOf('delivery_type', ['upload', 'authenticated']),
    ck_files_format: oneOf('format', ['jpg', 'png', 'pdf']),
    // Restricted evidence can never be stored as a publicly deliverable asset.
    ck_files_visibility_delivery: `
      (visibility = 'public' AND delivery_type = 'upload')
      OR (visibility = 'restricted' AND delivery_type = 'authenticated')`,
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP INDEX ux_files_public_id');
  for (const name of CHECKS) {
    await knex.raw('ALTER TABLE files DROP CONSTRAINT ??', [name]);
  }
  await knex.schema.alterTable('files', (t) => {
    t.dropColumn('public_id');
    t.dropColumn('resource_type');
    t.dropColumn('delivery_type');
    t.dropColumn('format');
  });
  // Placeholder SharePoint ids so the original NOT NULL + unique shape can be restored.
  await knex.raw(`ALTER TABLE files
    ADD COLUMN drive_id text NOT NULL DEFAULT 'rolled-back',
    ADD COLUMN item_id text NOT NULL DEFAULT gen_random_uuid()::text`);
  await knex.raw(
    'ALTER TABLE files ALTER COLUMN drive_id DROP DEFAULT, ALTER COLUMN item_id DROP DEFAULT',
  );
  await knex.raw('CREATE UNIQUE INDEX ux_files_drive_item ON files (drive_id, item_id)');
}
