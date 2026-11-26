import { describe, expect, it } from 'vitest';
import { en, sw, type MessageKey } from './messages';
import { translate } from './translate';

describe('translate', () => {
  it('returns the message in the chosen language', () => {
    expect(translate('en', 'nav.login')).toBe('Log in');
    expect(translate('sw', 'nav.login')).toBe('Ingia');
  });

  it('fills placeholders and leaves unknown ones visible', () => {
    expect(translate('en', 'results.showingMany', { count: 8 })).toBe('Showing 8 buildings');
    expect(translate('sw', 'active.under', { amount: 'KES 10,000' })).toBe('Chini ya KES 10,000');
    expect(translate('en', 'results.showingMany')).toBe('Showing {count} buildings');
  });

  it('falls back to English when Kiswahili lacks a key, never a raw key', () => {
    const original = sw['nav.login'];
    delete sw['nav.login'];
    try {
      expect(translate('sw', 'nav.login')).toBe('Log in');
    } finally {
      sw['nav.login'] = original;
    }
  });

  it('keeps the same placeholders in every Kiswahili message as in its English source', () => {
    const slots = (text: string) => (text.match(/\{\w+\}/g) ?? []).sort().join();
    for (const key of Object.keys(sw) as MessageKey[]) {
      expect(slots(sw[key]!), key).toBe(slots(en[key]));
    }
  });
});
