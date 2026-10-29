/**
 * Reporting days are US Eastern days, everywhere: range bounds, daily buckets
 * and labels. A UTC day boundary falls at 7–8pm Eastern, which used to push an
 * evening's sends and replies into the next day's bucket.
 */
export const REPORT_TIMEZONE = 'America/New_York';

const partsFormatter = (timeZone: string) =>
  new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

/** Offset (ms) of `timeZone` from UTC at instant `at`: local wall clock − UTC. */
function zoneOffsetMs(at: Date, timeZone: string): number {
  const p = Object.fromEntries(partsFormatter(timeZone).formatToParts(at).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute), Number(p.second));
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** The UTC instant of 00:00 on `ymd` (YYYY-MM-DD) in `timeZone`. DST-safe. */
export function zonedMidnight(ymd: string, timeZone: string = REPORT_TIMEZONE): Date {
  const [y, m, d] = ymd.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d);
  let t = guess - zoneOffsetMs(new Date(guess), timeZone);
  // Re-evaluate at the candidate in case a DST change sits between the two.
  t = guess - zoneOffsetMs(new Date(t), timeZone);
  return new Date(t);
}

/** YYYY-MM-DD of instant `at` in `timeZone`. */
export function zonedDay(at: Date, timeZone: string = REPORT_TIMEZONE): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

/** Add whole calendar days to a YYYY-MM-DD string. */
export function addDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}
