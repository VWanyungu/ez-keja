import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { hashPassword } from 'better-auth/crypto';
import type { Knex } from 'knex';
import { assetFolder, createCloudinaryClient, type CloudinaryClient } from '../lib/cloudinary.js';

// DEVELOPMENT ONLY: sample listers, areas and published buildings so the public screens have data.
// Photos are real uploads to Cloudinary (under khunt/development/seed/), taken from
// backend/seed-assets/photos. Run it with `bun run seed:dev-catalogue`; it skips itself otherwise and
// in any other NODE_ENV (seeds run on every deployment). Idempotent: users, areas and buildings that
// already exist are left alone.
const PASSWORD = 'password';
const PHOTO_DIR = new URL('../../seed-assets/photos/', import.meta.url);
const PHOTO_SOURCES = 6;
const UPLOAD_BATCH = 4;

interface UserSpec {
  email: string;
  name: string;
  role: 'agent' | 'landlord' | 'client';
  phone: string;
  verified: boolean;
}

// Every lister is Verified: the publish gate (BR-005) refuses an unverified lister.
const USERS: UserSpec[] = [
  { email: 'wanjiku.kamau@khunt.local', name: 'Wanjiku Kamau', role: 'agent', phone: '+254712000001', verified: true },
  { email: 'brian.otieno@khunt.local', name: 'Brian Otieno', role: 'agent', phone: '+254712000002', verified: true },
  { email: 'grace.muthoni@khunt.local', name: 'Grace Muthoni', role: 'landlord', phone: '+254712000003', verified: true },
  { email: 'peter.mwangi@khunt.local', name: 'Peter Mwangi', role: 'landlord', phone: '+254712000004', verified: true },
  { email: 'renter@khunt.local', name: 'Test Renter', role: 'client', phone: '+254712000005', verified: false },
];

// Approximate area centres, good enough for radius search in development.
const AREAS = [
  { slug: 'ngong-town', name: 'Ngong Town', lat: -1.3515, lng: 36.6585 },
  { slug: 'ngong-road', name: 'Ngong Road', lat: -1.3005, lng: 36.7885 },
  { slug: 'matasia', name: 'Matasia', lat: -1.3667, lng: 36.6833 },
  { slug: 'embulbul', name: 'Embulbul', lat: -1.383, lng: 36.65 },
  { slug: 'ngong-hills', name: 'Ngong Hills', lat: -1.4, lng: 36.634 },
  { slug: 'kiserian', name: 'Kiserian', lat: -1.4217, lng: 36.6778 },
  { slug: 'karen', name: 'Karen', lat: -1.319, lng: 36.709 },
];

interface TypeSpec {
  name: string;
  category: string;
  sizeSqm: number;
  /** null = "rent on interest". */
  rent: number | null;
  vacant: number;
  /** Days since the count was last confirmed; above 7 the type reads "may be outdated". */
  confirmedDaysAgo: number;
}

interface BuildingSpec {
  name: string;
  area: string;
  lat: number;
  lng: number;
  lister: string;
  verified: boolean;
  description: string;
  types: TypeSpec[];
}

