import { MISSING } from "@/lib/missing";

import { formatCount } from "../analytics/format";
import { formatDuration } from "../telemetry/format";

/** How the AI page writes its numbers and names. */

/**
 * The fewest calls, in this period or the one before, a change rests on
 * (lib/change.ts): the AI page's and the Overview's AI cost widget's.
 */
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
/**
 * An estimated cost in US dollars: "$1,240" from $100, "$12.34" from a
 * dollar, and two significant digits below ("$0.50", "$0.031", "$0.0078"),
 * since one call often costs less than a cent.
 */
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

/** Tokens: 1,284 in full, 12.9K once they reach 10,000. */
export const formatTokens = formatCount;

/** A duration the API gives in milliseconds: "850 ms", "1.25 s"; "–" with none. */
export const formatMs = (ms: number | null) => (ms === null ? MISSING : formatDuration(ms * 1000));

/** A model's name in a list: "Not named" when the spans named none. */
export const modelLabel = (model: string) => (model === "" ? "Not named" : model);

/** A feature's name in a list: "Unlabeled" for calls with no feature. */
export const featureLabel = (feature: string) => (feature === "" ? "Unlabeled" : feature);

/** Finish reasons that say the answer was cut off at its token limit. */
const CUT_OFF_REASONS = ["length", "max_tokens"];

export const isCutOff = (finishReasons: readonly string[]) =>
  finishReasons.some((reason) => CUT_OFF_REASONS.includes(reason));
