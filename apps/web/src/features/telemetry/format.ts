/**
 * Durations and times on the Traces and Logs pages: durations in µs, ms,
 * or s as their size needs; times in the organization's timezone, to the
 * millisecond, since a trace's spans and logs are milliseconds apart.
 */

const decimals = (value: number, places: number) =>
  new Intl.NumberFormat("en-US", { maximumFractionDigits: places }).format(value);

/** A number rounded to `places` decimals, as it will be shown. */
const rounded = (value: number, places: number) => Math.round(value * 10 ** places) / 10 ** places;

/**
 * "850 µs", "12.4 ms", "120 ms", "1.25 s", "2 min 5 s". Each step is chosen
 * by the value as rounded for it, so 999.7 µs is "1 ms", never "1,000 µs",
 * and 119.6 s is "2 min", never "1 min 60 s".
 */
export function formatDuration(us: number): string {
  if (us < 1) return us === 0 ? "0 µs" : "<1 µs";
  if (rounded(us, 0) < 1000) return `${decimals(us, 0)} µs`;
  const ms = us / 1000;
  if (rounded(ms, 2) < 10) return `${decimals(ms, 2)} ms`;
  if (rounded(ms, 1) < 100) return `${decimals(ms, 1)} ms`;
  if (rounded(ms, 0) < 1000) return `${decimals(ms, 0)} ms`;
  const s = ms / 1000;
  if (rounded(s, 2) < 10) return `${decimals(s, 2)} s`;
  if (rounded(s, 1) < 60) return `${decimals(s, 1)} s`;
  // Whole seconds first, then split: the rest is always 0 to 59.
  const total = Math.round(s);
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} s`;
}

/** "+12.4 ms": how long after the trace's start. */
export const formatOffset = (us: number) => `+${formatDuration(us)}`;

/** "16 Nov 2026, 10:05:03.123" */
export function formatPreciseMoment(iso: string, timeZone: string | undefined): string {
  const date = new Date(iso);
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? "";
  return `${part("day")} ${part("month")} ${part("year")}, ${part("hour")}:${part("minute")}:${part("second")}.${part("fractionalSecond")}`;
}
