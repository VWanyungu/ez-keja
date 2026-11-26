import { describe, expect, it } from 'bun:test';
import { csvCell, toCsv } from './csv.js';
import { parseDateRange } from './date-range.js';
import { HttpError } from './http-error.js';

describe('csvCell (FR-RPT-002)', () => {
  it('prefixes a single quote to text that a spreadsheet would run as a formula', () => {
    for (const evil of ['=1+1', '+SUM(A1)', '-2+3', '@cmd', '\tx', '\rx']) {
      expect(csvCell(evil).replace(/^"|"$/g, '')).toBe(`'${evil}`);
    }
    expect(csvCell('=HYPERLINK("http://x","y")')).toBe(`"'=HYPERLINK(""http://x"",""y"")"`);
  });

  it('leaves ordinary text, numbers (even negative), dates and null alone', () => {
    expect(csvCell('Acacia Court')).toBe('Acacia Court');
    expect(csvCell('a=b')).toBe('a=b');
    expect(csvCell(-5)).toBe('-5');
    expect(csvCell(0.25)).toBe('0.25');
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
    expect(csvCell(new Date('2026-11-26T09:00:00Z'))).toBe('2026-11-26T09:00:00.000Z');
  });

  it('quotes commas, quotes and line breaks, and writes objects as JSON', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
    expect(csvCell({ a: 1 })).toBe('"{""a"":1}"');
  });
});

describe('toCsv', () => {
  it('writes a headers-only file for zero rows', () => {
    expect(toCsv(['a', 'b'], [])).toBe('a,b\r\n');
  });
  it('writes one CRLF line per row', () => {
    expect(toCsv(['a', 'b'], [[1, '=x'], [null, 'y']])).toBe("a,b\r\n1,'=x\r\n,y\r\n");
  });
});

describe('parseDateRange', () => {
  it('treats a plain `to` date as the whole UTC day (exclusive end is the next midnight)', () => {
    const r = parseDateRange({ from: '2026-11-01', to: '2026-11-30' });
    expect(r.from?.toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(r.toExclusive?.toISOString()).toBe('2026-12-01T00:00:00.000Z');
  });
  it('makes a timestamp `to` inclusive to the millisecond', () => {
    const r = parseDateRange({ to: '2026-11-30T10:00:00Z' });
    expect(r.from).toBeNull();
    expect(r.toExclusive?.toISOString()).toBe('2026-11-30T10:00:00.001Z');
  });
  it('accepts no range at all', () => {
    expect(parseDateRange({})).toEqual({ from: null, toExclusive: null });
  });
  it('rejects nonsense, impossible dates and a reversed range', () => {
    for (const bad of [{ from: 'yesterday' }, { from: '2026-02-31' }, { to: 5 }, { from: '2026-11-30', to: '2026-11-01' }, { from: '2026-11-01T10:00' }]) {
      expect(() => parseDateRange(bad as Record<string, unknown>)).toThrow(HttpError);
    }
  });
});
