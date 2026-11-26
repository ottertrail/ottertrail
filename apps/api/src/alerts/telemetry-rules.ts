import { type Kysely, sql, type Transaction } from "kysely";

import { DeadlineError, type Reader } from "../clickhouse/query.ts";
import type { Database } from "../db/schema.ts";
import { MAX_NOTIFICATION_URL, type Subject } from "../notifications/events.ts";
import { HOST_KEY } from "../telemetry/hosts.ts";
import { metricSeen, metricWindow } from "../telemetry/metrics.ts";
import { requestsSeen, routeWindows, type WindowStats } from "../telemetry/services.ts";
import {
  aiBreaches,
  aiClearMinutes,
  aiLink,
  aiMessage,
  aiNotSeenMessage,
  aiRuleSeen,
  type AiSettings,
  aiSubject,
  aiSubjectName,
  isAiRule,
  readAi,
} from "./ai-rules.ts";
import type { Counts } from "./check-rules.ts";
import {
  type AlertContext,
  cut,
  dashboardLink,
  fire,
  type Guard,
  type Outcome,
  resolve,
  setClearSince,
} from "./fire.ts";
import {
  type Aggregate,
  aiCostSettingsStored,
  aiFailureSettingsStored,
  aiLatencySettingsStored,
  type FailureSettings,
  failureSettingsOf,
  isRuleKind,
  KIND_INFO,
  type LatencySettings,
  latencySettingsOf,
  type MetricSettings,
  metricSettingsStored,
  type RuleKind,
  type StoppedSettings,
  stoppedSettingsStored,
  TELEMETRY_KINDS,
} from "./kinds.ts";
import {
  arrivedCount,
  isStopped,
  readStopped,
  stoppedLink,
  stoppedMessage,
  stoppedNotSeenMessage,
  stoppedSubject,
  stoppedSubjectName,
} from "./stopped-rules.ts";

/**
 * Evaluate telemetry, AI, and "data stops arriving" rules once a minute using dashboard
 * calculations (telemetry/services.ts, routeWindows; telemetry/metrics.ts, metricWindow;
 * ai-rules.ts; stopped-rules.ts). Claim
 * rules with FOR UPDATE SKIP LOCKED (takeDueRules) to avoid duplicate evaluation
 * (docs/uptime-alerts.md, "Alerts on telemetry"; docs/ai-usage.md).
 *
 * Queries filter by project, parameterize values, and use dashboard read-only limits. Batch
 * route rules per project and environment over their longest window, at most 30 minutes. Read
 * metric rules separately, including the earlier point needed for counter steps. Limit
 * concurrent projects to TELEMETRY_CONCURRENCY and each project to PROJECT_BUDGET_MS; record
 * failures for rules beyond the budget and retry next minute.
 *
 * End windows TELEMETRY_LAG_MS before evaluation to allow metric exports to arrive. Count the
 * part of a counter step inside the window even if it ends later. Resolve only after a full
 * window of good evaluations to prevent flapping. No data or too few requests neither fires nor
 * resolves; restart the recovery timer when data returns. Edits and disabling silently end
 * alerts (rules.ts).
 */

export const TELEMETRY_CONCURRENCY = 4;
export const TELEMETRY_TICK_MS = 5_000;
export const EVALUATION_INTERVAL_MS = 60_000;
export const MAX_DUE_RULES = 200;
export const TELEMETRY_LAG_MS = 60_000;
/** How long one project's due rules may take in a pass: each query gets what is left. */
export const PROJECT_BUDGET_MS = 20_000;

export interface TelemetryRule {
  id: string;
  projectId: string;
  projectName: string;
  kind: RuleKind;
  settings: unknown;
  /** Its last change: an alert goes ahead only while the rule is still the one read. */
  updatedAt: Date;
  /** Since it was added, turned on, or changed to watch something else (rules.ts). */
  activeSince: Date;
}