const BUILDINGS: BuildingSpec[] = [
  {
    name: 'Mountain View Apartments', area: 'matasia', lat: -1.3672, lng: 36.6841,
    lister: 'wanjiku.kamau@khunt.local', verified: true,
    description: 'Quiet gated compound with a borehole, covered parking and a ten-minute walk to the Matasia stage.',
    types: [
      { name: 'Bedsitter', category: 'bedsitter', sizeSqm: 22, rent: 7000, vacant: 3, confirmedDaysAgo: 0 },
      { name: 'One bedroom', category: 'one_bedroom', sizeSqm: 38, rent: 9500, vacant: 2, confirmedDaysAgo: 0 },
    ],
  },
  {
    name: 'Kiserian Heights', area: 'kiserian', lat: -1.4224, lng: 36.6769,
    lister: 'brian.otieno@khunt.local', verified: true,
    description: 'Mid-rise block on the Kiserian road with 24-hour security and a backup generator.',
    types: [
      { name: 'One bedroom', category: 'one_bedroom', sizeSqm: 40, rent: 9500, vacant: 4, confirmedDaysAgo: 2 },
      { name: 'Two bedroom', category: 'two_bedroom', sizeSqm: 62, rent: 18000, vacant: 2, confirmedDaysAgo: 2 },
      { name: 'Three bedroom', category: 'three_bedroom', sizeSqm: 88, rent: 28000, vacant: 1, confirmedDaysAgo: 3 },
    ],
  },
  {
    name: 'Ngong Road Court', area: 'ngong-road', lat: -1.3012, lng: 36.7871,
    lister: 'peter.mwangi@khunt.local', verified: false,
    description: 'Older block close to the Ngong Road matatu route. Counts were last confirmed a while ago.',
    types: [
      { name: 'Bedsitter', category: 'bedsitter', sizeSqm: 20, rent: 9000, vacant: 2, confirmedDaysAgo: 16 },
      { name: 'Two bedroom', category: 'two_bedroom', sizeSqm: 58, rent: 17500, vacant: 1, confirmedDaysAgo: 16 },
    ],
  },
  {
    name: 'Embulbul Court', area: 'embulbul', lat: -1.3836, lng: 36.6492,
    lister: 'grace.muthoni@khunt.local', verified: true,
    description: 'Family-sized two bedrooms in a calm cul-de-sac, with a play area and borehole water.',
    types: [
      { name: 'Two bedroom', category: 'two_bedroom', sizeSqm: 65, rent: 18000, vacant: 3, confirmedDaysAgo: 3 },
    ],
  },
  {
    name: 'Matasia Gardens', area: 'matasia', lat: -1.3659, lng: 36.6822,
    lister: 'wanjiku.kamau@khunt.local', verified: true,
    description: 'Maisonettes and bedsitters set around landscaped gardens.',
    types: [
      { name: 'Bedsitter', category: 'bedsitter', sizeSqm: 24, rent: 8500, vacant: 5, confirmedDaysAgo: 0 },
      { name: 'Townhouse', category: 'townhouse', sizeSqm: 140, rent: 45000, vacant: 1, confirmedDaysAgo: 0 },
    ],
  },
  {
    name: 'Ngong Hills View', area: 'ngong-hills', lat: -1.3994, lng: 36.6351,
    lister: 'brian.otieno@khunt.local', verified: true,
    description: 'Large homes on the slopes with views over the Rift Valley.',
    types: [
      { name: 'Three bedroom', category: 'three_bedroom', sizeSqm: 95, rent: 35000, vacant: 2, confirmedDaysAgo: 1 },
      { name: 'Villa', category: 'villa', sizeSqm: 210, rent: 58000, vacant: 1, confirmedDaysAgo: 1 },
    ],
  },
  {
    name: 'Karen Plains Residences', area: 'karen', lat: -1.3184, lng: 36.7102,
    lister: 'grace.muthoni@khunt.local', verified: true,
    description: 'Secure two-bedroom apartments a short drive from the Karen shopping centre.',
    types: [
      { name: 'Two bedroom', category: 'two_bedroom', sizeSqm: 72, rent: 24000, vacant: 2, confirmedDaysAgo: 4 },
    ],
  },
  {
    name: 'Ngong Town Plaza', area: 'ngong-town', lat: -1.3521, lng: 36.6577,
    lister: 'peter.mwangi@khunt.local', verified: false,
    description: 'Commercial block in the middle of Ngong town: offices upstairs, shops at street level.',
    types: [
      { name: 'Office', category: 'office', sizeSqm: 45, rent: 60000, vacant: 2, confirmedDaysAgo: 5 },
      { name: 'Shop', category: 'shop', sizeSqm: 30, rent: null, vacant: 1, confirmedDaysAgo: 5 },
    ],
  },
];

const loaded = new Map<number, Buffer>();
function photoBytes(n: number): Buffer {
  const index = n % PHOTO_SOURCES;
  let bytes = loaded.get(index);
  if (!bytes) {
    bytes = readFileSync(fileURLToPath(new URL(`building-${index + 1}.jpg`, PHOTO_DIR)));
    loaded.set(index, bytes);
  }
  return bytes;
}

interface PlannedPhoto {
  publicId: string;
  source: number;
  category: 'cover' | 'grounds' | 'surroundings' | 'space_type';
  /** Index into the building's types, for space type photos. */
  typeIndex: number | null;
}

