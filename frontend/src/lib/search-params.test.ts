import { describe, expect, it } from 'vitest';
import { filtersFromParams, filtersToParams, toApiQuery } from './search-params';

describe('filtersFromParams', () => {
  it('reads every filter', () => {
    const params = new URLSearchParams('areaId=a1&categoryId=c1&maxRent=10000&management=agent&verifiedOnly=true&sort=rent_asc');
    expect(filtersFromParams(params)).toEqual({
      areaId: 'a1',
      categoryId: 'c1',
      maxRent: 10000,
      management: 'agent',
      verifiedOnly: true,
      sort: 'rent_asc',
    });
  });

  it('drops updated (default) and invalid sort values from URL filters', () => {
    expect(filtersFromParams(new URLSearchParams('sort=updated'))).toEqual({});
    expect(filtersFromParams(new URLSearchParams('sort=cheapest'))).toEqual({});
  });

  it('reads the text query trimmed and capped at the length the API accepts', () => {
    expect(filtersFromParams(new URLSearchParams({ q: '  Ngong Hills ' }))).toEqual({ q: 'Ngong Hills' });
    expect(filtersFromParams(new URLSearchParams({ q: 'x'.repeat(150) })).q).toHaveLength(100);
    expect(filtersFromParams(new URLSearchParams({ q: '   ' }))).toEqual({});
  });

  it('drops values that do not parse', () => {
    const params = new URLSearchParams('maxRent=lots&management=squatter&verifiedOnly=yes&areaId=');
    expect(filtersFromParams(params)).toEqual({});
  });

  it('round-trips through the URL', () => {
    const filters = { areaId: 'a1', maxRent: 25000, verifiedOnly: true };
    expect(filtersFromParams(filtersToParams(filters))).toEqual(filters);
  });
});

describe('toApiQuery', () => {
  it('asks for a page and carries the cursor', () => {
    expect(toApiQuery({}, { limit: 8, cursor: 'abc' })).toBe('limit=8&cursor=abc');
  });

  it('sends the text query as q', () => {
    expect(new URLSearchParams(toApiQuery({ q: 'zebra court' }, { limit: 9 })).get('q')).toBe('zebra court');
  });

  it('turns max rent into a currency-scoped rentMax', () => {
    const query = new URLSearchParams(toApiQuery({ maxRent: 10000 }, { currencyId: 'kes', limit: 8 }));
    expect(query.get('rentMax')).toBe('10000');
    expect(query.get('currencyId')).toBe('kes');
    expect(query.has('maxRent')).toBe(false);
  });

  it('leaves the rent filter out when the currency is not known yet', () => {
    const query = new URLSearchParams(toApiQuery({ maxRent: 10000 }, { limit: 8 }));
    expect(query.has('rentMax')).toBe(false);
    expect(query.has('currencyId')).toBe(false);
  });

  it('sends currencyId with rent sorting and omits rent sorting until currencyId is known', () => {
    const ready = new URLSearchParams(toApiQuery({ sort: 'rent_asc' }, { currencyId: 'kes', limit: 12 }));
    expect(ready.get('sort')).toBe('rent_asc');
    expect(ready.get('currencyId')).toBe('kes');

    const pending = new URLSearchParams(toApiQuery({ sort: 'rent_desc' }, { limit: 12 }));
    expect(pending.has('sort')).toBe(false);
    expect(pending.has('currencyId')).toBe(false);
  });
});
