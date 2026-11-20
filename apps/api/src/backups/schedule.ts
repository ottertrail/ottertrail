/**
 * When the daily backup is due (docs/deployment.md, "Backups"): at a time
 * of day the owner picks, in the instance's timezone, so it follows
 * daylight saving time with the instance's reports.
 *
 * - A time that a spring-forward change skips (02:30 when clocks jump from
 *   02:00 to 03:00) runs the gap's length later, at 03:30.
 * - A time that a fall-back change repeats (01:30 twice) runs once, at the
 *   first.
 */

/** A daily time: its local day ("YYYY-MM-DD") and the moment it falls on. */
export interface Slot {
  day: string;
  at: Date;
}

const formats = new Map<string, Intl.DateTimeFormat>();

function formatOf(timeZone: string): Intl.DateTimeFormat {
  let format = formats.get(timeZone);
  if (format === undefined) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formats.set(timeZone, format);
  }
  return format;
}

/** The wall clock in `timeZone` at `ms`, as the UTC milliseconds of the same wall time. */
function wallOf(ms: number, timeZone: string): number {
  const parts = Object.fromEntries(
    formatOf(timeZone)
      .formatToParts(ms)
      .map((part) => [part.type, part.value]),
  );
  return Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
}

/** The local day of `moment` in `timeZone`, "YYYY-MM-DD". */
export function localDay(moment: Date, timeZone: string): string {
  return new Date(wallOf(moment.getTime(), timeZone)).toISOString().slice(0, 10);
}

/** The day `days` after (or before, when negative) a "YYYY-MM-DD" day. */
export function addDays(day: string, days: number): string {
  const [year = 0, month = 1, date = 1] = day.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, date + days)).toISOString().slice(0, 10);
}

/** The moment `timeOfDay` ("HH:MM") falls on, on local `day` in `timeZone`. */
export function slotOn(day: string, timeOfDay: string, timeZone: string): Date {
  const [year = 0, month = 1, date = 1] = day.split("-").map(Number);
  const [hour = 0, minute = 0] = timeOfDay.split(":").map(Number);
  const wall = Date.UTC(year, month - 1, date, hour, minute);
  // The offsets a day either side: a change of offset lies between them, if any.
  const before = wallOf(wall - 86_400_000, timeZone) - (wall - 86_400_000);
  const after = wallOf(wall + 86_400_000, timeZone) - (wall + 86_400_000);
  const candidates = [wall - before, wall - after]
    .filter((ms) => wallOf(ms, timeZone) === wall)
    .toSorted((a, b) => a - b);
  // In a gap, neither shows the wall time: the old offset lands the gap's length later.
  return new Date(candidates[0] ?? wall - before);
}

/** The latest daily time at or before `now`. */
export function latestSlot(now: Date, timeOfDay: string, timeZone: string): Slot {
  const today = localDay(now, timeZone);
  const at = slotOn(today, timeOfDay, timeZone);
  if (at.getTime() <= now.getTime()) return { day: today, at };
  const yesterday = addDays(today, -1);
  return { day: yesterday, at: slotOn(yesterday, timeOfDay, timeZone) };
}

/** The first daily time after `now`. */
export function nextSlot(now: Date, timeOfDay: string, timeZone: string): Slot {
  const latest = latestSlot(now, timeOfDay, timeZone);
  const day = addDays(latest.day, 1);
  return { day, at: slotOn(day, timeOfDay, timeZone) };
}

export interface ScheduleState {
  enabled: boolean;
  timeOfDay: string;
  /** Daily times before this are not due (when backups were turned on or the time changed). */
  scheduleFrom: Date | null;
  /** The local day of the last daily time taken. */
  lastSlot: string | null;
}

/** The daily time due now, not yet taken; null when none is. */
export function dueSlot(now: Date, state: ScheduleState, timeZone: string): Slot | null {
  if (!state.enabled) return null;
  const slot = latestSlot(now, state.timeOfDay, timeZone);
  if (state.scheduleFrom !== null && slot.at.getTime() < state.scheduleFrom.getTime()) return null;
  if (state.lastSlot === slot.day) return null;
  return slot;
}

/** When the next scheduled backup runs: its time, past when one is due now; null when off. */
export function nextDue(now: Date, state: ScheduleState, timeZone: string): Date | null {
  if (!state.enabled) return null;
  const due = dueSlot(now, state, timeZone);
  if (due !== null) return due.at;
  return nextSlot(now, state.timeOfDay, timeZone).at;
}

/** How long after its daily time a backup that has not succeeded counts as overdue. */
export const OVERDUE_AFTER_MS = 3 * 60 * 60 * 1000;

/**
 * The daily time whose backup is overdue: past by OVERDUE_AFTER_MS, due
 * (not before backups were turned on), and with no backup that succeeded
 * since it started. Null when none is.
 */
export function overdueSlot(
  now: Date,
  state: ScheduleState,
  timeZone: string,
  lastSuccessStartedAt: Date | null,
): Slot | null {
  if (!state.enabled) return null;
  const slot = latestSlot(new Date(now.getTime() - OVERDUE_AFTER_MS), state.timeOfDay, timeZone);
  if (state.scheduleFrom !== null && slot.at.getTime() < state.scheduleFrom.getTime()) return null;
  if (lastSuccessStartedAt !== null && lastSuccessStartedAt.getTime() >= slot.at.getTime()) {
    return null;
  }
  return slot;
}
