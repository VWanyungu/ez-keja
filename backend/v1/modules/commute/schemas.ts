import { badRequest } from '../../lib/http-error.js';
import { isUuid } from '../../lib/uuid.js';

export const COMMUTE_MODES = ['driving', 'transit', 'walking'] as const;
export type CommuteMode = (typeof COMMUTE_MODES)[number];

export const DESTINATION_MIN = 2;
export const DESTINATION_MAX = 200;

/** FR-CMT-003: now (default), or the next occurrence of a weekday and time, to depart or to arrive. */
export type CommuteTime = { basis: 'now' } | { basis: 'depart' | 'arrive'; atMs: number };

export interface CommuteQuery {
  buildingId: string;
  destination: string;
  modes: CommuteMode[];
  time: CommuteTime;
}

const DAYS: Record<string, number> = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6,
};

const EAT_OFFSET_MS = 3 * 3_600_000;
const DAY_MS = 86_400_000;

/**
 * The next time it is `weekday` (0 = Sunday) `hour:minute` in Nairobi, strictly after `nowMs`.
 * shortcut: Nairobi is a fixed UTC+3 (Kenya has no daylight saving), so no time-zone database is
 * used; revisit if the platform ever serves another zone.
 */
export function nextOccurrenceMs(weekday: number, hour: number, minute: number, nowMs: number): number {
  const local = new Date(nowMs + EAT_OFFSET_MS); // read with the UTC getters: they give Nairobi wall time
  const todayAtTime =
    Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), hour, minute) - EAT_OFFSET_MS;
  const candidate = todayAtTime + ((weekday - local.getUTCDay() + 7) % 7) * DAY_MS;
  return candidate > nowMs ? candidate : candidate + 7 * DAY_MS;
}

function parseChosenTime(value: string, nowMs: number): number {
  const match = /^([a-z]+)[ T@,]+(\d{1,2}):(\d{2})$/i.exec(value.trim());
  const weekday = match ? DAYS[match[1]!.toLowerCase()] : undefined;
  const hour = match ? Number(match[2]) : Number.NaN;
  const minute = match ? Number(match[3]) : Number.NaN;
  if (weekday === undefined || hour > 23 || minute > 59) {
    throw badRequest('Query "time" must be a weekday and a 24-hour time, for example "Monday 07:30".', {
      code: 'INVALID_TIME',
    });
  }
  return nextOccurrenceMs(weekday, hour, minute, nowMs);
}

function single(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value === '') throw badRequest(`Query "${name}" must be a single value.`);
  return value;
}

/** FR-CMT-001 to FR-CMT-003. The destination is user input: length-checked, no control characters. */
export function parseCommuteQuery(query: Record<string, unknown>, nowMs = Date.now()): CommuteQuery {
  for (const key of Object.keys(query)) {
    if (!['buildingId', 'destination', 'mode', 'when', 'time'].includes(key)) {
      throw badRequest(`Query "${key}" is not a commute parameter.`);
    }
  }

  const buildingId = single(query.buildingId, 'buildingId');
  if (!buildingId || !isUuid(buildingId)) throw badRequest('Query "buildingId" must be a valid UUID.');

  const destination = single(query.destination, 'destination')?.trim().replace(/\s+/g, ' ');
  if (
    !destination ||
    destination.length < DESTINATION_MIN ||
    destination.length > DESTINATION_MAX ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
    /[\u0000-\u001f\u007f]/.test(destination)
  ) {
    throw badRequest(
      `Query "destination" is required: ${DESTINATION_MIN} to ${DESTINATION_MAX} characters of plain text.`,
      { code: 'INVALID_DESTINATION' },
    );
  }

  const modeText = single(query.mode, 'mode');
  if (modeText !== undefined && !(COMMUTE_MODES as readonly string[]).includes(modeText)) {
    throw badRequest('Query "mode" must be "driving", "transit" or "walking".');
  }

  const whenText = single(query.when, 'when') ?? 'now';
  const timeText = single(query.time, 'time');
  if (whenText !== 'now' && whenText !== 'depart' && whenText !== 'arrive') {
    throw badRequest('Query "when" must be "now", "depart" or "arrive".');
  }
  let time: CommuteTime = { basis: 'now' };
  if (whenText === 'now') {
    if (timeText !== undefined) throw badRequest('Query "time" needs "when" set to "depart" or "arrive".');
  } else {
    if (timeText === undefined) throw badRequest(`Query "when=${whenText}" needs "time", for example "Monday 07:30".`);
    time = { basis: whenText, atMs: parseChosenTime(timeText, nowMs) };
  }

  return {
    buildingId,
    destination,
    modes: modeText ? [modeText as CommuteMode] : [...COMMUTE_MODES],
    time,
  };
}