/** The enabled telemetry rules, of every project or one, by project, then age (tests read them). */
export async function telemetryRules(
  db: Kysely<Database>,
  projectId?: string,
): Promise<TelemetryRule[]> {
  let query = db
    .selectFrom("alert_rules as r")
    .innerJoin("projects as p", "p.id", "r.project_id")
    .select([
      "r.id",
      "r.project_id",
      "p.name as project_name",
      "r.kind",
      "r.settings",
      "r.updated_at",
      "r.active_since",
    ])
    .where("r.enabled", "=", true)
    .where("r.kind", "in", TELEMETRY_KINDS);
  if (projectId !== undefined) query = query.where("r.project_id", "=", projectId);
  const rows = await query
    .orderBy("r.project_id")
    .orderBy("r.created_at")
    .orderBy("r.id")
    .execute();
  return rows.flatMap((row) =>
    isRuleKind(row.kind)
      ? [
          {
            id: row.id,
            projectId: row.project_id,
            projectName: row.project_name,
            kind: row.kind,
            settings: row.settings,
            updatedAt: row.updated_at,
            activeSince: row.active_since,
          },
        ]
      : [],
  );
}

/**
 * Claim due rules and advance their next evaluation before reading telemetry. Preserve minute
 * cadence, or schedule a minute after `at` following a gap. A crash leaves rules due next
 * minute; other workers cannot claim the same evaluation.
 */
export async function takeDueRules(
  db: Kysely<Database>,
  at: Date,
  limit = MAX_DUE_RULES,
): Promise<TelemetryRule[]> {
  const interval = sql`make_interval(secs => ${EVALUATION_INTERVAL_MS / 1000})`;
  const { rows } = await sql<{
    id: string;
    project_id: string;
    project_name: string;
    kind: string;
    settings: unknown;
    updated_at: Date;
    created_at: Date;
    active_since: Date;
  }>`
    with due as (
      select id from alert_rules
      where enabled
        and kind = any(${[...TELEMETRY_KINDS]}::text[])
        and (next_evaluation_at is null or next_evaluation_at <= ${at})
      order by next_evaluation_at nulls first, id
      limit ${limit}
      for update skip locked
    )
    update alert_rules as r
    set next_evaluation_at = case
      when r.next_evaluation_at is null or r.next_evaluation_at + ${interval} <= ${at}
        then ${at}::timestamptz + ${interval}
      else r.next_evaluation_at + ${interval}
    end
    from due, projects as p
    where r.id = due.id and p.id = r.project_id
    returning r.id, r.project_id, p.name as project_name, r.kind, r.settings, r.updated_at,
      r.created_at, r.active_since
  `.execute(db);
  return rows
    .toSorted(
      (a, b) =>
        a.project_id.localeCompare(b.project_id) ||
        a.created_at.getTime() - b.created_at.getTime() ||
        a.id.localeCompare(b.id),
    )
    .flatMap((row) =>
      isRuleKind(row.kind)
        ? [
            {
              id: row.id,
              projectId: row.project_id,
              projectName: row.project_name,
              kind: row.kind,
              settings: row.settings,
              updatedAt: row.updated_at,
              activeSince: row.active_since,
            },
          ]
        : [],
    );
}

/** Release unstarted rules immediately on shutdown so another worker can claim them. */
export async function releaseRules(db: Kysely<Database>, ruleIds: string[]): Promise<void> {
  if (ruleIds.length === 0) return;
  await db
    .updateTable("alert_rules")
    .set({ next_evaluation_at: null })
    .where("id", "in", ruleIds)
    .execute();
}

const MAX_REASON = 300;

export function reasonOf(error: unknown): string {
  if (error instanceof DeadlineError) {
    return "The project's rules reached their time limit for this minute before this rule could be read.";
  }
  const text = error instanceof Error ? error.message : String(error);
  return cut(text === "" ? "The evaluation failed." : text, MAX_REASON);
}

/**
 * Keep failure reason and onset until recovery. Return failing or recovered only on transitions
 * so logs emit once per outage.
 */
export async function recordEvaluation(
  db: Kysely<Database>,
  ruleId: string,
  error: unknown,
  at: Date,
): Promise<"failing" | "recovered" | null> {
  if (error === null) {
    const cleared = await db
      .updateTable("alert_rules")
      .set({ evaluation_error: null, evaluation_failing_since: null })
      .where("id", "=", ruleId)
      .where("evaluation_error", "is not", null)
      .executeTakeFirst();
    return cleared.numUpdatedRows > 0n ? "recovered" : null;
  }
  const { rows } = await sql<{ started: boolean }>`
    with before as (select evaluation_failing_since from alert_rules where id = ${ruleId} for update)
    update alert_rules
    set evaluation_error = ${reasonOf(error)},
        evaluation_failing_since = coalesce(alert_rules.evaluation_failing_since, ${at})
    from before
    where id = ${ruleId}
    returning before.evaluation_failing_since is null as started
  `.execute(db);
  return rows[0]?.started === true ? "failing" : null;
}

