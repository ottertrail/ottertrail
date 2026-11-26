import { QueryParams, queryRows, type Reader } from "../clickhouse/query.ts";
import { MAX_NOTIFICATION_URL, type Subject } from "../notifications/events.ts";
import { DASHBOARD_SETTINGS } from "../telemetry/dashboard-query.ts";
import { filterConditions, type Severity } from "../telemetry/logs.ts";
import { type AlertContext, cut, dashboardLink } from "./fire.ts";
import type { LogLineSettings } from "./kinds.ts";
import {
  arrivedCount,
  stoppedWindowAt,
  TELEMETRY_AHEAD_MS,
  TELEMETRY_LATE_MS,
  windowText,
} from "./stopped-rules.ts";

/**
 * "Log lines match" rules (docs/uptime-alerts.md, "Alerts on matching log lines"): more than
 * `maxCount` log lines that the Logs page's filters find arrived in the window. They run with the
 * telemetry rules once a minute (telemetry-rules.ts) and resolve once a window holds no more.
 *
 * The filters are the Logs page's own conditions (telemetry/logs.ts, filterConditions), so a
 * rule and the page match the same lines, words through the body's text index. Lines are
 * counted by when they arrived (`received_at`), as "data stops arriving" rules count, so a late
 * line is counted once and never missed; the event time is bounded too, since the table is
 * ordered by it. The count stops at `maxCount + 1` (LIMIT) and reads without FINAL: a retried
 * copy counts twice until its day is merged.
 */

export const isLogLines = (settings: object): settings is LogLineSettings => "maxCount" in settings;

export interface LogLinesReading {
  /** Matching lines that arrived in the window, counted up to the rule's maxCount + 1. */
  value: number;
  from: Date;
  to: Date;
}

/**
 * The query that counts a rule's matching lines that arrived after `from` and up to `to`, up to
 * `limit`: the project first, then the event times a line arriving in the window may have.
 */
export function matchingLinesQuery(
  projectId: string,
  settings: LogLineSettings,
  { from, to }: { from: Date; to: Date },
  limit: number,
): { query: string; params: QueryParams } {
  const params = new QueryParams();
  const conditions = filterConditions(
    params,
    { projectId, environment: settings.environment },
    {
      service: settings.service ?? undefined,
      severity: settings.severity ?? undefined,
      search: settings.search ?? undefined,
    },
  );
  conditions.splice(
    1,
    0,
    `timestamp >= ${params.time(new Date(from.getTime() - TELEMETRY_LATE_MS))}`,
    `timestamp <= ${params.time(new Date(to.getTime() + TELEMETRY_AHEAD_MS))}`,
    `received_at > ${params.time(from)}`,
    `received_at <= ${params.time(to)}`,
  );
  return {
    query: `SELECT count() AS count FROM (
      SELECT 1 FROM logs WHERE ${conditions.join(" AND ")} LIMIT ${params.add(limit, "UInt32")})`,
    params,
  };
}

export async function matchingLines(
  reader: Reader,
  projectId: string,
  settings: LogLineSettings,
  window: { from: Date; to: Date },
  limit: number,
): Promise<number> {
  const { query, params } = matchingLinesQuery(projectId, settings, window, limit);
  const [row] = await queryRows<{ count: string }>(reader, query, params, DASHBOARD_SETTINGS);
  return Math.min(Number(row?.count ?? 0), limit);
}

/** Read a rule's window, which ends ARRIVAL_LAG_MS before `at` (stoppedWindowAt). */
export async function readLogLines(
  reader: Reader,
  rule: { projectId: string },
  settings: LogLineSettings,
  at: Date,
): Promise<LogLinesReading> {
  const window = stoppedWindowAt(at, settings.windowMinutes);
  return {
    value: await matchingLines(reader, rule.projectId, settings, window, settings.maxCount + 1),
    ...window,
  };
}

export const logLinesBreach = (settings: LogLineSettings, value: number) =>
  value > settings.maxCount;

const SEVERITY_TEXT: Record<Severity, string> = {
  trace: "Trace",
  debug: "Debug",
  info: "Info",
  warn: "Warning",
  error: "Error",
  fatal: "Fatal",
};

/** The longest service or words a message quotes. */
const QUOTE_CHARS = 300;

/**
 * The rule's filter as words: "log lines of Error or above from api with the words "timeout"
 * in production". Only the rule's settings: never a line's text, which can hold personal data.
 */
