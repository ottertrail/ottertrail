/** Show times in the instance timezone with milliseconds to distinguish nearby spans and logs. */

const decimals = (value: number, places: number) =>
  new Intl.NumberFormat("en-US", { maximumFractionDigits: places }).format(value);

const rounded = (value: number, places: number) => Math.round(value * 10 ** places) / 10 ** places;

/** Choose units after rounding so 999.7 µs becomes 1 ms and 119.6 s becomes 2 min. */
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
  // Round seconds before splitting to keep the remainder between 0 and 59.
  const total = Math.round(s);
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} s`;
}

export const formatOffset = (us: number) => `+${formatDuration(us)}`;

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