export interface Reading {
  /** The value compared with the threshold; null: no data, or too few requests. */
  value: number | null;
  /** A route rule's requests and failures in the window. */
  requests?: number;
  failed?: number;
  /** A metric's unit, as its latest series named it. */
  unit?: string;
  /** An AI rule's calls in the window, those failed, and those of models without a price. */
  calls?: number;
  noPriceCalls?: number;
  from: Date;
  to: Date;
}

export function windowAt(at: Date, windowMinutes: number): { from: Date; to: Date } {
  const to = new Date(at.getTime() - TELEMETRY_LAG_MS);
  return { from: new Date(to.getTime() - windowMinutes * 60_000), to };
}

type Settings = LatencySettings | FailureSettings | MetricSettings | AiSettings | StoppedSettings;

function settingsOfRule(rule: TelemetryRule): Settings {
  if (rule.kind === "route_latency") return latencySettingsOf(rule.settings);
  if (rule.kind === "route_failures") return failureSettingsOf(rule.settings);
  if (rule.kind === "ai_cost") return aiCostSettingsStored(rule.settings);
  if (rule.kind === "ai_failures") return aiFailureSettingsStored(rule.settings);
  if (rule.kind === "ai_latency") return aiLatencySettingsStored(rule.settings);
  if (rule.kind === "events_stopped" || rule.kind === "telemetry_stopped") {
    return stoppedSettingsStored(rule.kind, rule.settings);
  }
  return metricSettingsStored(rule.settings);
}

type RouteSettings = LatencySettings | FailureSettings;
/** The kinds that compare a value with a threshold: all but "data stops arriving". */
type ValueSettings = Exclude<Settings, StoppedSettings>;

const isMetric = (settings: Settings): settings is MetricSettings => "metricKind" in settings;
const isLatency = (settings: Settings): settings is LatencySettings => "thresholdMs" in settings;

async function readAiRule(
  context: AlertContext,
  reader: Reader,
  rule: TelemetryRule,
  settings: AiSettings,
  at: Date,
): Promise<Reading> {
  return readAi(context.db, reader, rule, settings, at, TELEMETRY_LAG_MS);
}

async function readMetric(
  reader: Reader,
  rule: TelemetryRule,
  settings: MetricSettings,
  at: Date,
): Promise<Reading> {
  const { from, to } = windowAt(at, settings.windowMinutes);
  const window = await metricWindow(
    reader,
    { projectId: rule.projectId, environment: settings.environment },
    {
      name: settings.metric,
      kind: settings.metricKind,
      resource: settings.host === null ? undefined : { key: HOST_KEY, value: settings.host },
      attribute:
        settings.attributeKey === null || settings.attributeValue === null
          ? undefined
          : { keys: [settings.attributeKey], value: settings.attributeValue },
    },
    from,
    to,
    at,
  );
  const value = window.values[settings.aggregate] ?? null;
  return {
    value: value !== null && Number.isFinite(value) ? value : null,
    unit: window.unit,
    from,
    to,
  };
}

function routeReading(
  settings: LatencySettings | FailureSettings,
  stats: WindowStats,
  window: { from: Date; to: Date },
): Reading {
  const enough = stats.requests > 0 && stats.requests >= settings.minRequests;
  let value: number | null = null;
  if (enough) {
    if (isLatency(settings)) {
      const us = settings.percentile === "p99" ? stats.p99Us : stats.p95Us;
      value = us === null ? null : us / 1000;
    } else {
      value = (stats.failed / stats.requests) * 100;
    }
  }
  return { value, requests: stats.requests, failed: stats.failed, ...window };
}

/**
 * Read each environment's longest route window once, counting each rule over its own window
 * (routeWindows).
 */
