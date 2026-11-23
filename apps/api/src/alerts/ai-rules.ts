import { type Kysely, sql } from "kysely";

import { readPriceBook } from "../ai/custom-prices.ts";
import { aiLatencyWindow, aiSeen, aiWindow } from "../ai/report.ts";
import type { Reader } from "../clickhouse/query.ts";
import type { Database } from "../db/schema.ts";
import type { Subject } from "../notifications/events.ts";
import { readInstanceSettings } from "../settings/settings.ts";
import { costOverWindow } from "./ai-cost-hours.ts";
import { type AlertContext, dashboardLink } from "./fire.ts";
import {
  type AiCostSettings,
  type AiFailureSettings,
  type AiLatencySettings,
  COST_CLEAR_MINUTES,
  type CostWindow,
} from "./kinds.ts";

/**
 * AI rules use the AI page's figures without FINAL (ai/report.ts). They run with telemetry
 * rules once a minute (telemetry-rules.ts; docs/ai-usage.md, "Alerts").
 */

export type AiSettings = AiCostSettings | AiFailureSettings | AiLatencySettings;

export const isAiCost = (settings: object): settings is AiCostSettings => "costWindow" in settings;
export const isAiLatency = (settings: object): settings is AiLatencySettings =>
  "minCalls" in settings && "thresholdMs" in settings;
export const isAiFailures = (settings: object): settings is AiFailureSettings =>
  "minCalls" in settings && "thresholdPercent" in settings;
export const isAiRule = (settings: object): settings is AiSettings =>
  isAiCost(settings) || isAiFailures(settings) || isAiLatency(settings);

export interface AiReading {
  /**
   * US dollars, failed calls as 0 to 100 percent, or p95 duration in milliseconds. Null when a
   * failures or latency rule has too few calls.
   */
  value: number | null;
  calls: number;
  failed: number;
  noPriceCalls: number;
  from: Date;
  to: Date;
}

/** The start of the month and of the day `at` is in, in the instance's timezone. */
async function localStarts(db: Kysely<Database>, at: Date): Promise<{ month: Date; day: Date }> {
  const { timeZone } = await readInstanceSettings(db);
  const { rows } = await sql<{ month: Date; day: Date }>`
    select date_trunc('month', ${at}::timestamptz at time zone ${timeZone})
             at time zone ${timeZone} as month,
           date_trunc('day', ${at}::timestamptz at time zone ${timeZone})
             at time zone ${timeZone} as day
  `.execute(db);
  const [row] = rows;
  if (row === undefined) throw new Error("localStarts returned no row");
  return row;
}

const HOUR_MS = 3_600_000;

/**
 * End the window `lagMs` before `at`. Cost windows use the last hour, last 24 hours, or month
 * to date in the instance's timezone. Failures and latency use the configured minutes.
 */
export async function aiWindowAt(
  db: Kysely<Database>,
  settings: AiSettings,
  at: Date,
  lagMs: number,
): Promise<{ from: Date; to: Date }> {
  const to = new Date(at.getTime() - lagMs);
  if (!isAiCost(settings)) {
    return { from: new Date(to.getTime() - settings.windowMinutes * 60_000), to };
  }
  if (settings.costWindow === "1h") return { from: new Date(to.getTime() - HOUR_MS), to };
  if (settings.costWindow === "1d") return { from: new Date(to.getTime() - 24 * HOUR_MS), to };
  const from = (await localStarts(db, at)).month;
  // Just after the month began, before the lag has passed: an empty window.
  return { from, to: to < from ? from : to };
}

/**
 * Read failures and latency from ClickHouse. Cost rules use cached closed hours
 * (ai-cost-hours.ts) and read the rest from ClickHouse.
 */
