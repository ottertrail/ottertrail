/** Use steps of 1, 2, or 5 times a power of ten. */
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

/** Use the instance timezone and include both dates when a bucket crosses midnight. */
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
  const dayOf = (part: typeof from) =>
    `${part("weekday")} ${part("day")} ${part("month")} ${part("year")}`;
  const day = dayOf(from);
  if (stepSeconds >= 86_400) return day;
  const end = `${to("hour")}:${to("minute")}`;
  return `${day}, ${from("hour")}:${from("minute")} to ${dayOf(to) === day ? end : `${dayOf(to)}, ${end}`}`;
}

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

/**
 * The x axis's candidate ticks, by bucket index, and their labels: every bucket for a day or
 * less ("14:00") and for daily buckets ("24 Nov"); over several days of shorter buckets, the
 * first bucket of each day, named by its day. The axis then drops any label that would touch
 * its neighbor, counting from the end, so a narrow chart shows fewer.
 */
export function timeTicks(
  times: Date[],
  timeZone: string,
  stepSeconds: number,
): { ticks: number[]; label: (index: number) => string } {
  const spanSeconds = times.length * stepSeconds;
  const all = times.map((_, index) => index);
  if (spanSeconds <= 36 * 3600 || stepSeconds >= 86_400) {
    return {
      ticks: all,
      label: (index) => tickLabel(times[index] ?? new Date(0), timeZone, stepSeconds, spanSeconds),
    };
  }
  const days = times.map((date) => {
    const part = parts(date, timeZone, { day: "numeric", month: "short" });
    return `${part("day")} ${part("month")}`;
  });
  const startsDay = (index: number) => {
    if (index > 0) return days[index] !== days[index - 1];
    const part = parts(times[0] ?? new Date(0), timeZone, { hour: "2-digit", minute: "2-digit" });
    return part("hour") === "00" && part("minute") === "00";
  };
  return { ticks: all.filter(startsDay), label: (index) => days[index] ?? "" };
}