async function readRoutes(
  reader: Reader,
  projectId: string,
  environment: string,
  rules: readonly { rule: TelemetryRule; settings: LatencySettings | FailureSettings }[],
  at: Date,
): Promise<Reading[]> {
  const windows = rules.map(({ settings }) => windowAt(at, settings.windowMinutes));
  const stats = await routeWindows(
    reader,
    { projectId, environment, to: new Date(at.getTime() - TELEMETRY_LAG_MS) },
    rules.map(({ settings }, index) => ({
      service: settings.service,
      route: settings.route,
      from: windows[index]?.from ?? at,
    })),
  );
  return rules.map(({ settings }, index) =>
    routeReading(
      settings,
      stats[index] ?? { requests: 0, failed: 0, p95Us: null, p99Us: null },
      windows[index] ?? windowAt(at, settings.windowMinutes),
    ),
  );
}

function breaches(settings: Settings, value: number): boolean {
  if (isStopped(settings)) return value < settings.minCount;
  if (isAiRule(settings)) return aiBreaches(settings, value);
  if (isMetric(settings)) {
    return settings.direction === "above" ? value > settings.value : value < settings.value;
  }
  return isLatency(settings) ? value > settings.thresholdMs : value > settings.thresholdPercent;
}

const minutes = (count: number) => (count === 1 ? "1 minute" : `${count} minutes`);
const whole = (count: number) => count.toLocaleString("en");
const requestsText = (count: number) => `${whole(count)} ${count === 1 ? "request" : "requests"}`;

/** A number as a message shows it: 4 significant digits, grouped. */
export function numberText(value: number): string {
  if (value === 0) return "0";
  const rounded = Number(value.toPrecision(4));
  return Math.abs(rounded) >= 1e21
    ? rounded.toExponential(3)
    : rounded.toLocaleString("en", { maximumFractionDigits: 20 });
}

/** Milliseconds as a message shows them: "812 ms", "1.25 s". */
export function durationText(ms: number): string {
  return ms >= 1000 ? `${numberText(ms / 1000)} s` : `${numberText(ms)} ms`;
}

const percentText = (value: number) => `${numberText(value)}%`;

/**
 * Omit dimensionless units ("1"), missing units, and annotations such as "{request}" from
 * messages.
 */
function unitText(unit: string | undefined): string {
  const text = unit ?? "";
  return text === "" || text === "1" || /^\{.*\}$/u.test(text) ? "" : ` ${text}`;
}

const AGGREGATE_TEXT: Record<Aggregate, string> = {
  avg: "the average",
  min: "the minimum",
  max: "the maximum",
  rate: "the rate per second",
  sum: "the total",
  p50: "the median",
  p95: "the 95th percentile",
  p99: "the 99th percentile",
};

/** The longest route, host, or attribute value a message or subject quotes. */
const QUOTE_CHARS = 300;

const routeWhat = (settings: RouteSettings) =>
  settings.route === null
    ? `requests of ${settings.service}`
    : `${cut(settings.route, QUOTE_CHARS)} in ${settings.service}`;

/** A metric rule's filters, as words: " on host web-1 where state is used", or "". */
function filtersText(settings: MetricSettings): string {
  const filters = [
    ...(settings.host === null ? [] : [`on host ${cut(settings.host, QUOTE_CHARS)}`]),
    ...(settings.attributeKey === null || settings.attributeValue === null
      ? []
      : [`where ${settings.attributeKey} is ${cut(settings.attributeValue, QUOTE_CHARS)}`]),
  ];
  return filters.length === 0 ? "" : ` ${filters.join(" ")}`;
}

const metricWhat = (settings: MetricSettings) =>
  `${AGGREGATE_TEXT[settings.aggregate]} of ${settings.metric}${filtersText(settings)}`;

function subjectName(settings: Settings): string {
  if (isStopped(settings)) return stoppedSubjectName(settings);
  if (isAiRule(settings)) return aiSubjectName(settings);
  if (isMetric(settings)) return `${settings.metric} (${settings.aggregate})`;
  return settings.route === null ? settings.service : `${settings.service} ${settings.route}`;
}

/**
 * Drop the longest filters first when a notification link exceeds its limit. Keep them in the
 * message. Fall back to the project's Services or Metrics page if needed.
 */
