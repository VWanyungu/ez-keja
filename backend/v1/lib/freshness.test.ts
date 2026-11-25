import { describe, expect, it } from 'bun:test';
import { freshnessOf, isoMicros, latestVacantUpdateSql, outdatedSql, summariseBuildingFreshness } from './freshness.js';
import { HttpError } from './http-error.js';
import { decodeCursor, encodeCursor, parseKeysetQuery } from './keyset.js';

describe('freshness helpers (BR-001, BR-030)', () => {
  it('labels only Vacant space types', () => {
    expect(freshnessOf(3, false)).toBe('fresh');
    expect(freshnessOf(3, true)).toBe('may_be_outdated');
    expect(freshnessOf(0, true)).toBe('not_applicable'); // Fully let: neither labelled nor reminded
  });

  it('builds a strict "more than freshness_days" predicate on the given alias', () => {
    const sql = outdatedSql('st', "'2026-03-08 10:00:00+00'::timestamptz");
    expect(sql).toContain("'2026-03-08 10:00:00+00'::timestamptz - st.last_confirmed_at > make_interval");
    expect(sql).toContain("key = 'freshness_days'");
    expect(sql).toContain('st.vacant_count > 0');
    expect(sql).toContain('st.removed_at IS NULL');
    expect(sql).not.toContain('>='); // exactly 7 days is not outdated
    expect(outdatedSql('st')).toContain('clock_timestamp()');
  });

  it('refuses an alias that is not a plain identifier', () => {
    expect(() => outdatedSql('st; DROP TABLE space_types')).toThrow();
    expect(() => latestVacantUpdateSql('st x')).toThrow();
    expect(latestVacantUpdateSql('st')).toBe(
      'max(st.last_confirmed_at) FILTER (WHERE st.vacant_count > 0 AND st.removed_at IS NULL)',
    );
  });

  it('formats a column as ISO text with microseconds', () => {
    expect(isoMicros('st.last_confirmed_at')).toContain('HH24:MI:SS.US');
    expect(isoMicros('st.last_confirmed_at')).toContain("AT TIME ZONE 'UTC'");
  });

  describe('building freshness (BR-030, Q-D4)', () => {
    const t = (vacantCount: number, lastConfirmedAt: string, outdated: boolean) => ({ vacantCount, lastConfirmedAt, outdated });

    it('uses the latest update among Vacant space types only', () => {
      expect(
        summariseBuildingFreshness([
          t(2, '2026-03-01T10:00:00.000000Z', true),
          t(0, '2026-03-20T10:00:00.000000Z', false), // Fully let and recent: ignored
        ]),
      ).toEqual({ state: 'may_be_outdated', latestUpdate: '2026-03-01T10:00:00.000000Z' });
    });

    it('is fresh when any Vacant space type is fresh, and compares microseconds', () => {
      expect(
        summariseBuildingFreshness([
          t(1, '2026-03-01T10:00:00.000001Z', true),
          t(1, '2026-03-01T10:00:00.000002Z', false),
        ]),
      ).toEqual({ state: 'fresh', latestUpdate: '2026-03-01T10:00:00.000002Z' });
    });

    it('has nothing to report when no space type is Vacant', () => {
      expect(summariseBuildingFreshness([])).toEqual({ state: 'not_applicable', latestUpdate: null });
      expect(summariseBuildingFreshness([t(0, '2026-03-01T10:00:00.000000Z', false)])).toEqual({
        state: 'not_applicable',
        latestUpdate: null,
      });
    });
  });
});

describe('keyset pagination helpers (design §7.4)', () => {
  const id = '019363c8-1234-7000-8000-0000000000a1';

  it('round-trips a cursor with microseconds intact', () => {
    const cursor = { t: '2026-11-25 16:58:01.123456+00', id };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it('rejects a cursor that is not ours', () => {
    for (const bad of ['garbage', encodeCursor({ t: 'not a time', id }), encodeCursor({ t: '2026-11-25 16:58:01+00', id: 'x' })]) {
      expect(() => decodeCursor(bad)).toThrow(HttpError);
    }
  });

  it('parses limit and cursor with defaults and a ceiling', () => {
    expect(parseKeysetQuery({})).toEqual({ limit: 25, cursor: null });
    expect(parseKeysetQuery({ limit: '50' }).limit).toBe(50);
    expect(parseKeysetQuery({ limit: '100' }).limit).toBe(100);
    for (const limit of ['0', '101', '2.5', '-1', 'abc']) {
      expect(() => parseKeysetQuery({ limit })).toThrow(HttpError);
    }
    expect(() => parseKeysetQuery({ cursor: '' })).toThrow(HttpError);
    expect(() => parseKeysetQuery({ cursor: ['a'] })).toThrow(HttpError);
  });
});
