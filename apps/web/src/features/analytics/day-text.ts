import { isDay } from "@/lib/analytics-api";

/**
 * Days are typed day first, as the dashboard writes them ("10 Nov 2026").
 * The field takes digits only and puts the slashes in itself, so "08112026"
 * becomes "08/11/2026" (maskDay).
 */
export const DAY_PLACEHOLDER = "DD/MM/YYYY";
export const DAY_TEXT_LENGTH = DAY_PLACEHOLDER.length;

const nonDigits = /\D/g;

/**
 * A day field's text after an edit, and where its cursor goes: the digits
 * typed so far (8 at most), with a slash after the day and the month. The
 * cursor stays after the same digits as before, so typing or deleting in
 * the middle works as in any field. Anything but digits is dropped, a
 * typed slash included: the field adds its own.
 */
export function maskDay(raw: string, cursor: number): { text: string; cursor: number } {
  const digits = raw.replaceAll(nonDigits, "").slice(0, 8);
  const text = [digits.slice(0, 2), digits.slice(2, 4), digits.slice(4, 8)]
    .filter((part) => part !== "")
    .join("/");
  const digitsBefore = Math.min(
    raw.slice(0, cursor).replaceAll(nonDigits, "").length,
    digits.length,
  );
  // Just after that many digits.
  let position = 0;
  for (let seen = 0; seen < digitsBefore; position += 1) {
    if (text[position] !== "/") seen += 1;
  }
  return { text, cursor: position };
}

/** "2026-11-08" as typed: "08/11/2026". */
export function dayText(day: string): string {
  const [year, month, date] = day.split("-");
  return isDay(day) ? `${date}/${month}/${year}` : "";
}

/** "08/11/2026" as "2026-11-08", or null when it is not a whole, real day. */
export function dayFromText(text: string): string | null {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text);
  if (match === null) return null;
  const [, date, month, year] = match;
  const day = `${year}-${month}-${date}`;
  return isDay(day) ? day : null;
}

/** A calendar day as the calendar holds it: midnight of that day, local time. */
export function dateOf(day: string): Date | undefined {
  if (!isDay(day)) return undefined;
  const [year = 0, month = 1, date = 1] = day.split("-").map(Number);
  return new Date(year, month - 1, date);
}

const pad = (value: number) => String(value).padStart(2, "0");

/** A day the calendar picked as "YYYY-MM-DD". */
export function dayOf(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
