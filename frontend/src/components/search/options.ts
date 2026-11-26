/** Sentinel for "no filter": Radix Select cannot hold an empty-string value. */
export const ANY = 'any';

/** Quick-filter chips, in the order of the design. `code` is the space category's code. */
export const QUICK_FILTERS = [
  { code: 'bedsitter', label: 'Bedsitter' },
  { code: 'one_bedroom', label: '1 bedroom' },
  { code: 'two_bedroom', label: '2 bedrooms' },
  { code: 'three_bedroom', label: '3+ bedrooms' },
  { code: 'office', label: 'Office' },
  { code: 'shop', label: 'Shop' },
  { code: 'warehouse', label: 'Warehouse' },
] as const;

/** The bedroom field and the house type field both narrow to one space category. */
export const BEDROOM_FILTERS = QUICK_FILTERS.slice(0, 4);

/** Max rent steps in KES. */
export const RENT_STEPS = [5_000, 10_000, 20_000, 30_000, 50_000, 100_000];

export const formatKes = (amount: number) => `KES ${amount.toLocaleString('en-US')}`;