/**
 * What the publish gate (T5) needs: a cover plus two grounds, one surroundings photo, and three
 * per space type. The six source photos rotate so no gallery shows the same picture twice.
 */
function planPhotos(slug: string, offset: number, typeCount: number): PlannedPhoto[] {
  const folder = `${assetFolder()}/seed/${slug}`;
  const plan: PlannedPhoto[] = [
    { publicId: `${folder}/cover`, source: offset, category: 'cover', typeIndex: null },
    { publicId: `${folder}/grounds-1`, source: offset + 1, category: 'grounds', typeIndex: null },
    { publicId: `${folder}/grounds-2`, source: offset + 2, category: 'grounds', typeIndex: null },
    { publicId: `${folder}/surroundings-1`, source: offset + 3, category: 'surroundings', typeIndex: null },
  ];
  for (let t = 0; t < typeCount; t += 1) {
    for (let k = 0; k < 3; k += 1) {
      plan.push({
        publicId: `${folder}/type-${t + 1}-${k + 1}`,
        source: offset + t + k * 2,
        category: 'space_type',
        typeIndex: t,
      });
    }
  }
  return plan;
}

const slugOf = (name: string): string =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

async function seedUsers(knex: Knex): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  const notice = await knex('privacy_notice_versions').orderBy('effective_at', 'desc').first('id');

  for (const u of USERS) {
    const existing = await knex('auth_users').where({ email: u.email }).first('id');
    if (existing) {
      ids.set(u.email, existing.id);
      continue;
    }
    const password = await hashPassword(PASSWORD);
    await knex.transaction(async (trx) => {
      // T7 only lets verification_status move under this setting; it applies to this transaction only.
      await trx.raw("SET LOCAL khunt.verification_writer = 'on'");
      const [user] = await trx('auth_users')
        .insert({ name: u.name, email: u.email, email_verified: true })
        .returning('id');
      await trx('auth_accounts').insert({
        account_id: user.id, provider_id: 'credential', user_id: user.id, password,
      });
      await trx('profiles').insert({
        user_id: user.id,
        display_name: u.name,
        phone: u.phone,
        agent_type: u.role === 'agent' ? 'agent' : null,
      });
      if (u.verified) await trx('profiles').where({ user_id: user.id }).update({ verification_status: 'verified' });
      await trx('user_roles').insert(
        (u.role === 'client' ? ['client'] : ['client', u.role]).map((role) => ({ user_id: user.id, role })),
      );
      if (notice) await trx('consent_records').insert({ user_id: user.id, notice_version_id: notice.id });
      ids.set(u.email, user.id);
    });
  }
  return ids;
}

async function seedAreas(knex: Knex): Promise<Map<string, string>> {
  await knex('areas')
    .insert(AREAS.map((a) => ({ slug: a.slug, name: a.name, centre_lat: a.lat, centre_lng: a.lng })))
    .onConflict('slug')
    .ignore();
  const rows = await knex('areas').whereIn('slug', AREAS.map((a) => a.slug)).select('id', 'slug');
  return new Map(rows.map((r: { id: string; slug: string }) => [r.slug, r.id]));
}

async function uploadAll(storage: CloudinaryClient, plan: PlannedPhoto[]) {
  const stored = [];
  for (let i = 0; i < plan.length; i += UPLOAD_BATCH) {
    stored.push(
      ...(await Promise.all(
        plan.slice(i, i + UPLOAD_BATCH).map((p) =>
          storage.upload({
            publicId: p.publicId,
            resourceType: 'image',
            deliveryType: 'upload',
            buffer: photoBytes(p.source),
            mimeType: 'image/jpeg',
            filename: `${p.publicId.split('/').pop()}.jpg`,
          }),
        ),
      )),
    );
  }
  return stored;
}

