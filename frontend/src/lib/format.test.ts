import { describe, expect, it } from 'vitest';
import { formatRent, formatUpdated } from './format';

const range = (min: number, max: number, currencyCode = 'KES') => ({ currencyId: currencyCode, currencyCode, min, max });

describe('formatRent', () => {
  it('shows a range, or one figure when min equals max', () => {
    expect(formatRent({ ranges: [range(7000, 9500)], rentOnInterest: false })).toBe('KES 7,000 – 9,500');
    expect(formatRent({ ranges: [range(18000, 18000)], rentOnInterest: false })).toBe('KES 18,000');
  });

  it('lists one range per currency', () => {
    expect(formatRent({ ranges: [range(7000, 9500), range(100, 200, 'USD')], rentOnInterest: false })).toBe(
      'KES 7,000 – 9,500 · USD 100 – 200',
    );
  });

  it('is empty when the rent is on interest', () => {
    expect(formatRent({ ranges: [], rentOnInterest: true })).toBe('');
  });
});

describe('formatUpdated', () => {
  const now = new Date('2026-11-26T12:00:00.000Z');

  it('counts whole days', () => {
    expect(formatUpdated('2026-11-26T08:00:00.123456Z', now)).toBe('Updated today');
    expect(formatUpdated('2026-11-25T08:00:00.000000Z', now)).toBe('Updated 1 day ago');
    expect(formatUpdated('2026-11-10T08:00:00.000000Z', now)).toBe('Updated 16 days ago');
  });

  it('is empty without a usable date', () => {
    expect(formatUpdated(null, now)).toBe('');
    expect(formatUpdated('not a date', now)).toBe('');
  });
});