export function telemetryLink(
  context: AlertContext,
  projectId: string,
  settings: ValueSettings,
): string {
  if (isAiRule(settings)) return aiLink(context, projectId, settings);
  const first = (candidates: (() => string)[]): string => {
    for (const candidate of candidates) {
      const url = candidate();
      if (url.length <= MAX_NOTIFICATION_URL) return url;
    }
    return dashboardLink(
      context.publicUrl,
      `/projects/${projectId}/${isMetric(settings) ? "metrics" : "services"}`,
    );
  };
  if (isMetric(settings)) {
    const path = `/projects/${projectId}/metrics/${encodeURIComponent(settings.metric)}`;
    const host: Record<string, string> = settings.host === null ? {} : { host: settings.host };
    const attribute: Record<string, string> =
      settings.attributeKey === null || settings.attributeValue === null
        ? {}
        : { attr: settings.attributeKey, attrValue: settings.attributeValue };
    const base: Record<string, string> = { kind: settings.metricKind, env: settings.environment };
    const hostLonger = (settings.host?.length ?? 0) >= (settings.attributeValue?.length ?? 0);
    return first([
      () => dashboardLink(context.publicUrl, path, { ...base, ...host, ...attribute }),
      () => dashboardLink(context.publicUrl, path, { ...base, ...(hostLonger ? attribute : host) }),
      () => dashboardLink(context.publicUrl, path, { ...base, ...(hostLonger ? host : attribute) }),
      () => dashboardLink(context.publicUrl, path, base),
    ]);
  }
  const path = `/projects/${projectId}/services`;
  const base = { env: settings.environment, service: settings.service };
  return first([
    () =>
      dashboardLink(context.publicUrl, path, {
        ...base,
        ...(settings.route === null ? {} : { route: settings.route }),
      }),
    () => dashboardLink(context.publicUrl, path, base),
  ]);
}

const rounded = (value: number) => Number(value.toFixed(3));

function subjectOf(settings: ValueSettings, reading: Reading & { value: number }): Subject {
  if (isAiRule(settings)) {
    return aiSubject(settings, {
      ...reading,
      calls: reading.calls ?? 0,
      failed: reading.failed ?? 0,
      noPriceCalls: reading.noPriceCalls ?? 0,
    });
  }
  if (isMetric(settings)) {
    return {
      type: "metric",
      metric: settings.metric,
      metricKind: settings.metricKind,
      aggregate: settings.aggregate,
      direction: settings.direction,
      value: reading.value,
      threshold: settings.value,
      unit: reading.unit ?? "",
      environment: settings.environment,
      host: settings.host === null ? null : cut(settings.host, QUOTE_CHARS),
      attributeKey: settings.attributeKey,
      attributeValue:
        settings.attributeValue === null ? null : cut(settings.attributeValue, QUOTE_CHARS),
      windowMinutes: settings.windowMinutes,
    };
  }
  const route = {
    type: "route",
    service: settings.service,
    route: settings.route === null ? null : cut(settings.route, QUOTE_CHARS),
    environment: settings.environment,
    windowMinutes: settings.windowMinutes,
    requests: reading.requests ?? 0,
  };
  if (isLatency(settings)) {
    return {
      ...route,
      percentile: settings.percentile,
      valueMs: rounded(reading.value),
      thresholdMs: settings.thresholdMs,
    };
  }
  return {
    ...route,
    failed: reading.failed ?? 0,
    failedPercent: rounded(reading.value),
    thresholdPercent: settings.thresholdPercent,
  };
}

