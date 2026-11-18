import type { FastifyPluginCallback } from "fastify";
import type { Kysely } from "kysely";

import type { Auth } from "../auth/auth.ts";
import { requireSession } from "../auth/routes.ts";
import type { ClickHouseClient } from "../clickhouse/clickhouse.ts";
import type { Reader } from "../clickhouse/query.ts";
import { clickHouseErrorHandler } from "../clickhouse/route-errors.ts";
import { environmentOf } from "../collection/environment.ts";
import type { Database } from "../db/schema.ts";
import { type ProjectAccess, requireProjectAccess } from "../organizations/access.ts";
import { localDays } from "../reports/reports.ts";
import { RANGE_PROPERTIES, type RangeQuery, requestDays } from "../reports/routes.ts";
import { dayIn } from "../visitors/visitor-ids.ts";
import {
  CURSOR_PATTERN,
  cursorOf,
  MAX_NS,
  SERVICE_PATTERN,
  SPAN_ID_PATTERN,
  type TelemetryRange,
  TRACE_ID_PATTERN,
} from "./dashboard-query.ts";
import {
  logDetail,
  MAX_SEARCH_LENGTH,
  MAX_SEARCH_WORDS,
  searchLogs,
  searchWords,
  SEVERITIES,
  type Severity,
} from "./logs.ts";
import { listTraces, spanDetail, traceDetail, traceWindow } from "./traces.ts";

const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

/** A moment as the dashboard sends it: an ISO 8601 time in UTC, such as an error's occurrence. */
const MOMENT_PATTERN = "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{1,9})?Z$";

/** The longest minimum duration a filter takes: a day, in milliseconds. */
const MAX_MIN_DURATION_MS = 86_400_000;

const PARAMS = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string", pattern: UUID_PATTERN } },
};

const TRACE_PARAMS = {
  type: "object",
  required: ["id", "traceId"],
  properties: {
    id: { type: "string", pattern: UUID_PATTERN },
    traceId: { type: "string", pattern: TRACE_ID_PATTERN },
  },
};

const SPAN_PARAMS = {
  type: "object",
  required: ["id", "traceId", "spanId"],
  properties: {
    id: { type: "string", pattern: UUID_PATTERN },
    traceId: { type: "string", pattern: TRACE_ID_PATTERN },
    spanId: { type: "string", pattern: SPAN_ID_PATTERN },
  },
};

const LOG_PARAMS = {
  type: "object",
  required: ["id", "logId"],
  properties: {
    id: { type: "string", pattern: UUID_PATTERN },
    logId: { type: "string", pattern: "^[0-9a-f]{32}$" },
  },
};

/** A time in nanoseconds since 1970, as a span's or log record's key holds it. */
const NS_QUERY = (name: string) => ({
  type: "object",
  required: [name],
  additionalProperties: false,
  properties: { [name]: { type: "string", pattern: "^[0-9]{1,19}$" } },
});

/** The access requireProjectAccess set: these routes always run it. */
function accessOf(request: { projectAccess: ProjectAccess | null }): ProjectAccess {
  if (request.projectAccess === null) {
    throw new Error("requireProjectAccess must run before this route");
  }
  return request.projectAccess;
}

type TracesQuery = RangeQuery & {
  service?: string;
  name?: string;
  errors?: boolean;
  minDuration?: number;
  before?: string;
};

type LogsQuery = RangeQuery & {
  service?: string;
  severity?: Severity;
  search?: string;
  traceId?: string;
  before?: string;
};

