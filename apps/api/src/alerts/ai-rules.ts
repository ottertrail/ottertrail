import { type Kysely, sql } from "kysely";

import { aiSeen, aiWindow } from "../ai/report.ts";
import type { Reader } from "../clickhouse/query.ts";
import type { Database } from "../db/schema.ts";
import type { Subject } from "../notifications/events.ts";
import { readInstanceSettings } from "../settings/settings.ts";
import { costOverWindow } from "./ai-cost-hours.ts";
import { type AlertContext, dashboardLink } from "./fire.ts";
import {
  type AiCostSettings,
  type AiFailureSettings,
  COST_CLEAR_MINUTES,
  type CostWindow,
} from "./kinds.ts";

/**
 * AI alert rules (docs/ai-usage.md, "Alerts"): the estimated cost of a
 * window above a value, and the failed share of a window's calls above a
 * share. The worker evaluates them with the telemetry rules
 * (telemetry-rules.ts), once a minute each, from the same figures as the
 * AI page (ai/report.ts, aiWindow), read without FINAL. This file holds
 * what is theirs: the window, the reading, and the words.
 */

export type AiSettings = AiCostSettings | AiFailureSettings;

export const isAiCost = (settings: object): settings is AiCostSettings => "costWindow" in settings;
export const isAiFailures = (settings: object): settings is AiFailureSettings =>
  "minCalls" in settings;
export const isAiRule = (settings: object): settings is AiSettings =>
  isAiCost(settings) || isAiFailures(settings);

/** What an AI rule read of its window. */
export interface AiReading {
  /** Estimated US dollars, or a failed share 0 to 100; null: too few calls (a failures rule). */
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
 * The window an AI rule reads at `at`, ending `lagMs` before it, as the
 * telemetry rules' do: a cost rule's last hour, last 24 hours, or month so
 * far (from midnight of its first day, in the instance's timezone); a
 * failures rule's last minutes.
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
 * Reads an AI rule's window at `at`: a failures rule's from ClickHouse, a
 * cost rule's closed hours from what it keeps (ai-cost-hours.ts) and the
 * rest from ClickHouse.
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
  const read = isAiCost(settings)
    ? await costOverWindow(db, reader, rule, settings, window, {
        at,
        dayStart: (await localStarts(db, at)).day,
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

/** Whether a value is above the rule's threshold. */
export function aiBreaches(settings: AiSettings, value: number): boolean {
  return isAiCost(settings) ? value > settings.thresholdUsd : value > settings.thresholdPercent;
}

/** How long a firing AI rule's value must stay on the right side before the alert resolves. */
export function aiClearMinutes(settings: AiSettings): number {
  return isAiCost(settings) ? COST_CLEAR_MINUTES : settings.windowMinutes;
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
  const unlabelled = settings.feature === "" ? " with no feature" : "";
  return `${unlabelled}${parts.length === 0 ? "" : ` for ${parts.join(" and ")}`}`;
}

/** Said in every cost notification: the figure is not a bill. */
function estimateText(reading: AiReading): string {
  const unpriced =
    reading.noPriceCalls === 0
      ? ""
      : ` ${callsText(reading.noPriceCalls)} of models without a price ${reading.noPriceCalls === 1 ? "is" : "are"} not counted.`;
  return ` The cost is an estimate, from token counts at list prices.${unpriced}`;
}

/** The message when an AI rule fires, or resolves. */
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
  const share = `${numberText(reading.value)}%`;
  const threshold = `${numberText(settings.thresholdPercent)}%`;
  const failed = `${whole(reading.failed)} of ${callsText(reading.calls)}`;
  return resolved
    ? `${project}: the failed share of AI calls${scopeText(settings)} ${where} stayed at or below ${threshold} for ${window}: ${share} over the last ${window}, ${failed}.`
    : `${project}: ${share} of AI calls${scopeText(settings)} ${where} failed over the last ${window}, above the rule's ${threshold}: ${failed}.`;
}

const rounded = (value: number, digits: number) => Number(value.toFixed(digits));

/** The notification's subject: what the rule watches, the value, the threshold, the window. */
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
  return {
    type: "ai_failures",
    ...scope,
    windowMinutes: settings.windowMinutes,
    failed: reading.failed,
    failedPercent: rounded(reading.value, 3),
    thresholdPercent: settings.thresholdPercent,
  };
}

/** What a rule's history shows as its subject. */
export function aiSubjectName(settings: AiSettings): string {
  const filters = [
    settings.feature === "" ? "Unlabelled" : settings.feature,
    settings.model,
  ].filter((item) => item !== null);
  const name = isAiCost(settings) ? "AI cost" : "AI failures";
  return filters.length === 0 ? name : `${name} (${filters.join(", ")})`;
}

/** The AI page, with the rule's environment, feature, and model. */
export function aiLink(context: AlertContext, projectId: string, settings: AiSettings): string {
  return dashboardLink(context.publicUrl, `/projects/${projectId}/ai`, {
    env: settings.environment,
    ...(settings.feature === null ? {} : { feature: settings.feature }),
    ...(settings.model === null ? {} : { model: settings.model }),
  });
}

/** Whether a call the rule would count arrived from `from` to `to`. */
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
