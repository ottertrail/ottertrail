import { MISSING } from "@/lib/missing";
import type { MetricSummary, VitalName } from "@/lib/speed-api";

const whole = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

/** What each metric is, for people who do not know the abbreviations. */
export const VITALS: Record<VitalName, { name: string; short: string; explanation: string }> = {
  lcp: {
    name: "Largest Contentful Paint",
    short: "LCP",
    explanation: "When the main content appeared.",
  },
  inp: {
    name: "Interaction to Next Paint",
    short: "INP",
    explanation: "How quickly the page responded to clicks, taps, and key presses.",
  },
  cls: {
    name: "Cumulative Layout Shift",
    short: "CLS",
    explanation: "How much the content moved while loading.",
  },
  fcp: {
    name: "First Contentful Paint",
    short: "FCP",
    explanation: "When the first text or image appeared.",
  },
  ttfb: {
    name: "Time to First Byte",
    short: "TTFB",
    explanation: "When the server's response started to arrive.",
  },
};

/**
 * A metric's value as the page shows it: CLS to two decimals, milliseconds
 * whole below a second and to a tenth of a second from one. Ratings come
 * from this, so "2.5 s" is never rated as over 2.5 seconds.
 */
export function shownValue(name: VitalName, value: number): number {
  if (name === "cls") return Math.round(value * 100) / 100;
  const ms = Math.round(value);
  return ms < 1000 ? ms : Math.round(ms / 100) * 100;
}

/** 180 ms below a second; 1.2 s from 1,000 ms. */
export function formatMs(ms: number): string {
  const rounded = Math.round(ms);
  return rounded < 1000 ? `${whole.format(rounded)} ms` : `${(rounded / 1000).toFixed(1)} s`;
}

/** A metric's value: milliseconds as time, CLS as a score with two decimals; "–" for none. */
export function formatVital(name: VitalName, value: number | null): string {
  if (value === null) {
    return MISSING;
  }
  return name === "cls" ? value.toFixed(2) : formatMs(shownValue(name, value));
}

export type Rating = "good" | "needsImprovement" | "poor";

export const RATINGS: { value: Rating; label: string; tone: "good" | "warning" | "critical" }[] = [
  { value: "good", label: "Good", tone: "good" },
  { value: "needsImprovement", label: "Needs improvement", tone: "warning" },
  { value: "poor", label: "Poor", tone: "critical" },
];

/**
 * Good at or below the first threshold, poor above the second, as Google
 * rates: of the value as shown (shownValue), so a badge never contradicts
 * the number beside it.
 */
export function rate(
  name: VitalName,
  value: number,
  [good, poor]: readonly [number, number],
): Rating {
  const shown = shownValue(name, value);
  if (shown <= good) return "good";
  return shown <= poor ? "needsImprovement" : "poor";
}

/** Each rating's share of the measured loads, as whole percentages; null without loads. */
export function shares(summary: MetricSummary): Record<Rating, number> | null {
  if (summary.count === 0) {
    return null;
  }
  const percent = (part: number) => Math.round((part / summary.count) * 100);
  return {
    good: percent(summary.good),
    needsImprovement: percent(summary.needsImprovement),
    poor: percent(summary.poor),
  };
}

/** "desktop" as "Desktop"; a device the browser did not tell as "(unknown)". */
export function deviceLabel(deviceType: string | null): string {
  if (deviceType === null || deviceType === "") {
    return "(unknown)";
  }
  return deviceType.slice(0, 1).toUpperCase() + deviceType.slice(1);
}
