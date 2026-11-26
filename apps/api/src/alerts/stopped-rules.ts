import { QueryParams, queryRows, type Reader } from "../clickhouse/query.ts";
import { MAX_EVENT_AGE_MS } from "../collection/normalize.ts";
import { MAX_FUTURE_MS } from "../collection/server-events.ts";
import type { Subject } from "../notifications/events.ts";
import { DASHBOARD_SETTINGS } from "../telemetry/dashboard-query.ts";
import { HOST_KEY } from "../telemetry/hosts.ts";
import { analyticsEvent } from "../visits/visits.ts";
import { ARRIVAL_LAG_MS } from "./error-rules.ts";
import { type AlertContext, cut, dashboardLink } from "./fire.ts";
import type { StoppedSettings } from "./kinds.ts";

/**
 * "Data stops arriving" rules (docs/uptime-alerts.md, "Alerts on data that stops arriving"):
 * fewer than `minCount` records of one source arrived in the window. They run with the telemetry
 * rules once a minute (telemetry-rules.ts) and resolve as soon as enough arrive again.
 *
 * Records are counted by when they arrived (`received_at`), so late or backfilled data does not
 * hide a stop. Every table is ordered by project, then its event time, so the event time is
 * bounded too: events arrive at most a day after they happened (collection/normalize.ts), and
 * telemetry is counted only when it arrives within TELEMETRY_LATE_MS of its time. Each query
 * reads at most `minCount` matching rows (LIMIT), without FINAL: a retried copy counts twice,
 * which can only delay an alert, never cause one.
 */

/** Telemetry that arrives later than this after its own time is not counted. */
export const TELEMETRY_LATE_MS = 3_600_000;
/** How far ahead of the server's clock OTLP takes a record's time (telemetry/normalize.ts). */
export const TELEMETRY_AHEAD_MS = 3_600_000;

export const isStopped = (settings: object): settings is StoppedSettings => "minCount" in settings;

export interface StoppedReading {
  /** Records that arrived in the window, counted up to the rule's minCount; null in its first window. */
  value: number | null;
  from: Date;
  to: Date;
}

/** The window ends ARRIVAL_LAG_MS before `at`, so an insert still landing is counted. */
export function stoppedWindowAt(at: Date, windowMinutes: number): { from: Date; to: Date } {
  const to = new Date(at.getTime() - ARRIVAL_LAG_MS);
  return { from: new Date(to.getTime() - windowMinutes * 60_000), to };
}

/**
 * The records of a rule's source that arrived after `from` and up to `to`, counted up to
 * `limit`. Filters by project first and reads only the window's event times.
 */
export async function arrivedCount(
  reader: Reader,
  projectId: string,
  settings: StoppedSettings,
  { from, to }: { from: Date; to: Date },
  limit: number,
): Promise<number> {
  const params = new QueryParams();
  const project = `project_id = ${params.add(projectId, "UUID")}`;
  const arrived = `received_at > ${params.time(from)} AND received_at <= ${params.time(to)}`;
  const environment = `environment = ${params.add(settings.environment, "String")}`;
  const cap = params.add(limit, "UInt32");
  const selects: string[] = [];
  if (settings.source === "events") {
    selects.push(`SELECT 1 FROM events
      WHERE ${project}
        AND occurred_at >= ${params.time(new Date(from.getTime() - MAX_EVENT_AGE_MS))}
        AND occurred_at <= ${params.time(new Date(to.getTime() + MAX_FUTURE_MS))}
        AND ${arrived} AND ${environment} AND ${analyticsEvent()}
        ${settings.eventName === null ? "" : `AND name = ${params.add(settings.eventName, "String")}`}
      LIMIT ${cap}`);
  } else {
    const times = `timestamp >= ${params.time(new Date(from.getTime() - TELEMETRY_LATE_MS))}
        AND timestamp <= ${params.time(new Date(to.getTime() + TELEMETRY_AHEAD_MS))}`;
    if (settings.source === "metrics") {
      const name = `name = ${params.add(settings.metric ?? "", "String")}`;
      const host =
        settings.host === null
          ? ""
          : `AND resource_attributes[${params.add(HOST_KEY, "String")}] = ${params.add(settings.host, "String")}`;
      for (const table of ["metric_points", "metric_histograms"]) {
        selects.push(`SELECT 1 FROM ${table}
          WHERE ${project} AND ${name} AND ${times} AND ${arrived} AND ${environment} ${host}
          LIMIT ${cap}`);
      }
    } else {
      const table = settings.source === "traces" ? "spans" : "logs";
      selects.push(`SELECT 1 FROM ${table}
        WHERE ${project} AND ${times} AND ${arrived} AND ${environment}
          ${settings.service === null ? "" : `AND service = ${params.add(settings.service, "String")}`}
        LIMIT ${cap}`);
    }
  }
  const [row] = await queryRows<{ count: string }>(
    reader,
    `SELECT count() AS count FROM (${selects.map((select) => `(${select})`).join(" UNION ALL ")})`,
    params,
    DASHBOARD_SETTINGS,
  );
  return Math.min(Number(row?.count ?? 0), limit);
}

