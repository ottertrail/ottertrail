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
  TELEMETRY_KINDS,
} from "./kinds.ts";

/**
 * Telemetry rules (docs/uptime-alerts.md, "Alerts on telemetry"): a
 * route's latency or failed share, and a metric above or below a value,
 * each over its window; and AI rules (ai-rules.ts; docs/ai-usage.md): the
 * estimated cost of AI calls, their failed share, or their 95th-percentile
 * duration. Each rule is due once a minute; the worker takes due rules from PostgreSQL with FOR UPDATE
 * SKIP LOCKED (takeDueRules),
 * so each is evaluated by one worker however many run, and evaluates
 * them from the same computations as the dashboard's pages: the Services
 * page's counts (telemetry/services.ts, routeWindows) and a metric's
 * chart, as one bucket covering the window (telemetry/metrics.ts,
 * metricWindow).
 *
 * - **Bounds:** every query filters by project first, takes every value
 *   as a parameter, reads only the window (a metric also the time before
 *   it that a counter's first step needs), and runs with the dashboard's
 *   limits, read-only, so a query whose reader is aborted stops. A
 *   project's due route rules of one environment are read in one query
 *   over the longest of their windows (at most 30 minutes); each metric
 *   rule in its own. At most TELEMETRY_CONCURRENCY projects are evaluated
 *   at once, each within PROJECT_BUDGET_MS: every query's time limit is
 *   cut to what is left of it, and rules not reached are recorded as
 *   failed and taken again the next minute. A rule that fails is recorded
 *   on the rule (recordEvaluation) and the others go on.
 * - **The window** ends TELEMETRY_LAG_MS before the evaluation: metrics
 *   are exported every minute by default, so the last minute's points may
 *   not have arrived yet; a counter's step that ends after the window still
 *   counts the part inside it.
 * - **Firing and resolving:** a rule fires when the window's value is on
 *   the wrong side of its threshold (above it, or below it for a metric
 *   rule that says below), and resolves once the value has been back on
 *   the right side at every evaluation for a whole window, so a value
 *   that hovers at the threshold does not flap.
 * - **No data** (no point of the metric, or fewer requests than the rule's
 *   minimum) never fires, and never counts toward resolving: a firing
 *   alert stays firing through it, and its time back on the right side
 *   starts again once data is back. Changing the rule, or turning it off,
 *   ends the alert without a notification (rules.ts).
 */

/** Projects evaluated at once by one worker. */
export const TELEMETRY_CONCURRENCY = 4;
/** How often the worker looks for due telemetry rules. */
export const TELEMETRY_TICK_MS = 5_000;
/** How often each rule is due. */
export const EVALUATION_INTERVAL_MS = 60_000;
/** Due rules one look takes at most. */
export const MAX_DUE_RULES = 200;
/** How far behind the evaluation a rule's window ends. */
export const TELEMETRY_LAG_MS = 60_000;
/** How long one project's due rules may take in a pass: each query gets what is left. */
export const PROJECT_BUDGET_MS = 20_000;

/** A telemetry rule as the worker reads it. */
export interface TelemetryRule {
  id: string;
  projectId: string;
  projectName: string;
  kind: RuleKind;
  settings: unknown;
  /** Its last change: an alert goes ahead only while the rule is still the one read. */
  updatedAt: Date;
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
          },
        ]
      : [],
  );
}

/**
 * Takes up to `limit` due telemetry rules (never evaluated since added or
 * changed, or due by `at`), oldest due first, returned by project, then
 * the rule's age, and moves each one's next
 * evaluation a minute on in the same statement, keeping its place in the
 * minute (or a minute from `at`, after a gap): committed before the
 * evaluation, so a second worker never takes the same rule that minute,
 * and a worker that stops mid-way leaves the rule to the next minute.
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
      r.created_at
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
            },
          ]
        : [],
    );
}

/** Rules taken but not evaluated (the worker is stopping): due again at once, for any worker. */
export async function releaseRules(db: Kysely<Database>, ruleIds: string[]): Promise<void> {
  if (ruleIds.length === 0) return;
  await db
    .updateTable("alert_rules")
    .set({ next_evaluation_at: null })
    .where("id", "in", ruleIds)
    .execute();
}

/** The longest reason recorded for a failed evaluation. */
const MAX_REASON = 300;

/** Why an evaluation failed, in words the Alerts page shows. */
export function reasonOf(error: unknown): string {
  if (error instanceof DeadlineError) {
    return "The project's rules reached their time limit for this minute before this rule could be read.";
  }
  const text = error instanceof Error ? error.message : String(error);
  return cut(text === "" ? "The evaluation failed." : text, MAX_REASON);
}