export async function readAi(
  db: Kysely<Database>,
  reader: Reader,
  rule: { id: string; projectId: string },
  settings: AiSettings,
  at: Date,
  lagMs: number,
): Promise<AiReading> {
  const window = await aiWindowAt(db, settings, at, lagMs);
  if (isAiLatency(settings)) {
    const read = await aiLatencyWindow(
      reader,
      { projectId: rule.projectId, environment: settings.environment, ...window },
      filtersOf(settings),
    );
    const enough = read.calls > 0 && read.calls >= settings.minCalls;
    return {
      calls: read.calls,
      failed: 0,
      noPriceCalls: 0,
      ...window,
      value: enough ? read.p95Ms : null,
    };
  }
  const read = isAiCost(settings)
    ? await costOverWindow(db, reader, rule, settings, window, {
        at,
        dayStart: (await localStarts(db, at)).day,
        prices: await readPriceBook(db),
      })
    : await aiWindow(
        reader,
        { projectId: rule.projectId, environment: settings.environment, ...window },
        filtersOf(settings),
      );
  const base = {
    calls: read.calls,
    failed: read.failed,
    noPriceCalls: read.noPriceCalls,
    ...window,
  };
  if (isAiCost(settings)) return { ...base, value: read.costUsd };
  const enough = read.calls > 0 && read.calls >= settings.minCalls;
  return { ...base, value: enough ? (read.failed / read.calls) * 100 : null };
}

const filtersOf = (settings: AiSettings) => ({
  ...(settings.feature === null ? {} : { feature: settings.feature }),
  ...(settings.model === null ? {} : { model: settings.model }),
});

export function aiBreaches(settings: AiSettings, value: number): boolean {
  if (isAiCost(settings)) return value > settings.thresholdUsd;
  return isAiLatency(settings) ? value > settings.thresholdMs : value > settings.thresholdPercent;
}

/** How long a firing AI rule's value must stay on the right side before the alert resolves. */
export function aiClearMinutes(settings: AiSettings): number {
  return isAiCost(settings) ? COST_CLEAR_MINUTES : settings.windowMinutes;
}

/** Milliseconds as a message shows them: "812 ms", "1.25 s" (as a route rule's). */
function durationText(ms: number): string {
  return ms >= 1000 ? `${numberText(ms / 1000)} s` : `${numberText(ms)} ms`;
}

/** A number as a message shows it: 4 significant digits, grouped. */
function numberText(value: number): string {
  if (value === 0) return "0";
  const rounded = Number(value.toPrecision(4));
  return rounded.toLocaleString("en", { maximumFractionDigits: 20 });
}

const usd = (value: number) => `$${numberText(value)}`;
const whole = (count: number) => count.toLocaleString("en");
const callsText = (count: number) => `${whole(count)} ${count === 1 ? "call" : "calls"}`;
const minutes = (count: number) => (count === 1 ? "1 minute" : `${count} minutes`);

const WINDOW_TEXT: Record<CostWindow, string> = {
  "1h": "the last hour",
  "1d": "the last 24 hours",
  month: "the month so far",
};

/**
 * The rule's feature and model, as words: " for the feature support and
 * the model gpt-5", " with no feature for the model gpt-5", or "".
 */
function scopeText(settings: AiSettings): string {
  const parts = [
    ...(settings.feature === null || settings.feature === ""
      ? []
      : [`the feature ${settings.feature}`]),
    ...(settings.model === null ? [] : [`the model ${settings.model}`]),
  ];
  const unlabeled = settings.feature === "" ? " with no feature" : "";
  return `${unlabeled}${parts.length === 0 ? "" : ` for ${parts.join(" and ")}`}`;
}

/** Cost notifications must say the estimate is not a bill. */
function estimateText(reading: AiReading): string {
  const unpriced =
    reading.noPriceCalls === 0
      ? ""
      : ` ${callsText(reading.noPriceCalls)} of models without a price ${reading.noPriceCalls === 1 ? "is" : "are"} not counted.`;
  return ` The cost is an estimate, from token counts and model prices.${unpriced}`;
}

