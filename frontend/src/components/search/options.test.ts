import { describe, expect, it } from 'vitest';
import { countActiveFilters } from './options';

describe('countActiveFilters', () => {
  it('counts area, category, maxRent, management and verifiedOnly while ignoring q and sort', () => {
    expect(countActiveFilters({})).toBe(0);
    expect(countActiveFilters({ q: 'Ngong', sort: 'rent_asc' })).toBe(0);
    expect(
      countActiveFilters({
        q: 'Ngong',
        sort: 'rent_desc',
        areaId: 'a1',
        categoryId: 'c1',
        maxRent: 10000,
        management: 'agent',
        verifiedOnly: true,
      }),
    ).toBe(5);
  });
});