export async function seed(knex: Knex): Promise<void> {
  if ((process.env.NODE_ENV ?? 'development') !== 'development') {
    console.log('07_dev_catalogue: skipped (not development)');
    return;
  }
  // Opt-in: `bun run seed` and the integration test runner seed every file, and neither may upload
  // photos or add buildings the tests do not expect.
  if (process.env.SEED_DEV_CATALOGUE !== '1') {
    console.log('07_dev_catalogue: skipped (run `bun run seed:dev-catalogue` to load it)');
    return;
  }
  const { CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET } = process.env;
  if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
    console.log('07_dev_catalogue: skipped (Cloudinary is not configured; published buildings need photos)');
    return;
  }
  const storage = createCloudinaryClient({
    cloudName: CLOUDINARY_CLOUD_NAME, apiKey: CLOUDINARY_API_KEY, apiSecret: CLOUDINARY_API_SECRET,
  });

  const [kes, categoryRows] = await Promise.all([
    knex('currencies').where({ code: 'KES' }).first('id'),
    knex('space_categories').select('id', 'code'),
  ]);
  if (!kes || categoryRows.length === 0) {
    throw new Error('07_dev_catalogue needs the currencies and space categories seeds to have run first');
  }
  const categoryIds = new Map<string, string>(categoryRows.map((c: { id: string; code: string }) => [c.code, c.id]));
  const userIds = await seedUsers(knex);
  const areaIds = await seedAreas(knex);

  let created = 0;
  for (const [index, spec] of BUILDINGS.entries()) {
    const listerId = userIds.get(spec.lister)!;
    if (await knex('buildings').where({ name: spec.name, lister_id: listerId }).first('id')) continue;

    const plan = planPhotos(slugOf(spec.name), index, spec.types.length);
    const stored = await uploadAll(storage, plan);
    const isAgent = USERS.find((u) => u.email === spec.lister)!.role === 'agent';

    await knex.transaction(async (trx) => {
      await trx.raw("SET LOCAL khunt.verification_writer = 'on'");
      const [building] = await trx('buildings')
        .insert({
          name: spec.name,
          area_id: areaIds.get(spec.area)!,
          latitude: spec.lat,
          longitude: spec.lng,
          description: spec.description,
          management_type: isAgent ? 'agent' : 'landlord',
          managing_agent_id: isAgent ? listerId : null,
          landlord_user_id: isAgent ? null : listerId,
          lister_id: listerId,
          created_by: listerId,
        })
        .returning('id');
      await trx('building_maintainers').insert({ building_id: building.id, user_id: listerId, added_by: listerId });
      await trx('buildings').where({ id: building.id }).update({ contact_user_id: listerId });

      const typeIds: string[] = [];
      for (const t of spec.types) {
        const [row] = await trx('space_types')
          .insert({
            building_id: building.id,
            name: t.name,
            category_id: categoryIds.get(t.category)!,
            size_sqm: t.sizeSqm,
            rent_mode: t.rent === null ? 'on_interest' : 'fixed',
            currency_id: kes.id,
            rent_amount: t.rent,
            deposit_amount: t.rent === null ? 0 : t.rent * 2,
            vacant_count: t.vacant,
            last_confirmed_at: trx.raw("now() - (? * interval '1 day')", [t.confirmedDaysAgo]),
            created_by: listerId,
          })
          .returning('id');
        typeIds.push(row.id);
      }

      for (const [i, photo] of plan.entries()) {
        const asset = stored[i]!;
        const [file] = await trx('files')
          .insert({
            public_id: asset.publicId,
            resource_type: 'image',
            delivery_type: 'upload',
            format: 'jpg',
            original_name: `${photo.publicId.split('/').pop()}.jpg`,
            mime_type: 'image/jpeg',
            size_bytes: asset.bytes,
            width_px: asset.width,
            height_px: asset.height,
            visibility: 'public',
            uploaded_by: listerId,
          })
          .returning('id');
        await trx('photos').insert({
          building_id: photo.typeIndex === null ? building.id : null,
          space_type_id: photo.typeIndex === null ? null : typeIds[photo.typeIndex],
          category: photo.category,
          file_id: file.id,
          sort_order: i,
          uploaded_by: listerId,
        });
      }

      // T5 checks the photos, contact and space types written above.
      await trx('buildings').where({ id: building.id }).update({ status: 'published', published_at: trx.fn.now() });
      if (spec.verified) {
        await trx('buildings').where({ id: building.id }).update({ verification_status: 'verified' });
      }
    });
    created += 1;
    console.log(`07_dev_catalogue: ${spec.name} (${plan.length} photos)`);
  }
  console.log(`07_dev_catalogue: ${created} new building(s); sign in as any @khunt.local user with password "${PASSWORD}"`);
}