function messageOf(
  project: string,
  settings: ValueSettings,
  reading: Reading & { value: number },
  resolved: boolean,
): string {
  if (isAiRule(settings)) {
    return aiMessage(
      project,
      settings,
      {
        ...reading,
        calls: reading.calls ?? 0,
        failed: reading.failed ?? 0,
        noPriceCalls: reading.noPriceCalls ?? 0,
      },
      resolved,
    );
  }
  const window = minutes(settings.windowMinutes);
  const where = `in ${settings.environment}`;
  if (isMetric(settings)) {
    const unit = unitText(reading.unit);
    const value = `${numberText(reading.value)}${unit}`;
    const threshold = `${numberText(settings.value)}${unit}`;
    if (!resolved) {
      return `${project}: ${metricWhat(settings)} ${where} was ${value} over the last ${window}, ${settings.direction} the rule's ${threshold}.`;
    }
    const side = settings.direction === "above" ? "at or below" : "at or above";
    return `${project}: ${metricWhat(settings)} ${where} stayed ${side} ${threshold} for ${window}: ${value} over the last ${window}.`;
  }
  const requests = requestsText(reading.requests ?? 0);
  if (isLatency(settings)) {
    const p = settings.percentile === "p99" ? "99th" : "95th";
    const value = durationText(reading.value);
    const threshold = durationText(settings.thresholdMs);
    return resolved
      ? `${project}: the ${p} percentile duration of ${routeWhat(settings)} ${where} stayed at or below ${threshold} for ${window}: ${value} over the last ${window}, across ${requests}.`
      : `${project}: the ${p} percentile duration of ${routeWhat(settings)} ${where} was ${value} over the last ${window}, above the rule's ${threshold}, across ${requests}.`;
  }
  const failed = `${whole(reading.failed ?? 0)} of ${requests}`;
  const share = percentText(reading.value);
  const threshold = percentText(settings.thresholdPercent);
  return resolved
    ? `${project}: the failed share of ${routeWhat(settings)} ${where} stayed at or below ${threshold} for ${window}: ${share} over the last ${window}, ${failed}.`
    : `${project}: ${share} of ${routeWhat(settings)} ${where} failed over the last ${window}, above the rule's ${threshold}: ${failed}.`;
}

const unchanged =
  (rule: TelemetryRule): Guard =>
  async (trx: Transaction<Database>) => {
    const row = await trx
      .selectFrom("alert_rules")
      .select("updated_at")
      .where("id", "=", rule.id)
      .executeTakeFirst();
    return row?.updated_at.getTime() === rule.updatedAt.getTime();
  };

export interface RuleResult {
  reading: Reading;
  outcome: Outcome | "cleared" | "waiting" | "none";
}

export async function evaluateTelemetryRule(
  context: AlertContext,
  reader: Reader,
  rule: TelemetryRule,
  at: Date,
): Promise<RuleResult> {
  const settings = settingsOfRule(rule);
  const reading = isStopped(settings)
    ? await readStopped(reader, rule, settings, at)
    : isAiRule(settings)
      ? await readAiRule(context, reader, rule, settings, at)
      : isMetric(settings)
        ? await readMetric(reader, rule, settings, at)
        : (
            await readRoutes(reader, rule.projectId, settings.environment, [{ rule, settings }], at)
          )[0];
  if (reading === undefined) throw new Error("A route rule's batch read nothing");
  return judge(context, rule, settings, reading, at);
}

async function judge(
  context: AlertContext,
  rule: TelemetryRule,
  settings: Settings,
  reading: Reading,
  at: Date,
): Promise<RuleResult> {
  const state = await context.db
    .selectFrom("alert_states")
    .select(["firing", "clear_since"])
    .where("rule_id", "=", rule.id)
    .where("subject", "=", "")
    .executeTakeFirst();
  const firing = state?.firing === true;
  const { value } = reading;
  if (value === null) {
    // No data cannot fire or advance recovery; reset the recovery timer.
    if (firing && state.clear_since !== null) {
      await setClearSince(context.db, rule.id, "", null);
    }
    return { reading, outcome: "none" };
  }
  const read = { ...reading, value };
  const message = isStopped(settings)
    ? {
        url: stoppedLink(context, rule.projectId, rule.id),
        subject: stoppedSubject(settings, value),
        at,
      }
    : {
        url: telemetryLink(context, rule.projectId, settings),
        subject: subjectOf(settings, read),
        at,
      };
  const text = (resolved: boolean) =>
    isStopped(settings)
      ? stoppedMessage(rule.projectName, settings, value, resolved)
      : messageOf(rule.projectName, settings, read, resolved);
  if (breaches(settings, value)) {
    if (firing) {
      if (state.clear_since !== null) await setClearSince(context.db, rule.id, "", null);
      return { reading, outcome: "none" };
    }
    const outcome = await fire(context, {
      ruleId: rule.id,
      subjectKey: "",
      subjectName: subjectName(settings),
      type: KIND_INFO[rule.kind].fires,
      message: text(false),
      rule: { kind: rule.kind, settings: rule.settings },
      still: unchanged(rule),
      ...message,
    });
    return { reading, outcome };
  }
  if (!firing) return { reading, outcome: "none" };
  // Data that arrives again is back at once; a value must stay on the right side a while.
  if (!isStopped(settings)) {
    if (state.clear_since === null) {
      await setClearSince(context.db, rule.id, "", at);
      return { reading, outcome: "waiting" };
    }
    const clearMinutes = isAiRule(settings) ? aiClearMinutes(settings) : settings.windowMinutes;
    if (at.getTime() - state.clear_since.getTime() < clearMinutes * 60_000) {
      return { reading, outcome: "waiting" };
    }
  }
  const resolves = KIND_INFO[rule.kind].resolves;
  if (resolves === null) return { reading, outcome: "none" };
  const outcome = await resolve(context, {
    ruleId: rule.id,
    subjectKey: "",
    type: resolves,
    message: text(true),
    rule: { kind: rule.kind, settings: rule.settings },
    still: unchanged(rule),
    ...message,
  });
  return { reading, outcome };
}

