/** Sentinel for "no filter": Radix Select cannot hold an empty-string value. */
export const ANY = 'any';

/** The bedroom field narrows to one space category; `code` is that category's code. */
export const BEDROOM_FILTERS = [
  { code: 'bedsitter', label: 'Bedsitter' },
  { code: 'one_bedroom', label: '1 bedroom' },
  { code: 'two_bedroom', label: '2 bedrooms' },
  { code: 'three_bedroom', label: '3+ bedrooms' },
] as const;

/** Max rent steps in KES. */
export const RENT_STEPS = [5_000, 10_000, 20_000, 30_000, 50_000, 100_000];

export const formatKes = (amount: number) => `KES ${amount.toLocaleString('en-US')}`;
