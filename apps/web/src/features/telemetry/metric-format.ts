import type { MetricKind } from "@/lib/metrics-api";

import { formatDuration } from "./format";

/**
 * Metric values as the Metrics page shows them, by the metric's unit
 * (OpenTelemetry's units are UCUM: "ms", "s", "By", "1", "{request}"):
 * durations as the other telemetry pages show them, bytes in KiB, MiB,
 * GiB, and the rest as numbers with the unit after them.
 */

export const KIND_LABELS: Record<MetricKind, string> = {
  gauge: "Gauge",
  counter: "Counter",
  updown: "Up-down counter",
  histogram: "Histogram",
};

const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const precise = new Intl.NumberFormat("en-US", { maximumSignificantDigits: 3 });

/** 1,284, 12.9K, 0.25, 0.0333: three significant digits, compact from 10,000. */
export function formatNumber(value: number): string {
  if (value === 0) return "0";
  if (Math.abs(value) >= 10_000) return compact.format(value);
  if (Math.abs(value) >= 1000) return new Intl.NumberFormat("en-US").format(Math.round(value));
  return precise.format(value);
}

/** Microseconds per unit of time. */
const TIME_UNITS: Record<string, number> = {
  ns: 0.001,
  us: 1,
  µs: 1,
  ms: 1000,
  s: 1_000_000,
  min: 60_000_000,
  h: 3_600_000_000,
};
/** Bytes per unit of data. */
const BYTE_UNITS: Record<string, number> = {
  By: 1,
  KBy: 1000,
  KiBy: 1024,
  MBy: 1e6,
  MiBy: 1024 ** 2,
  GBy: 1e9,
  GiBy: 1024 ** 3,
};
const BYTE_STEPS = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];

function formatBytes(bytes: number): string {
  let value = Math.abs(bytes);
  let step = 0;
  while (value >= 1024 && step < BYTE_STEPS.length - 1) {
    value /= 1024;
    step += 1;
  }
  return `${bytes < 0 ? "-" : ""}${precise.format(value)} ${BYTE_STEPS[step]}`;
}

/** "{request}" → "requests": an annotation, OpenTelemetry's name for what is counted. */
export function unitText(unit: string): string {
  const annotation = /^\{(.+)\}$/.exec(unit);
  if (annotation?.[1] !== undefined) return annotation[1];
  return unit === "1" ? "" : unit;
}

/** A value in its unit: "12.4 ms", "1.5 MiB", "42%", "3.2 requests". */
export function formatMetricValue(value: number, unit: string): string {
  const time = TIME_UNITS[unit];
  if (time !== undefined) {
    if (value === 0) return `0 ${unit}`;
    const us = value * time;
    return us < 0 ? `-${formatDuration(-us)}` : formatDuration(us);
  }
  const bytes = BYTE_UNITS[unit];
  if (bytes !== undefined) return formatBytes(value * bytes);
  if (unit === "%") return `${formatNumber(value)}%`;
  const text = unitText(unit);
  return text === "" ? formatNumber(value) : `${formatNumber(value)} ${text}`;
}

/** A rate: the value per second, "3.2 requests/s", "1.5 MiB/s". */
export function formatRate(value: number, unit: string): string {
  return `${formatMetricValue(value, unit)}/s`;
}

/**
 * Durations on one chart in one unit, so its single axis reads alike: ms,
 * or s when the slowest value reaches a second.
 */
export function durationFormat(values: (number | null)[]): {
  unit: "ms" | "s";
  format: (us: number) => string;
} {
  const slowest = Math.max(0, ...values.filter((value) => value !== null));
  return slowest >= 1_000_000
    ? { unit: "s", format: (us) => `${formatNumber(us / 1_000_000)} s` }
    : { unit: "ms", format: (us) => `${formatNumber(us / 1000)} ms` };
}
