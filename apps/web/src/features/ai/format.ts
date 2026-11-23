import { MISSING } from "@/lib/missing";

import { formatCount } from "../analytics/format";
import { formatDuration } from "../telemetry/format";

/** Minimum calls for AI report and Overview cost changes (lib/change.ts). */
export const MIN_CALLS_FOR_CHANGE = 20;

const cents = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const dollars = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});
/** Use whole dollars from $100, cents from $1, and two significant digits below $1. */
export function formatUsd(value: number): string {
  if (value === 0) return "$0.00";
  if (value >= 100) return dollars.format(value);
  if (value >= 1) return cents.format(value);
  const digits = Math.min(20, Math.max(2, 1 - Math.floor(Math.log10(value))));
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

export const formatTokens = formatCount;

export const formatMs = (ms: number | null) => (ms === null ? MISSING : formatDuration(ms * 1000));

export const modelLabel = (model: string) => (model === "" ? "Not named" : model);

export const featureLabel = (feature: string) => (feature === "" ? "Unlabeled" : feature);

const CUT_OFF_REASONS = ["length", "max_tokens"];

export const isCutOff = (finishReasons: readonly string[]) =>
  finishReasons.some((reason) => CUT_OFF_REASONS.includes(reason));
