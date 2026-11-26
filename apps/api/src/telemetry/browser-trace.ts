/**
 * A trace's browser part (docs/telemetry.md, "From the browser"): the
 * browser events that name the trace. A page load's pageview, errors, and
 * Web Vitals carry the trace the server named in Server-Timing
 * (`trace_id`), and an error carries the traces of the page's last requests
 * (`error_requests`). Read by project first, in a bounded window around the
 * trace.
 */
import { fromClickHouseTime, QueryParams, queryRows, type Reader } from "../clickhouse/query.ts";
import { ERROR } from "../visits/visits.ts";
import { DASHBOARD_SETTINGS } from "./dashboard-query.ts";

/** Errors listed, at most: a trace has one page load, and few errors name it. */
export const MAX_BROWSER_ERRORS = 10;
/** Events come after the server's span starts; the hour covers clocks that disagree. */
const BEFORE_MS = 3_600_000;
/** An error can come long after the page loaded, or after the request it carries. */
const AFTER_MS = 24 * 3_600_000;

/** A browser's page view or error, without anything its reader may not see. */
export interface BrowserView {
  occurredAt: Date;
  path: string;
  browser: string | null;
  browserVersion: string | null;
  os: string | null;
  release: string | null;
  environment: string;
  /** null for an anonymous visitor, or without the users area. */
  userId: string | null;
}

export interface BrowserError extends BrowserView {
  eventId: string;
  fingerprint: string;
  type: string;
  message: string;
  /** null without the replays area, or without a replay. */
  replayId: string | null;
  /** The request of this trace the error carries; null when the error is of the page load. */
  request: { method: string; path: string; status: number; durationMs: number } | null;
}

export interface BrowserTrace {
  /** The pageview of the page load whose server work the trace is. */
  pageLoad: BrowserView | null;
  /** Oldest first; empty without the errors area. */
  errors: BrowserError[];
}

/** What the reader may see beside monitoring (docs/access.md). */
export interface BrowserTraceAccess {
  errors: boolean;
  users: boolean;
  replays: boolean;
}

interface Row {
  event_id: string;
  name: string;
  occurred_at: string;
  path: string;
  browser: string | null;
  browser_version: string | null;
  os: string | null;
  release: string | null;
  environment: string;
  user_id: string | null;
  error_type: string;
  error_message: string;
  error_fingerprint: string;
  replay_id: string | null;
  page_load: number | boolean;
  /** 1-based; 0 when the error does not carry a request of the trace. */
  request_index: number;
  error_requests: { method: string; path: string; status: number; duration_ms: number }[];
}

export async function browserTrace(
  reader: Reader,
  projectId: string,
  traceId: string,
  at: Date,
  see: BrowserTraceAccess,
): Promise<BrowserTrace> {
  const params = new QueryParams();
  const trace = params.add(traceId, "String");
  const names = see.errors ? ["pageview", ERROR] : ["pageview"];
  // A server's exception shares trace_id: service tells it apart.
  const rows = await queryRows<Row>(
    reader,
    `SELECT event_id, name, occurred_at, path, browser, browser_version, os, release,
            environment, user_id, error_type, error_message, error_fingerprint, replay_id,
            trace_id = ${trace} AS page_load,
            arrayFirstIndex(r -> r.trace_id = ${trace}, error_requests) AS request_index,
            error_requests
     FROM events FINAL
     WHERE project_id = ${params.add(projectId, "UUID")}
       AND occurred_at >= ${params.time(new Date(at.getTime() - BEFORE_MS))}
       AND occurred_at < ${params.time(new Date(at.getTime() + AFTER_MS))}
       AND service = ''
       AND name IN ${params.add(names, "Array(String)")}
       AND (trace_id = ${trace} OR has(error_requests.trace_id, ${trace}))
     ORDER BY occurred_at, event_id
     LIMIT ${MAX_BROWSER_ERRORS + 1}`,
    params,
    DASHBOARD_SETTINGS,
  );
  const view = (row: Row): BrowserView => ({
    occurredAt: fromClickHouseTime(row.occurred_at),
    path: row.path,
    browser: row.browser,
    browserVersion: row.browser_version,
    os: row.os,
    release: row.release,
    environment: row.environment,
    userId: see.users ? row.user_id : null,
  });
  const page = rows.find((row) => row.name === "pageview" && Boolean(row.page_load));
  return {
    pageLoad: page === undefined ? null : view(page),
    errors: rows
      .filter((row) => row.name === ERROR && row.error_fingerprint !== "")
      .slice(0, MAX_BROWSER_ERRORS)
      .map((row) => {
        const request = row.page_load ? undefined : row.error_requests[row.request_index - 1];
        return {
          ...view(row),
          eventId: row.event_id,
          fingerprint: row.error_fingerprint,
          type: row.error_type,
          message: row.error_message,
          replayId: see.replays ? row.replay_id : null,
          request:
            request === undefined
              ? null
              : {
                  method: request.method,
                  path: request.path,
                  status: request.status,
                  durationMs: request.duration_ms,
                },
        };
      }),
  };
}