/**
 * Records how a rule's evaluation went: a failure keeps its reason and
 * since when the rule has failed; a success clears both. Returns whether
 * the rule just started failing ("failing") or works again ("recovered"),
 * for a log line once per outage, or null when nothing changed.
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

/** What a rule's window read. */
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

/** The window a rule reads when evaluated at `at`. */
export function windowAt(at: Date, windowMinutes: number): { from: Date; to: Date } {
  const to = new Date(at.getTime() - TELEMETRY_LAG_MS);
  return { from: new Date(to.getTime() - windowMinutes * 60_000), to };
}

type Settings = LatencySettings | FailureSettings | MetricSettings | AiSettings;

function settingsOfRule(rule: TelemetryRule): Settings {
  if (rule.kind === "route_latency") return latencySettingsOf(rule.settings);
  if (rule.kind === "route_failures") return failureSettingsOf(rule.settings);
  if (rule.kind === "ai_cost") return aiCostSettingsStored(rule.settings);
  if (rule.kind === "ai_failures") return aiFailureSettingsStored(rule.settings);
  if (rule.kind === "ai_latency") return aiLatencySettingsStored(rule.settings);
  return metricSettingsStored(rule.settings);
}

type RouteSettings = LatencySettings | FailureSettings;

const isMetric = (settings: Settings): settings is MetricSettings => "metric" in settings;
const isLatency = (settings: Settings): settings is LatencySettings => "thresholdMs" in settings;

/** An AI rule's window at `at`, as the AI page reads it (ai-rules.ts). */
async function readAiRule(
  context: AlertContext,
  reader: Reader,
  rule: TelemetryRule,
  settings: AiSettings,
  at: Date,
): Promise<Reading> {
  return readAi(context.db, reader, rule, settings, at, TELEMETRY_LAG_MS);
}

/** A metric rule's window at `at`, as its chart reads it. */
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

/** A route rule's reading from its window's counts. */
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
 * Route rules of one project and environment, at `at`: one read of the
 * longest of their windows, each rule counted over its own (routeWindows).
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

/** Whether a value is on the wrong side of the rule's threshold. */
function breaches(settings: Settings, value: number): boolean {
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
 * A unit as a message shows it, such as " ms" or " By": none for "1",
 * none, or an annotation in braces such as "{request}", which names what
 * is counted rather than a unit ("17 request" would not read).
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

/** What a rule's history shows as its subject. */
function subjectName(settings: Settings): string {
  if (isAiRule(settings)) return aiSubjectName(settings);
  if (isMetric(settings)) return `${settings.metric} (${settings.aggregate})`;
  return settings.route === null ? settings.service : `${settings.service} ${settings.route}`;
}

/**
 * The page about what a rule watches: the service on the Services page,
 * its route marked, or the metric's page with its filters. A filter that
 * would take the address past a notification's limit is left out of it
 * (the message still names it), the longest first; past the limit even
 * without them, the link is the project's Services or Metrics page.
 */
export function telemetryLink(
  context: AlertContext,
  projectId: string,
  settings: Settings,
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

/** The notification's subject: what it watches, the value, the threshold, the window, the requests. */
function subjectOf(settings: Settings, reading: Reading & { value: number }): Subject {
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

/** The message when a rule fires, or resolves. */
function messageOf(
  project: string,
  settings: Settings,
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

/** The rule is still the one read: not changed, so not watching something else, since. */
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

/** What one rule's evaluation did: its reading, and what it sent, if anything. */
export interface RuleResult {
  reading: Reading;
  outcome: Outcome | "cleared" | "waiting" | "none";
}

/**
 * Evaluates one rule at `at`: reads its window (a route rule as a batch
 * of one), then acts on it (judge).
 */
export async function evaluateTelemetryRule(
  context: AlertContext,
  reader: Reader,
  rule: TelemetryRule,
  at: Date,
): Promise<RuleResult> {
  const settings = settingsOfRule(rule);
  const reading = isAiRule(settings)
    ? await readAiRule(context, reader, rule, settings, at)
    : isMetric(settings)
      ? await readMetric(reader, rule, settings, at)
      : (
          await readRoutes(reader, rule.projectId, settings.environment, [{ rule, settings }], at)
        )[0];
  if (reading === undefined) throw new Error("A route rule's batch read nothing");
  return judge(context, rule, settings, reading, at);
}

/**
 * Acts on a rule's reading at `at`: fires, starts or stops the time it
 * has been back on the right side, or resolves.
 */
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
    // No data: never fires, and the time back on the right side starts again.
    if (firing && state.clear_since !== null) {
      await setClearSince(context.db, rule.id, "", null);
    }
    return { reading, outcome: "none" };
  }
  const read = { ...reading, value };
  const message = {
    url: telemetryLink(context, rule.projectId, settings),
    subject: subjectOf(settings, read),
    at,
  };
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
      message: messageOf(rule.projectName, settings, read, false),
      still: unchanged(rule),
      ...message,
    });
    return { reading, outcome };
  }
  if (!firing) return { reading, outcome: "none" };
  if (state.clear_since === null) {
    await setClearSince(context.db, rule.id, "", at);
    return { reading, outcome: "waiting" };
  }
  const clearMinutes = isAiRule(settings) ? aiClearMinutes(settings) : settings.windowMinutes;
  if (at.getTime() - state.clear_since.getTime() < clearMinutes * 60_000) {
    return { reading, outcome: "waiting" };
  }
  const resolves = KIND_INFO[rule.kind].resolves;
  if (resolves === null) return { reading, outcome: "none" };
  const outcome = await resolve(context, {
    ruleId: rule.id,
    subjectKey: "",
    type: resolves,
    message: messageOf(rule.projectName, settings, read, true),
    still: unchanged(rule),
    ...message,
  });
  return { reading, outcome };
}

