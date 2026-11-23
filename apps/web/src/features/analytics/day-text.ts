import { isDay } from "@/lib/analytics-api";

export const DAY_PLACEHOLDER = "DD/MM/YYYY";
export const DAY_TEXT_LENGTH = DAY_PLACEHOLDER.length;

const nonDigits = /\D/g;

/** Keep up to 8 digits, add date separators, and preserve the cursor position among the digits. */
export function maskDay(raw: string, cursor: number): { text: string; cursor: number } {
  const digits = raw.replaceAll(nonDigits, "").slice(0, 8);
  const text = [digits.slice(0, 2), digits.slice(2, 4), digits.slice(4, 8)]
    .filter((part) => part !== "")
    .join("/");
  const digitsBefore = Math.min(
    raw.slice(0, cursor).replaceAll(nonDigits, "").length,
    digits.length,
  );
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

/** The calendar uses local midnight. */
export function dateOf(day: string): Date | undefined {
  if (!isDay(day)) return undefined;
  const [year = 0, month = 1, date = 1] = day.split("-").map(Number);
  return new Date(year, month - 1, date);
}

const pad = (value: number) => String(value).padStart(2, "0");

export function dayOf(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