function linesText(settings: LogLineSettings, count: number): string {
  const lines = count === 1 ? "log line" : "log lines";
  const severity =
    settings.severity === null
      ? ""
      : settings.severity === "fatal"
        ? " of Fatal"
        : ` of ${SEVERITY_TEXT[settings.severity]} or above`;
  const service = settings.service === null ? "" : ` from ${cut(settings.service, QUOTE_CHARS)}`;
  const words =
    settings.search === null ? "" : ` with the words "${cut(settings.search, QUOTE_CHARS)}"`;
  return `${lines}${severity}${service}${words} in ${settings.environment}`;
}

export function logLinesMessage(
  project: string,
  settings: LogLineSettings,
  count: number,
  resolved: boolean,
): string {
  const window = `in the last ${windowText(settings.windowMinutes)}`;
  const most = settings.maxCount.toLocaleString("en");
  if (resolved) {
    return settings.maxCount === 0
      ? `${project}: no ${linesText(settings, 0)} ${window}.`
      : `${project}: ${count.toLocaleString("en")} ${linesText(settings, count)} ${window}, at or below the rule's ${most}.`;
  }
  // The count stops at maxCount + 1, so it says at least that many.
  return settings.maxCount === 0
    ? `${project}: at least 1 ${linesText(settings, 1)} ${window}.`
    : `${project}: more than ${most} ${linesText(settings, settings.maxCount + 1)} ${window}.`;
}

export function logLinesSubject(settings: LogLineSettings, count: number): Subject {
  return {
    type: "log_lines",
    environment: settings.environment,
    service: settings.service === null ? null : cut(settings.service, QUOTE_CHARS),
    severity: settings.severity,
    search: settings.search === null ? null : cut(settings.search, QUOTE_CHARS),
    windowMinutes: settings.windowMinutes,
    maxCount: settings.maxCount,
    /** At least this many: the count stops at maxCount + 1. */
    count,
  };
}

export function logLinesSubjectName(settings: LogLineSettings): string {
  const parts = [
    ...(settings.service === null ? [] : [settings.service]),
    ...(settings.severity === null ? [] : [SEVERITY_TEXT[settings.severity]]),
    ...(settings.search === null ? [] : [`"${settings.search}"`]),
  ];
  return parts.length === 0 ? "Logs" : `Logs (${parts.join(", ")})`;
}

/**
 * The Logs page opened before the window: a line arrives a little after its own time, so the
 * link starts this much earlier than the window's first arrival.
 */
export const LINK_LEAD_MS = 5 * 60_000;
const MINUTE_MS = 60_000;

/**
 * The Logs page with the rule's filters, from LINK_LEAD_MS before the window to `at`, in whole
 * minutes. The longest filters are dropped first when the link is too long; the message keeps
 * them.
 */
export function logLinesLink(
  context: AlertContext,
  projectId: string,
  settings: LogLineSettings,
  window: { from: Date },
  at: Date,
): string {
  const path = `/projects/${projectId}/logs`;
  const start = Math.floor((window.from.getTime() - LINK_LEAD_MS) / MINUTE_MS) * MINUTE_MS;
  const end = Math.ceil(at.getTime() / MINUTE_MS) * MINUTE_MS;
  const base: Record<string, string> = {
    env: settings.environment,
    ...(settings.severity === null ? {} : { severity: settings.severity }),
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
  };
  const service: Record<string, string> =
    settings.service === null ? {} : { service: settings.service };
  const words: Record<string, string> = settings.search === null ? {} : { q: settings.search };
  for (const query of [{ ...base, ...service, ...words }, { ...base, ...service }, base]) {
    const url = dashboardLink(context.publicUrl, path, query);
    if (url.length <= MAX_NOTIFICATION_URL) return url;
  }
  return dashboardLink(context.publicUrl, path);
}

/** Whether any line of the rule's service arrived in its environment in the last day. */
export async function logLinesSeen(
  reader: Reader,
  projectId: string,
  settings: LogLineSettings,
  window: { from: Date; to: Date },
): Promise<boolean> {
  const seen = await arrivedCount(
    reader,
    projectId,
    {
      source: "logs",
      environment: settings.environment,
      service: settings.service,
      eventName: null,
      metric: null,
      host: null,
      windowMinutes: settings.windowMinutes,
      minCount: 1,
    },
    window,
    1,
  );
  return seen > 0;
}

export function logLinesNotSeenMessage(settings: LogLineSettings): string {
  const from = settings.service === null ? "" : ` from ${cut(settings.service, QUOTE_CHARS)}`;
  return `No log lines${from} arrived in ${settings.environment} in the last 24 hours. The rule is saved. Monitoring starts when the service sends logs.`;
}