/**
 * GET /api/projects/:id/traces[?period=7d|from=…&to=…&environment=…&service=…&name=…&errors=true&minDuration=<ms>&before=<cursor>]
 * GET /api/projects/:id/traces/:traceId[?at=<ISO time>]
 *     (looked for a day either side of `at` when given, else in all the telemetry kept)
 * GET /api/projects/:id/traces/:traceId/spans/:spanId?start=<ns since 1970>
 * GET /api/projects/:id/logs[?period=…&environment=…&service=…&severity=warn&search=…&traceId=…&before=<cursor>]
 *     (summaries: the body cut to 1,000 characters)
 * GET /api/projects/:id/logs/:logId?time=<ns since 1970>
 *     (one whole record: body, attributes, resource attributes)
 *
 * The Traces and Logs pages (traces.ts, logs.ts). Like every project
 * route, each runs requireProjectAccess first, and reads only the project
 * it found.
 */
export const telemetryDashboardRoutes: FastifyPluginCallback<{
  db: Kysely<Database>;
  clickhouse: ClickHouseClient;
  auth: Auth;
  /** Days telemetry is kept (TELEMETRY_RETENTION_DAYS): nothing older is read. */
  retentionDays: number;
  now?: () => Date;
}> = (app, { db, clickhouse, auth, retentionDays, now = () => new Date() }, done) => {
  const signedIn = requireSession(auth);
  const projectAccess = requireProjectAccess(db);
  const reader: Reader = { client: clickhouse };
  app.setErrorHandler(clickHouseErrorHandler);

  /** The request's days, in the organization's timezone, from the oldest kept; or the reason it is refused. */
  async function rangeOf(request: {
    query: RangeQuery;
    projectAccess: ProjectAccess | null;
  }): Promise<{ range: TelemetryRange } | { problem: { error: string; message: string } }> {
    const { projectId, timeZone } = accessOf(request);
    const moment = now();
    const days = requestDays(request.query, dayIn(timeZone)(moment));
    if ("problem" in days) return days;
    const { from, to } = await localDays(db, days.from, days.to, timeZone);
    const kept = new Date(moment.getTime() - retentionDays * 86_400_000);
    const start = from < kept ? kept : from;
    return {
      range: {
        projectId,
        environment: environmentOf(request.query.environment),
        timeZone,
        firstDay: days.from,
        lastDay: days.to,
        from: start > to ? to : start,
        to,
      },
    };
  }

  const BAD_CURSOR = { error: "invalid_cursor", message: "before is out of range." };

  const answered = (range: TelemetryRange) => ({
    timeZone: range.timeZone,
    environment: range.environment,
    firstDay: range.firstDay,
    lastDay: range.lastDay,
    retentionDays,
  });

  app.get<{ Params: { id: string }; Querystring: TracesQuery }>(
    "/projects/:id/traces",
    {
      preHandler: [signedIn, projectAccess],
      schema: {
        params: PARAMS,
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            ...RANGE_PROPERTIES,
            service: { type: "string", pattern: SERVICE_PATTERN },
            name: { type: "string", minLength: 1, maxLength: MAX_SEARCH_LENGTH },
            errors: { type: "boolean" },
            minDuration: { type: "integer", minimum: 0, maximum: MAX_MIN_DURATION_MS },
            before: { type: "string", pattern: CURSOR_PATTERN },
          },
        },
      },
    },
    async (request, reply) => {
      const asked = await rangeOf(request);
      if ("problem" in asked) return reply.code(400).send(asked.problem);
      const { range } = asked;
      const { service, name, errors, minDuration } = request.query;
      const before = cursorOf(request.query.before);
      if (before === null) return reply.code(400).send(BAD_CURSOR);
      const list = await listTraces(reader, range, {
        service,
        name,
        errors: errors === true,
        minDurationMs: minDuration,
        before,
      });
      return { ...answered(range), ...list };
    },
  );

  app.get<{ Params: { id: string; traceId: string }; Querystring: { at?: string } }>(
    "/projects/:id/traces/:traceId",
    {
      preHandler: [signedIn, projectAccess],
      schema: {
        params: TRACE_PARAMS,
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: { at: { type: "string", pattern: MOMENT_PATTERN } },
        },
      },
    },
    async (request, reply) => {
      const { projectId, timeZone } = accessOf(request);
      const at = request.query.at === undefined ? undefined : new Date(request.query.at);
      if (at !== undefined && Number.isNaN(at.getTime())) {
        return reply.code(400).send({ error: "invalid_time", message: "at must be a real time." });
      }
      const traceId = request.params.traceId.toLowerCase();
      const detail = await traceDetail(
        reader,
        projectId,
        traceId,
        traceWindow(now(), retentionDays, at),
      );
      // A trace with nothing kept is an answer, not an error: the page says so.
      return { timeZone, retentionDays, ...detail };
    },
  );

  app.get<{
    Params: { id: string; traceId: string; spanId: string };
    Querystring: { start: string };
  }>(
    "/projects/:id/traces/:traceId/spans/:spanId",
    {
      preHandler: [signedIn, projectAccess],
      schema: {
        params: SPAN_PARAMS,
        querystring: NS_QUERY("start"),
      },
    },
    async (request, reply) => {
      const { projectId, timeZone } = accessOf(request);
      const start = BigInt(request.query.start);
      if (start > MAX_NS) {
        return reply.code(400).send({ error: "invalid_time", message: "start is out of range." });
      }
      const span = await spanDetail(
        reader,
        projectId,
        request.params.traceId.toLowerCase(),
        request.params.spanId.toLowerCase(),
        start,
      );
      if (span === null) {
        // Not "not_found", which the access check answers for an unknown project.
        return reply.code(404).send({
          error: "no_span",
          message: "No span with this ID is kept: it may be past the retention.",
        });
      }
      return { timeZone, span };
    },
  );

  app.get<{ Params: { id: string }; Querystring: LogsQuery }>(
    "/projects/:id/logs",
    {
      preHandler: [signedIn, projectAccess],
      schema: {
        params: PARAMS,
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            ...RANGE_PROPERTIES,
            service: { type: "string", pattern: SERVICE_PATTERN },
            severity: { type: "string", enum: Object.keys(SEVERITIES) },
            search: { type: "string", maxLength: MAX_SEARCH_LENGTH },
            traceId: { type: "string", pattern: TRACE_ID_PATTERN },
            before: { type: "string", pattern: CURSOR_PATTERN },
          },
        },
      },
    },
    async (request, reply) => {
      const { service, severity, search, traceId } = request.query;
      const before = cursorOf(request.query.before);
      if (before === null) return reply.code(400).send(BAD_CURSOR);
      if (search !== undefined && searchWords(search).length > MAX_SEARCH_WORDS) {
        return reply.code(400).send({
          error: "invalid_search",
          message: `A search holds at most ${MAX_SEARCH_WORDS} words.`,
        });
      }
      const asked = await rangeOf(request);
      if ("problem" in asked) return reply.code(400).send(asked.problem);
      const { range } = asked;
      const result = await searchLogs(reader, range, {
        service,
        severity,
        search,
        traceId: traceId?.toLowerCase(),
        before,
      });
      return { ...answered(range), ...result };
    },
  );

  app.get<{ Params: { id: string; logId: string }; Querystring: { time: string } }>(
    "/projects/:id/logs/:logId",
    {
      preHandler: [signedIn, projectAccess],
      schema: { params: LOG_PARAMS, querystring: NS_QUERY("time") },
    },
    async (request, reply) => {
      const { projectId, timeZone } = accessOf(request);
      const time = BigInt(request.query.time);
      if (time > MAX_NS) {
        return reply.code(400).send({ error: "invalid_time", message: "time is out of range." });
      }
      const log = await logDetail(reader, projectId, request.params.logId, time);
      if (log === null) {
        // Not "not_found", which the access check answers for an unknown project.
        return reply.code(404).send({
          error: "no_log",
          message: "No log record with this ID is kept: it may be past the retention.",
        });
      }
      return { timeZone, log };
    },
  );

  done();
};
