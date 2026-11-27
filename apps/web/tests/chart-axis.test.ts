import { describe, expect, test } from "vite-plus/test";

import { timeTicks } from "../src/features/telemetry/chart-time.ts";
import { evenTicks, formatAxisCount } from "../src/lib/chart-axis.ts";

const hours = (start: string, count: number, step: number) =>
  Array.from({ length: count }, (_, index) => new Date(Date.parse(start) + index * step * 1000));

describe("an axis's counts", () => {
  test("are whole below a thousand and compact above", () => {
    expect(formatAxisCount(0)).toBe("0");
    expect(formatAxisCount(950)).toBe("950");
    expect(formatAxisCount(1200)).toBe("1.2K");
    expect(formatAxisCount(3_400_000)).toBe("3.4M");
  });
});

describe("a time axis's ticks", () => {
  test("name each bucket by its clock time over a day or less", () => {
    const times = hours("2026-11-16T00:00:00Z", 24, 3600);
    const axis = timeTicks(times, "UTC", 3600);
    expect(axis.ticks).toHaveLength(24);
    expect(axis.label(14)).toBe("14:00");
  });

  test("name each day by its short date over days", () => {
    const times = hours("2026-11-10T00:00:00Z", 7, 86_400);
    const axis = timeTicks(times, "UTC", 86_400);
    expect(axis.ticks).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(axis.label(0)).toBe("10 Nov");
  });

  test("over several days of shorter buckets, mark each day's first bucket in the instance's timezone", () => {
    // 2-hour buckets from 09:00 in Singapore (01:00 UTC): its first day starts at the 8th bucket.
    const times = hours("2026-11-10T01:00:00Z", 36, 7200);
    const axis = timeTicks(times, "Asia/Singapore", 7200);
    expect(axis.ticks).toEqual([8, 20, 32]);
    expect(axis.ticks.map(axis.label)).toEqual(["11 Nov", "12 Nov", "13 Nov"]);
  });

  test("count a first bucket at midnight as its day's", () => {
    const times = hours("2026-11-10T00:00:00Z", 36, 7200);
    expect(timeTicks(times, "UTC", 7200).ticks).toEqual([0, 12, 24]);
  });
});

describe("evenly spaced ticks", () => {
  const days = Array.from({ length: 30 }, (_, index) => index);
  const labels = days.map(() => "24 Nov");

  test("keep every one that fits, counted back from the last", () => {
    const wide = evenTicks(days, labels, 1800);
    expect(wide).toEqual(days);
    const phone = evenTicks(days, labels, 358);
    expect(phone.at(-1)).toBe(29);
    expect(phone.length).toBeLessThanOrEqual(6);
    const gaps = new Set(phone.slice(1).map((tick, index) => tick - (phone[index] ?? 0)));
    expect(gaps.size).toBe(1);
  });

  test("keep them all before the chart has a width", () => {
    expect(evenTicks(days, labels, 0)).toEqual(days);
  });
});
