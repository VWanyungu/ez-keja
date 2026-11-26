import type { Response } from 'express';

/**
 * CSV for the Admin exports (FR-RPT-002). RFC 4180 quoting, CRLF line ends, and spreadsheet
 * formula-injection neutralisation: a text cell that starts with `=`, `+`, `-`, `@`, a tab or a
 * carriage return gets a single quote in front, so Excel or Sheets shows it as text instead of
 * running it. Numbers, dates and null are never text, so a real `-5` stays a number.
 */
const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(value: unknown): string {
  let text: string;
  if (value === null || value === undefined) text = '';
  else if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  else if (value instanceof Date) text = value.toISOString();
  else if (typeof value === 'object') text = JSON.stringify(value);
  else {
    text = String(value);
    if (FORMULA_START.test(text)) text = `'${text}`;
  }
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** Header line plus one line per row; zero rows gives a headers-only file. */
export function toCsv(headers: readonly string[], rows: ReadonlyArray<readonly unknown[]>): string {
  return [headers, ...rows].map((line) => line.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

export function sendCsv(res: Response, filename: string, csv: string, extraHeaders: Record<string, string> = {}): Response {
  res.set({ 'content-disposition': `attachment; filename="${filename}"`, ...extraHeaders });
  return res.type('text/csv; charset=utf-8').send(csv);
}