/**
 * Read a rule's window. A rule younger than one window (since it was added, turned on, or
 * changed) has no value yet: its source has not had a whole window to send.
 */
export async function readStopped(
  reader: Reader,
  rule: { projectId: string; activeSince: Date },
  settings: StoppedSettings,
  at: Date,
): Promise<StoppedReading> {
  const window = stoppedWindowAt(at, settings.windowMinutes);
  if (window.from < rule.activeSince) return { value: null, ...window };
  return {
    value: await arrivedCount(reader, rule.projectId, settings, window, settings.minCount),
    ...window,
  };
}

const plural = (count: number, one: string) =>
  `${count.toLocaleString("en")} ${count === 1 ? one : `${one}s`}`;

/** A window as words: "30 minutes", "1 hour", "24 hours". */
export const windowText = (minutes: number) =>
  minutes % 60 === 0 ? plural(minutes / 60, "hour") : plural(minutes, "minute");

/** The longest name or host a message quotes. */
const QUOTE_CHARS = 300;

const quoted = (text: string | null) => (text === null ? null : cut(text, QUOTE_CHARS));

/** What the rule counts, as words: "events named signup", "spans of the service api". */
function whatOf(settings: StoppedSettings): string {
  const service = quoted(settings.service);
  if (settings.source === "events") {
    const name = quoted(settings.eventName);
    return name === null ? "events" : `events named ${name}`;
  }
  if (settings.source === "traces") {
    return service === null ? "spans" : `spans of the service ${service}`;
  }
  if (settings.source === "logs") {
    return service === null ? "log records" : `log records of the service ${service}`;
  }
  const host = quoted(settings.host);
  return `points of the metric ${settings.metric ?? ""}${host === null ? "" : ` on the host ${host}`}`;
}

const capitalized = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

export function stoppedMessage(
  project: string,
  settings: StoppedSettings,
  count: number,
  resolved: boolean,
): string {
  const what = whatOf(settings);
  const where = `from ${project} in ${settings.environment}`;
  const window = `the last ${windowText(settings.windowMinutes)}`;
  if (resolved) {
    const atLeast =
      settings.minCount === 1
        ? ""
        : ` At least ${settings.minCount.toLocaleString("en")} arrived in ${window}.`;
    return `${capitalized(what)} arrive again ${where}.${atLeast}`;
  }
  if (count === 0) return `No ${what} ${where} in ${window}.`;
  return `Only ${count.toLocaleString("en")} ${what} ${where} in ${window}, fewer than the rule's ${settings.minCount.toLocaleString("en")}.`;
}

export function stoppedSubject(settings: StoppedSettings, count: number): Subject {
  return {
    type: "data_stopped",
    source: settings.source,
    environment: settings.environment,
    eventName: quoted(settings.eventName),
    service: quoted(settings.service),
    metric: settings.metric,
    host: quoted(settings.host),
    windowMinutes: settings.windowMinutes,
    minCount: settings.minCount,
    count,
  };
}

const SOURCE_NAME = { events: "Events", traces: "Spans", logs: "Logs", metrics: "Metric" } as const;

export function stoppedSubjectName(settings: StoppedSettings): string {
  const name = SOURCE_NAME[settings.source];
  if (settings.source === "metrics") {
    const metric = `${name} ${settings.metric ?? ""}`;
    return settings.host === null ? metric : `${metric} (${settings.host})`;
  }
  const filter = settings.source === "events" ? settings.eventName : settings.service;
  return filter === null ? name : `${name} (${filter})`;
}

/** The rule's page on the Alerts page: its source has nothing new to show. */
export const stoppedLink = (context: AlertContext, projectId: string, ruleId: string) =>
  dashboardLink(context.publicUrl, `/projects/${projectId}/alerts/${ruleId}`);

/** The warning when nothing the rule counts arrived in the last day. */
export function stoppedNotSeenMessage(settings: StoppedSettings): string {
  return `No ${whatOf(settings)} arrived in ${settings.environment} in the last 24 hours. The rule is saved, and fires once it is a window old unless they arrive.`;
}