export function aiMessage(
  project: string,
  settings: AiSettings,
  reading: AiReading & { value: number },
  resolved: boolean,
): string {
  const where = `in ${settings.environment}`;
  if (isAiCost(settings)) {
    const what = `the estimated AI cost${scopeText(settings)} ${where}`;
    const value = usd(reading.value);
    const threshold = usd(settings.thresholdUsd);
    const window = WINDOW_TEXT[settings.costWindow];
    return resolved
      ? `${project}: ${what} stayed at or below ${threshold} for ${minutes(COST_CLEAR_MINUTES)}: ${value} over ${window}.${estimateText(reading)}`
      : `${project}: ${what} was ${value} over ${window}, above the rule's ${threshold}.${estimateText(reading)}`;
  }
  const window = minutes(settings.windowMinutes);
  if (isAiLatency(settings)) {
    const value = durationText(reading.value);
    const threshold = durationText(settings.thresholdMs);
    const across = `across ${callsText(reading.calls)}`;
    return resolved
      ? `${project}: the 95th percentile duration of AI calls${scopeText(settings)} ${where} stayed at or below ${threshold} for ${window}: ${value} over the last ${window}, ${across}.`
      : `${project}: the 95th percentile duration of AI calls${scopeText(settings)} ${where} was ${value} over the last ${window}, above the rule's ${threshold}, ${across}.`;
  }
  const share = `${numberText(reading.value)}%`;
  const threshold = `${numberText(settings.thresholdPercent)}%`;
  const failed = `${whole(reading.failed)} of ${callsText(reading.calls)}`;
  return resolved
    ? `${project}: the failed share of AI calls${scopeText(settings)} ${where} stayed at or below ${threshold} for ${window}: ${share} over the last ${window}, ${failed}.`
    : `${project}: ${share} of AI calls${scopeText(settings)} ${where} failed over the last ${window}, above the rule's ${threshold}: ${failed}.`;
}

const rounded = (value: number, digits: number) => Number(value.toFixed(digits));

export function aiSubject(settings: AiSettings, reading: AiReading & { value: number }): Subject {
  const scope = {
    environment: settings.environment,
    feature: settings.feature,
    model: settings.model,
    calls: reading.calls,
  };
  if (isAiCost(settings)) {
    return {
      type: "ai_cost",
      ...scope,
      costWindow: settings.costWindow,
      costUsd: rounded(reading.value, 6),
      thresholdUsd: settings.thresholdUsd,
      noPriceCalls: reading.noPriceCalls,
      estimated: true,
    };
  }
  if (isAiLatency(settings)) {
    return {
      type: "ai_latency",
      ...scope,
      windowMinutes: settings.windowMinutes,
      percentile: "p95",
      valueMs: rounded(reading.value, 3),
      thresholdMs: settings.thresholdMs,
    };
  }
  return {
    type: "ai_failures",
    ...scope,
    windowMinutes: settings.windowMinutes,
    failed: reading.failed,
    failedPercent: rounded(reading.value, 3),
    thresholdPercent: settings.thresholdPercent,
  };
}

export function aiSubjectName(settings: AiSettings): string {
  const filters = [settings.feature === "" ? "Unlabeled" : settings.feature, settings.model].filter(
    (item) => item !== null,
  );
  const name = isAiCost(settings)
    ? "AI cost"
    : isAiLatency(settings)
      ? "AI latency"
      : "AI failures";
  return filters.length === 0 ? name : `${name} (${filters.join(", ")})`;
}

export function aiLink(context: AlertContext, projectId: string, settings: AiSettings): string {
  return dashboardLink(context.publicUrl, `/projects/${projectId}/ai`, {
    env: settings.environment,
    ...(settings.feature === null ? {} : { feature: settings.feature }),
    ...(settings.model === null ? {} : { model: settings.model }),
  });
}

export async function aiRuleSeen(
  reader: Reader,
  projectId: string,
  settings: AiSettings,
  from: Date,
  to: Date,
): Promise<boolean> {
  return aiSeen(
    reader,
    { projectId, environment: settings.environment, from, to },
    filtersOf(settings),
  );
}

/** The warning when no call the rule counts arrived in the last day. */
export function aiNotSeenMessage(settings: AiSettings): string {
  return `No AI call${scopeText(settings)} arrived in ${settings.environment} in the last 24 hours. The rule is saved. Monitoring starts when calls arrive.`;
}