export type PassResult =
  | { rule: TelemetryRule; result: RuleResult }
  | { rule: TelemetryRule; error: unknown };

export interface PassOptions {
  /** The reader for one project's queries; `deadline` is when its budget ends. */
  readerOf: (projectId: string, deadline: number) => Reader;
  now?: () => Date;
  concurrency?: number;
  budgetMs?: number;
  /** Whether the worker is stopping: no rule starts once it is. */
  stopping?: () => boolean;
}

function stepsOf(rules: readonly TelemetryRule[]) {
  const routes = new Map<string, { rule: TelemetryRule; settings: RouteSettings }[]>();
  const metrics: { rule: TelemetryRule; settings: MetricSettings }[] = [];
  const ai: { rule: TelemetryRule; settings: AiSettings }[] = [];
  const stopped: { rule: TelemetryRule; settings: StoppedSettings }[] = [];
  for (const rule of rules) {
    const settings = settingsOfRule(rule);
    if (isStopped(settings)) {
      stopped.push({ rule, settings });
    } else if (isAiRule(settings)) {
      ai.push({ rule, settings });
    } else if (isMetric(settings)) {
      metrics.push({ rule, settings });
    } else {
      const group = routes.get(settings.environment) ?? [];
      group.push({ rule, settings });
      routes.set(settings.environment, group);
    }
  }
  return { routes: [...routes], metrics, ai, stopped };
}

/**
 * Batch route rules per environment and read metric rules individually, within each project's
 * budget. Limit concurrent projects to `concurrency`. Record each failed step on its rules and
 * continue. On shutdown, return unstarted rules in `released`.
 */
