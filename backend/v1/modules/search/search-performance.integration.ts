/**
 * NFR-PRF-01 and the index policy (design 7.3, 11.1). Loads 12,000 published buildings (1,200 in
 * the searched area, the planning ceiling per area) with 1 to 3 space types each, then explains the
 * very SQL the search endpoint runs. The rows are removed again afterwards.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import db from '../../db/knex.js';
import { call, makeArea, referenceData, register, startApp, stopApp, type Account } from './search-fixtures.js';
import { parseSearchQuery } from './schemas.js';
import { buildSearchQuery } from './service.js';

setDefaultTimeout(180_000);

const PREFIX = 'PerfSeed';
const TARGET_BUILDINGS = 1200;
const TOTAL_BUILDINGS = 12_000;
const OTHER_AREAS = 9;

let lister: Account;
let areaId: string;
let ref: Awaited<ReturnType<typeof referenceData>>;
const otherAreaIds: string[] = [];

beforeAll(async () => {
  await startApp();
  lister = await register('p7perf-lister@example.com', 'landlord', '+254700300001');
  ref = await referenceData();
  areaId = await makeArea('Perf Target Area');
  for (let i = 0; i < OTHER_AREAS; i += 1) otherAreaIds.push(await makeArea(`Perf Other ${i}`));

  await db.raw(
    `INSERT INTO buildings (name, area_id, latitude, longitude, management_type, landlord_user_id, lister_id, created_by)
     SELECT ?::text || ' ' || i,
            CASE WHEN i <= ? THEN ?::uuid ELSE (?::uuid[])[1 + (i % ?)] END,
            -1.3 + (i % 100) * 0.0001, 36.8 + (i % 97) * 0.0001, 'landlord', ?::uuid, ?::uuid, ?::uuid
     FROM generate_series(1, ?) AS i`,
    [PREFIX, TARGET_BUILDINGS, areaId, `{${otherAreaIds.join(',')}}`, OTHER_AREAS, lister.id, lister.id, lister.id, TOTAL_BUILDINGS],
  );
  await db.raw(
    `INSERT INTO building_maintainers (building_id, user_id, added_by)
     SELECT id, ?::uuid, ?::uuid FROM buildings WHERE name LIKE ?`,
    [lister.id, lister.id, `${PREFIX} %`],
  );
  await db.raw(
    `INSERT INTO space_types (building_id, name, category_id, rent_mode, currency_id, rent_amount, deposit_amount,
                             vacant_count, last_confirmed_at, created_by)
     SELECT b.id, 'T' || g, CASE WHEN g % 2 = 0 THEN ?::uuid ELSE ?::uuid END, 'fixed',
            CASE WHEN g % 3 = 0 THEN ?::uuid ELSE ?::uuid END, 5000 + (abs(hashtext(b.id::text || g)) % 60) * 500, 10000,
            abs(hashtext(g || b.id::text)) % 4, now() - (random() * 20) * interval '1 day', ?::uuid
     FROM buildings b
     CROSS JOIN LATERAL generate_series(1, 1 + (abs(hashtext(b.id::text)) % 3)) AS g
     WHERE b.name LIKE ?`,
    [ref.categoryA, ref.categoryB, ref.usd, ref.kes, lister.id, `${PREFIX} %`],
  );
  await db.raw(
    `UPDATE buildings SET status = 'published', published_at = now(), contact_user_id = ?::uuid WHERE name LIKE ?`,
    [lister.id, `${PREFIX} %`],
  );
  await db.raw('ANALYZE buildings, space_types, building_maintainers, profiles, areas');
});

afterAll(async () => {
  // buildings.contact_user_id and building_maintainers point at each other (RESTRICT): let go first.
  const mine = `(SELECT id FROM buildings WHERE name LIKE ?)`;
  await db.raw(`UPDATE buildings SET status = 'draft', published_at = NULL, contact_user_id = NULL WHERE name LIKE ?`, [`${PREFIX} %`]);
  await db.raw(`DELETE FROM space_types WHERE building_id IN ${mine}`, [`${PREFIX} %`]);
  await db.raw(`DELETE FROM building_maintainers WHERE building_id IN ${mine}`, [`${PREFIX} %`]);
  await db.raw('DELETE FROM buildings WHERE name LIKE ?', [`${PREFIX} %`]);
  await db('areas').whereIn('id', [areaId, ...otherAreaIds]).del();
  await stopApp();
});

interface PlanNode {
  'Node Type': string;
  'Index Name'?: string;
  Plans?: PlanNode[];
}

async function explain(query: Record<string, string>) {
  const { sql, bindings } = buildSearchQuery(parseSearchQuery(query));
  const result = await db.raw(`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`, bindings);
  const root = result.rows[0]['QUERY PLAN'][0] as { Plan: PlanNode; 'Execution Time': number; 'Planning Time': number };
  const indexes = new Set<string>();
  const walk = (node: PlanNode) => {
    if (node['Index Name']) indexes.add(node['Index Name']);
    node.Plans?.forEach(walk);
  };
  walk(root.Plan);
  return { indexes, executionMs: root['Execution Time'], planningMs: root['Planning Time'] };
}

describe('Search performance (NFR-PRF-01)', () => {
  it('has the expected volume', async () => {
    const inArea = await db('buildings').where({ area_id: areaId, status: 'published' }).count({ n: '*' }).first();
    expect(Number(inArea!.n)).toBe(TARGET_BUILDINGS);
    const total = await db('buildings').where('name', 'like', `${PREFIX} %`).count({ n: '*' }).first();
    expect(Number(total!.n)).toBe(TOTAL_BUILDINGS);
  });

  it('runs QP-01 on the partial indexes, well inside a second', async () => {
    const plain = await explain({ areaId });
    console.log(`[perf] QP-01 area search over ${TARGET_BUILDINGS} buildings: execution ${plain.executionMs.toFixed(1)} ms, planning ${plain.planningMs.toFixed(1)} ms, indexes ${[...plain.indexes].join(', ')}`);
    expect(plain.indexes.has('ix_buildings_area_published')).toBe(true);
    expect(plain.indexes.has('ix_space_types_building_vacant')).toBe(true);
    expect(plain.executionMs).toBeLessThan(500);

    const filtered = await explain({ areaId, categoryId: ref.categoryA, currencyId: ref.kes, rentMin: '6000', rentMax: '30000', includeRentOnInterest: 'true', sort: 'rent_asc' });
    console.log(`[perf] QP-01 with category, rent and rent sort: execution ${filtered.executionMs.toFixed(1)} ms`);
    expect(filtered.indexes.has('ix_space_types_building_vacant')).toBe(true);
    expect(filtered.executionMs).toBeLessThan(500);
  });

  it('serves a whole result page over HTTP in under a second, keyset-paged through the full area', async () => {
    const started = performance.now();
    const first = await call('GET', `/search/buildings?areaId=${areaId}&limit=20`, null);
    const elapsed = performance.now() - started;
    console.log(`[perf] GET /search/buildings (20 cards, cold) took ${elapsed.toFixed(0)} ms`);
    expect(first.status).toBe(200);
    expect(first.body.data.items).toHaveLength(20);
    expect(elapsed).toBeLessThan(1000);

    // Walk every page: all matching buildings exactly once.
    const seen = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res = await call('GET', `/search/buildings?areaId=${areaId}&limit=50${cursor ? `&cursor=${cursor}` : ''}`, null);
      for (const item of res.body.data.items) seen.add(item.id);
      cursor = res.body.data.nextCursor;
      pages += 1;
    } while (cursor && pages < 100);
    const expected = await db.raw(
      `SELECT count(*)::int AS n FROM buildings b WHERE b.area_id = ? AND b.status = 'published'
         AND EXISTS (SELECT 1 FROM space_types s WHERE s.building_id = b.id AND s.vacant_count > 0 AND s.removed_at IS NULL)`,
      [areaId],
    );
    expect(seen.size).toBe(expected.rows[0].n);
  });

  it('leaves no foreign key without an index (design 7.3, rule 1)', async () => {
    const result = await db.raw(
      `SELECT c.conrelid::regclass::text AS table_name, c.conname
       FROM pg_constraint c
       WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace
         AND NOT EXISTS (
           SELECT 1 FROM pg_index i
           WHERE i.indrelid = c.conrelid AND i.indkey[0] = c.conkey[1]
         )`,
    );
    expect(result.rows).toEqual([]);
  });
});
