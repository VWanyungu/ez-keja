import { describe, expect, it } from 'vitest';
import { pageItems, pageRange } from './pagination';

describe('pageItems', () => {
  it('lists every page when there are few', () => {
    expect(pageItems(1, 3, false)).toEqual([1, 2, 3]);
  });

  it('marks pages that are not fetched yet with a trailing gap', () => {
    expect(pageItems(1, 1, true)).toEqual([1, 'gap']);
    expect(pageItems(2, 3, true)).toEqual([1, 2, 3, 'gap']);
  });

  it('collapses distant pages around the current one', () => {
    expect(pageItems(5, 8, false)).toEqual([1, 'gap', 4, 5, 6, 'gap', 8]);
    expect(pageItems(1, 8, false)).toEqual([1, 2, 'gap', 8]);
  });
});

describe('pageRange', () => {
  it('numbers results across pages', () => {
    expect(pageRange(0, 9, 9)).toEqual({ from: 1, to: 9 });
    expect(pageRange(2, 9, 4)).toEqual({ from: 19, to: 22 });
  });
});