export async function evaluateTelemetryPass(
  context: AlertContext,
  rules: readonly TelemetryRule[],
  {
    readerOf,
    now = () => new Date(),
    concurrency = TELEMETRY_CONCURRENCY,
    budgetMs = PROJECT_BUDGET_MS,
    stopping = () => false,
  }: PassOptions,
): Promise<{ results: PassResult[]; released: TelemetryRule[] }> {
  const byProject = new Map<string, TelemetryRule[]>();
  for (const rule of rules) {
    byProject.set(rule.projectId, [...(byProject.get(rule.projectId) ?? []), rule]);
  }
  const projects = [...byProject];
  const results: PassResult[] = [];
  const released: TelemetryRule[] = [];
  const settle = async (
    group: readonly TelemetryRule[],
    work: () => Promise<{ rule: TelemetryRule; result: RuleResult }[]>,
  ) => {
    try {
      results.push(...(await work()));
    } catch (error) {
      for (const rule of group) results.push({ rule, error });
    }
  };
  let next = 0;
  const lane = async () => {
    for (;;) {
      const project = projects[next];
      next += 1;
      if (project === undefined) return;
      const [projectId, projectRules] = project;
      if (stopping()) {
        released.push(...projectRules);
        continue;
      }
      // Measure budget with real time even when tests fix the evaluation clock.
      const reader = readerOf(projectId, Date.now() + budgetMs);
      const { routes, metrics, ai, stopped } = stepsOf(projectRules);
      const steps = [
        ...routes.map(([environment, group]) => ({
          rules: group.map((item) => item.rule),
          run: async () => {
            const at = now();
            const readings = await readRoutes(reader, projectId, environment, group, at);
            const done: { rule: TelemetryRule; result: RuleResult }[] = [];
            for (const [index, { rule, settings }] of group.entries()) {
              const reading = readings[index];
              if (reading === undefined) continue;
              // eslint-disable-next-line no-await-in-loop -- one rule's alert after another
              done.push({ rule, result: await judge(context, rule, settings, reading, at) });
            }
            return done;
          },
        })),
        ...metrics.map(({ rule, settings }) => ({
          rules: [rule],
          run: async () => {
            const at = now();
            const reading = await readMetric(reader, rule, settings, at);
            return [{ rule, result: await judge(context, rule, settings, reading, at) }];
          },
        })),
        ...ai.map(({ rule, settings }) => ({
          rules: [rule],
          run: async () => {
            const at = now();
            const reading = await readAiRule(context, reader, rule, settings, at);
            return [{ rule, result: await judge(context, rule, settings, reading, at) }];
          },
        })),
        ...stopped.map(({ rule, settings }) => ({
          rules: [rule],
          run: async () => {
            const at = now();
            const reading = await readStopped(reader, rule, settings, at);
            return [{ rule, result: await judge(context, rule, settings, reading, at) }];
          },
        })),
      ];
      for (const step of steps) {
        if (stopping()) {
          released.push(...step.rules);
          continue;
        }
        // eslint-disable-next-line no-await-in-loop -- a project's steps one after another
        await settle(step.rules, step.run);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, lane));
  return { results, released };
}

export function countsOf(results: readonly PassResult[]): Counts {
  const counts: Counts = { sent: 0, held: 0, skipped: 0 };
  for (const item of results) {
    if (!("result" in item)) continue;
    const { outcome } = item.result;
    if (outcome === "sent" || outcome === "held" || outcome === "skipped") counts[outcome] += 1;
  }
  return counts;
}

/** Allow rules before deployment by checking for matching data over the last day. */
export const SEEN_MS = 86_400_000;

/** Warn when a source has not reported or could not be checked. */
export interface SaveWarning {
  reason: "not_seen" | "not_checked";
  message: string;
}

const notSeen = (message: string): SaveWarning => ({ reason: "not_seen", message });

/**
 * Save rules even when their source has not reported in the last day or the check failed.
 * Return null when matching data exists.
 */
export async function notSeenWarning(
  reader: Reader,
  projectId: string,
  kind: RuleKind,
  stored: unknown,
  now: Date,
): Promise<SaveWarning | null> {
  if (KIND_INFO[kind].source !== "telemetry") return null;
  const settings = settingsOfRule({
    id: "",
    projectId,
    projectName: "",
    kind,
    settings: stored,
    updatedAt: now,
    activeSince: now,
  });
  const from = new Date(now.getTime() - SEEN_MS);
  const scope = { projectId, environment: settings.environment };
  const where = `in ${settings.environment} in the last 24 hours`;
  try {
    if (isStopped(settings)) {
      const seen = await arrivedCount(reader, projectId, settings, { from, to: now }, 1);
      return seen > 0 ? null : notSeen(stoppedNotSeenMessage(settings));
    }
    if (isAiRule(settings)) {
      const seen = await aiRuleSeen(reader, projectId, settings, from, now);
      return seen ? null : notSeen(aiNotSeenMessage(settings));
    }
    if (isMetric(settings)) {
      const seen = await metricSeen(
        reader,
        scope,
        {
          name: settings.metric,
          kind: settings.metricKind,
          resource: settings.host === null ? undefined : { key: HOST_KEY, value: settings.host },
          attribute:
            settings.attributeKey === null || settings.attributeValue === null
              ? undefined
              : { keys: [settings.attributeKey], value: settings.attributeValue },
        },
        from,
        now,
      );
      return seen
        ? null
        : notSeen(
            `No point from the ${settings.metricKind} ${settings.metric}${filtersText(settings)} arrived ${where}. The rule is saved. Monitoring starts when the metric reports.`,
          );
    }
    const seen = await requestsSeen(reader, {
      ...scope,
      from,
      to: now,
      service: settings.service,
      route: settings.route,
    });
    return seen
      ? null
      : notSeen(
          `No request from ${settings.service}${settings.route === null ? "" : ` on the route ${cut(settings.route, QUOTE_CHARS)}`} arrived ${where}. The rule is saved. Monitoring starts when the service reports.`,
        );
  } catch {
    return {
      reason: "not_checked",
      message:
        "The rule is saved. Its monitored data could not be checked for reports in the last 24 hours.",
    };
  }
}
