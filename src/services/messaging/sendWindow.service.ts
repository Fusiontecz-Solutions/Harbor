/**
 * Recurring times of day that broadcasts may be scheduled into.
 *
 * Harbor's operators send in three daily pushes — 10:00, 13:30 and 16:30
 * Eastern. Those could have been constants, but a send time is an operational
 * decision, not a property of the code: it moves for a holiday, a carrier
 * complaint, or simply because afternoons stopped converting. So the windows
 * are rows, seeded with those three and editable from the UI.
 *
 * They are stored as a LOCAL time plus an IANA zone rather than a UTC offset.
 * "16:30 America/New_York" is 20:30 UTC in winter and 20:30 UTC minus an hour
 * in summer; storing the offset would silently shift every campaign by an hour
 * twice a year, which is exactly the kind of bug nobody notices until a blast
 * goes out at 5:30pm.
 */
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import prisma from '../../config/prismaClient';

/** What a fresh install gets, matching how the desk already works. */
const DEFAULT_WINDOWS: Array<{ label: string; timeOfDay: string; sortOrder: number }> = [
  { label: 'Morning', timeOfDay: '10:00', sortOrder: 0 },
  { label: 'Midday', timeOfDay: '13:30', sortOrder: 1 },
  { label: 'Afternoon', timeOfDay: '16:30', sortOrder: 2 },
];

export const DEFAULT_TIMEZONE = 'America/New_York';

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isValidTimeOfDay(value: unknown): boolean {
  return TIME_PATTERN.test(String(value ?? ''));
}

/**
 * Create the three default windows if none exist.
 *
 * Idempotent and safe to call on every boot: it only writes when the table is
 * empty, so an operator who deletes a window does not get it recreated under
 * them on the next deploy.
 */
export async function ensureDefaultSendWindows(): Promise<void> {
  const existing = await prisma.messagingSendWindow.count();
  if (existing > 0) return;

  await prisma.messagingSendWindow.createMany({
    data: DEFAULT_WINDOWS.map((window) => ({ ...window, timezone: DEFAULT_TIMEZONE })),
    skipDuplicates: true,
  });

  console.log('[messaging:windows] seeded default send windows (10:00, 13:30, 16:30 ET)');
}

export async function listSendWindows() {
  return prisma.messagingSendWindow.findMany({
    orderBy: [{ sortOrder: 'asc' }, { timeOfDay: 'asc' }],
  });
}

export async function upsertSendWindow(input: {
  id?: string;
  label?: string | null;
  timeOfDay: string;
  timezone?: string;
  isActive?: boolean;
  sortOrder?: number;
}) {
  const timeOfDay = String(input.timeOfDay || '').trim();
  if (!isValidTimeOfDay(timeOfDay)) {
    throw new Error(`"${input.timeOfDay}" is not a 24-hour time of day (expected HH:MM)`);
  }

  const timezone = String(input.timezone || DEFAULT_TIMEZONE).trim();
  // Reject an unknown zone here rather than letting every later scheduling
  // call throw on a row nobody can fix from the UI.
  try {
    formatInTimeZone(new Date(), timezone, 'HH:mm');
  } catch {
    throw new Error(`"${timezone}" is not a recognized time zone`);
  }

  const data = {
    label: input.label?.trim() || null,
    timeOfDay,
    timezone,
    isActive: input.isActive ?? true,
    sortOrder: input.sortOrder ?? 0,
  };

  if (input.id) {
    return prisma.messagingSendWindow.update({ where: { id: input.id }, data });
  }

  return prisma.messagingSendWindow.upsert({
    where: { timeOfDay_timezone: { timeOfDay, timezone } },
    create: data,
    update: { label: data.label, isActive: data.isActive, sortOrder: data.sortOrder },
  });
}

export async function deleteSendWindow(id: string): Promise<void> {
  await prisma.messagingSendWindow.delete({ where: { id } });
}

/**
 * The next time this window comes round, as a UTC instant.
 *
 * `after` defaults to now. A window whose time has already passed today
 * resolves to tomorrow, so picking "10:00" at 11am schedules for the following
 * morning rather than immediately.
 */
export function nextOccurrence(
  window: { timeOfDay: string; timezone: string },
  after: Date = new Date(),
): Date {
  const [hours, minutes] = window.timeOfDay.split(':');

  for (let dayOffset = 0; dayOffset <= 1; dayOffset += 1) {
    const probe = new Date(after.getTime() + dayOffset * 24 * 60 * 60 * 1000);
    const localDate = formatInTimeZone(probe, window.timezone, 'yyyy-MM-dd');
    // fromZonedTime reads the wall-clock string in that zone and returns the
    // matching UTC instant, applying whichever DST offset is in force that day.
    const candidate = fromZonedTime(`${localDate} ${hours}:${minutes}:00`, window.timezone);
    if (candidate.getTime() > after.getTime()) return candidate;
  }

  // Unreachable in practice: one of today or tomorrow is always in the future.
  return new Date(after.getTime() + 24 * 60 * 60 * 1000);
}

/** Active windows with their next occurrence resolved, for the scheduling picker. */
export async function listUpcomingSendWindows(after: Date = new Date()) {
  const windows = await prisma.messagingSendWindow.findMany({
    where: { isActive: true },
    orderBy: [{ sortOrder: 'asc' }, { timeOfDay: 'asc' }],
  });

  return windows
    .map((window) => ({
      id: window.id,
      label: window.label,
      timeOfDay: window.timeOfDay,
      timezone: window.timezone,
      nextOccurrence: nextOccurrence(window, after),
    }))
    .sort((a, b) => a.nextOccurrence.getTime() - b.nextOccurrence.getTime());
}

/** Resolve a window id to the instant a broadcast scheduled into it should send. */
export async function resolveWindowToInstant(
  sendWindowId: string,
  after: Date = new Date(),
): Promise<Date> {
  const window = await prisma.messagingSendWindow.findUnique({ where: { id: sendWindowId } });
  if (!window) throw new Error('Send window not found');
  if (!window.isActive) throw new Error(`Send window ${window.timeOfDay} is not active`);
  return nextOccurrence(window, after);
}