/** One rule's evaluation in a pass: what it did, or why it failed. */
export type PassResult =
  | { rule: TelemetryRule; result: RuleResult }
  | { rule: TelemetryRule; error: unknown };

export interface PassOptions {
  /** The reader for one project's queries; `deadline` is when its budget ends. */
  readerOf: (projectId: string, deadline: number) => Reader;
  now?: () => Date;
  /** Projects evaluated at once. */
  concurrency?: number;
  /** How long one project's rules may take. */
  budgetMs?: number;
  /** Whether the worker is stopping: no rule starts once it is. */
  stopping?: () => boolean;
}

/** A project's work in a pass: its route rules per environment, then each metric and AI rule. */
function stepsOf(rules: readonly TelemetryRule[]) {
  const routes = new Map<string, { rule: TelemetryRule; settings: RouteSettings }[]>();
  const metrics: { rule: TelemetryRule; settings: MetricSettings }[] = [];
  const ai: { rule: TelemetryRule; settings: AiSettings }[] = [];
  for (const rule of rules) {
    const settings = settingsOfRule(rule);
    if (isAiRule(settings)) {
      ai.push({ rule, settings });
    } else if (isMetric(settings)) {
      metrics.push({ rule, settings });
    } else {
      const group = routes.get(settings.environment) ?? [];
      group.push({ rule, settings });
      routes.set(settings.environment, group);
    }
  }
  return { routes: [...routes], metrics, ai };
}

/**
 * Evaluates the rules taken (takeDueRules), a project at a time, at most
 * `concurrency` projects at once. A project's route rules of one
 * environment are read in one query, its metric rules one by one, each
 * group at its own time; all its queries end by its budget. A failure
 * (a query past its limits or the budget) is recorded in the results of
 * the rules it was for, and the others go on. Once `stopping`, nothing
 * more starts: the rules not reached are returned in `released`.
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
      // The budget is real time, whatever clock the evaluation reads (tests fix theirs).
      const reader = readerOf(projectId, Date.now() + budgetMs);
      const { routes, metrics, ai } = stepsOf(projectRules);
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

/** How many notifications a pass sent, held back, or skipped. */
export function countsOf(results: readonly PassResult[]): Counts {
  const counts: Counts = { sent: 0, held: 0, skipped: 0 };
  for (const item of results) {
    if (!("result" in item)) continue;
    const { outcome } = item.result;
    if (outcome === "sent" || outcome === "held" || outcome === "skipped") counts[outcome] += 1;
  }
  return counts;
}

/** How far back a rule's service, route, or metric is looked for when it is saved: a day. */
export const SEEN_MS = 86_400_000;

/** Why a rule just saved may not fire: what it watches has not reported, or that could not be checked. */
export interface SaveWarning {
  reason: "not_seen" | "not_checked";
  message: string;
}

const notSeen = (message: string): SaveWarning => ({ reason: "not_seen", message });

/**
 * Why a telemetry rule may never fire: what it watches has not reported in
 * the last day (it may not be deployed yet), or that could not be
 * checked. null when it has. The rule is saved either way.
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
  });
  const from = new Date(now.getTime() - SEEN_MS);
  const scope = { projectId, environment: settings.environment };
  const where = `in ${settings.environment} in the last 24 hours`;
  try {
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
