/** Time buckets on the Metrics page's charts: axis ticks, and buckets' labels in the organization's timezone. */

/** About `count` ticks covering lo..hi (always 0), on steps of 1, 2, or 5 times a power of ten. */
export function ticksFor(lo: number, hi: number, count = 4): number[] {
  const low = Math.min(0, lo);
  let high = Math.max(0, hi);
  if (high === low) high = low + 1;
  const raw = (high - low) / count;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * magnitude).find((s) => s >= raw) ?? 10 * magnitude;
  const ticks: number[] = [];
  for (let k = Math.floor(low / step); ; k += 1) {
    const tick = Number((k * step).toPrecision(12));
    ticks.push(tick);
    if (tick >= high) break;
  }
  return ticks;
}

function parts(date: Date, timeZone: string, options: Intl.DateTimeFormatOptions) {
  const list = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hourCycle: "h23",
    ...options,
  }).formatToParts(date);
  return (type: Intl.DateTimeFormatPartTypes) =>
    list.find((item) => item.type === type)?.value ?? "";
}

/** "10:05", "17 Nov", or "17 Nov 10:05", as the buckets' length and the span need. */
export function tickLabel(
  date: Date,
  timeZone: string,
  stepSeconds: number,
  spanSeconds: number,
): string {
  const part = parts(date, timeZone, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
  const time = `${part("hour")}:${part("minute")}`;
  if (spanSeconds <= 36 * 3600) return time;
  if (stepSeconds >= 86_400) return `${part("day")} ${part("month")}`;
  return `${part("day")} ${part("month")} ${time}`;
}

/** "Tue 17 Nov 2026, 10:00–10:05": a bucket, in the organization's timezone. */
export function bucketLabel(start: Date, stepSeconds: number, timeZone: string): string {
  const options: Intl.DateTimeFormatOptions = {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  };
  const from = parts(start, timeZone, options);
  const to = parts(new Date(start.getTime() + stepSeconds * 1000), timeZone, options);
  const day = `${from("weekday")} ${from("day")} ${from("month")} ${from("year")}`;
  if (stepSeconds >= 86_400) return day;
  return `${day}, ${from("hour")}:${from("minute")}–${to("hour")}:${to("minute")}`;
}

/** "5 minutes", "hour", "3 hours", "day": the length of a bucket. */
export function stepText(seconds: number): string {
  const units: [number, string][] = [
    [604_800, "week"],
    [86_400, "day"],
    [3600, "hour"],
    [60, "minute"],
  ];
  for (const [size, name] of units) {
    if (seconds % size === 0) {
      const count = seconds / size;
      return count === 1 ? name : `${count} ${name}s`;
    }
  }
  return `${seconds} seconds`;
}
