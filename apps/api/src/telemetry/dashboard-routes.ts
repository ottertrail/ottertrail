import { Buffer } from "node:buffer";

import type { FastifyPluginCallback } from "fastify";
import type { Kysely } from "kysely";

import { type ProjectAccess, requireProjectAccess } from "../access/access.ts";
import type { Auth } from "../auth/auth.ts";
import { requireSession } from "../auth/routes.ts";
import type { ClickHouseClient } from "../clickhouse/clickhouse.ts";
import { clickHouseErrorHandler } from "../clickhouse/route-errors.ts";
import { ENVIRONMENT_PATTERN, environmentOf } from "../collection/environment.ts";
import type { Database } from "../db/schema.ts";
import { effectiveTelemetryRetentionDays } from "../projects/telemetry-retention.ts";
import { RANGE_PROPERTIES, type RangeQuery } from "../reports/routes.ts";
import {
  DashboardQueryLimiter,
  dashboardReader,
  liveQueryLimiter,
  liveReader,
  SPARKLINE_PLACES,
} from "./dashboard-limit.ts";
import {
  CURSOR_PATTERN,
  cursorOf,
  labelsInRange,
  MAX_NS,
  SERVICE_PATTERN,
  SPAN_ID_PATTERN,
  type TelemetryRange,
  telemetryRange,
  TRACE_ID_PATTERN,
} from "./dashboard-query.ts";
import {
  DATABASE_SORTS,
  type DatabaseSort,
  databasesTrend,
  listDatabases,
  shapeDetail,
} from "./databases.ts";
import { HOST_KEY, hostCharts, listHosts } from "./hosts.ts";
import {
  liveLogs,
  logDetail,
  logVolume,
  MAX_SEARCH_LENGTH,
  MAX_SEARCH_WORDS,
  searchLogs,
  searchWords,
  SEVERITIES,
  type Severity,
} from "./logs.ts";
import {
  listMetrics,
  METRIC_KINDS,
  type MetricKind,
  metricChart,
  metricSparkline,
  SPARKLINE_MAX_DAYS,
} from "./metrics.ts";
import { MAX_KEY_CHARS, MAX_NAME_BYTES, MAX_VALUE_BYTES } from "./normalize.ts";
import {
  listServices,
  MAX_RECENT_ROUTES,
  recentRoutes,
  serviceChart,
  servicesTrend,
} from "./services.ts";
import { listTraces, spanDetail, traceChart, traceDetail, traceWindow } from "./traces.ts";

const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

/** UTC ISO 8601 timestamps, including up to 9 fractional digits. */
const MOMENT_PATTERN = "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{1,9})?Z$";

const RECENT_ROUTES_MS = 86_400_000;

/** Milliseconds; caps the filter at one day. */
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

/** Nanoseconds since 1970, matching span and log keys. */
const NS_QUERY = (name: string) => ({
  type: "object",
  required: [name],
  additionalProperties: false,
  properties: { [name]: { type: "string", pattern: "^[0-9]{1,19}$" } },
});

/** All routes run requireProjectAccess before this. */
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

type ChartQuery = RangeQuery & {
  name: string;
  kind: MetricKind;
  split?: string;
  host?: string;
  attr?: string;
  attrValue?: string;
};

type SparklineQuery = RangeQuery & { name: string; kind: MetricKind };

type HostQuery = RangeQuery & { host: string };

type ServiceChartQuery = RangeQuery & { service: string; route?: string };

type DatabasesQuery = RangeQuery & { sort?: DatabaseSort };

/** UInt64 hash as decimal text. */
const SHAPE_ID_PATTERN = "^[0-9]{1,20}$";
const MAX_UINT64 = 18_446_744_073_709_551_615n;

const RANGE_QUERY = { type: "object", additionalProperties: false, properties: RANGE_PROPERTIES };

type LogsQuery = RangeQuery & {
  service?: string;
  severity?: Severity;
  search?: string;
  traceId?: string;
  before?: string;
};

type LiveQuery = Omit<LogsQuery, "before" | "period" | "from" | "to"> & { after?: string };

const LOG_FILTER_PROPERTIES = {
  service: { type: "string", pattern: SERVICE_PATTERN },
  severity: { type: "string", enum: Object.keys(SEVERITIES) },
  search: { type: "string", maxLength: MAX_SEARCH_LENGTH },
  traceId: { type: "string", pattern: TRACE_ID_PATTERN },
};

const TRACE_FILTER_PROPERTIES = {
  ...RANGE_PROPERTIES,
  service: { type: "string", pattern: SERVICE_PATTERN },
  name: { type: "string", minLength: 1, maxLength: MAX_SEARCH_LENGTH },
  errors: { type: "boolean" },
  minDuration: { type: "integer", minimum: 0, maximum: MAX_MIN_DURATION_MS },
};

const tooManyWords = (search: string | undefined) =>
  search !== undefined && searchWords(search).length > MAX_SEARCH_WORDS;

const BAD_SEARCH = {
  error: "invalid_search",
  message: `A search holds at most ${MAX_SEARCH_WORDS} words.`,
};

/**
 * Project telemetry reads. Each route runs requireProjectAccess and reads only that project
 * (traces.ts, logs.ts, metrics.ts, services.ts, databases.ts, hosts.ts).
 */
export const telemetryDashboardRoutes: FastifyPluginCallback<{
  db: Kysely<Database>;
  clickhouse: ClickHouseClient;
  auth: Auth;
  /**
   * The instance's maximum (TELEMETRY_RETENTION_DAYS). Each route excludes
   * data older than its project keeps (projects/telemetry-retention.ts).
   */
  maxRetentionDays: number;
  now?: () => Date;
  /** Process-wide query limit (dashboard-limit.ts). */
  limiter?: DashboardQueryLimiter;
  /** Caps sparklines within the shared query pool (SPARKLINE_PLACES). */
  sparklineLimiter?: DashboardQueryLimiter;
  /** Live polls acquire this pool before `limiter` (liveReader). */
  liveLimiter?: DashboardQueryLimiter;
}> = (
  app,
  {
    db,
    clickhouse,
    auth,
    maxRetentionDays,
    now = () => new Date(),
    limiter = new DashboardQueryLimiter(),
    sparklineLimiter = new DashboardQueryLimiter({ max: SPARKLINE_PLACES }),
    liveLimiter = liveQueryLimiter(),
  },
  done,
) => {
  const signedIn = requireSession(auth);
  const canView = requireProjectAccess(db, { area: "monitoring", level: "view" });
  const readerOf = (reply: Parameters<typeof dashboardReader>[2]) =>
    dashboardReader(clickhouse, limiter, reply);
  app.setErrorHandler(clickHouseErrorHandler);

  /** The days the request's project keeps. */
  const keptDays = (request: { projectAccess: ProjectAccess | null }) =>
    effectiveTelemetryRetentionDays(accessOf(request).telemetryRetentionDays, maxRetentionDays);

  const rangeOf = (request: { query: RangeQuery; projectAccess: ProjectAccess | null }) =>
    telemetryRange(db, request.query, accessOf(request), now(), keptDays(request));

  const BAD_CURSOR = { error: "invalid_cursor", message: "before is out of range." };

  const answered = (range: TelemetryRange, request: { projectAccess: ProjectAccess | null }) => ({
    timeZone: range.timeZone,
    environment: range.environment,
    firstDay: range.firstDay,
    lastDay: range.lastDay,
    retentionDays: keptDays(request),
  });

  app.get<{ Params: { id: string }; Querystring: TracesQuery }>(
    "/projects/:id/traces",
    {
      preHandler: [signedIn, canView],
      schema: {
        params: PARAMS,
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            ...TRACE_FILTER_PROPERTIES,
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
      const list = await listTraces(readerOf(reply), range, {
        service,
        name,
        errors: errors === true,
        minDurationMs: minDuration,
        before,
      });
      return { ...answered(range, request), ...list };
    },
  );

  app.get<{ Params: { id: string }; Querystring: Omit<TracesQuery, "before"> }>(
    "/projects/:id/traces/chart",
    {
      preHandler: [signedIn, canView],
      schema: {
        params: PARAMS,
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: TRACE_FILTER_PROPERTIES,
        },
      },
    },
    async (request, reply) => {
      const asked = await rangeOf(request);
      if ("problem" in asked) return reply.code(400).send(asked.problem);
      const { range } = asked;
      const { service, name, errors, minDuration } = request.query;
      const chart = await traceChart(
        readerOf(reply),
        range,
        { service, name, errors: errors === true, minDurationMs: minDuration },
        now(),
      );
      return { ...answered(range, request), ...chart };
    },
  );

  app.get<{ Params: { id: string; traceId: string }; Querystring: { at?: string } }>(
    "/projects/:id/traces/:traceId",
    {
      preHandler: [signedIn, canView],
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
      const retentionDays = keptDays(request);
      const detail = await traceDetail(
        readerOf(reply),
        projectId,
        traceId,
        traceWindow(now(), retentionDays, at),
      );
      // An empty trace is a valid result the page can display.
      return { timeZone, retentionDays, ...detail };
    },
  );

  app.get<{
    Params: { id: string; traceId: string; spanId: string };
    Querystring: { start: string };
  }>(
    "/projects/:id/traces/:traceId/spans/:spanId",
    {
      preHandler: [signedIn, canView],
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
        readerOf(reply),
        projectId,
        request.params.traceId.toLowerCase(),
        request.params.spanId.toLowerCase(),
        start,
      );
      if (span === null) {
        // Reserve "not_found" for an unknown project from the access check.
        return reply.code(404).send({
          error: "no_span",
          message: "No span with this ID is stored. It may be past its retention period.",
        });
      }
      return { timeZone, span };
    },
  );

  app.get<{ Params: { id: string }; Querystring: LogsQuery }>(
    "/projects/:id/logs",
    {
      preHandler: [signedIn, canView],
      schema: {
        params: PARAMS,
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            ...RANGE_PROPERTIES,
            ...LOG_FILTER_PROPERTIES,
            before: { type: "string", pattern: CURSOR_PATTERN },
          },
        },
      },
    },
    async (request, reply) => {
      const { service, severity, search, traceId } = request.query;
      const before = cursorOf(request.query.before);
      if (before === null) return reply.code(400).send(BAD_CURSOR);
      if (tooManyWords(search)) return reply.code(400).send(BAD_SEARCH);
      const asked = await rangeOf(request);
      if ("problem" in asked) return reply.code(400).send(asked.problem);
      const { range } = asked;
      const result = await searchLogs(readerOf(reply), range, {
        service,
        severity,
        search,
        traceId: traceId?.toLowerCase(),
        before,
      });
      return { ...answered(range, request), ...result };
    },
  );

  app.get<{ Params: { id: string }; Querystring: Omit<LogsQuery, "before"> }>(
    "/projects/:id/logs/volume",
    {
      preHandler: [signedIn, canView],
      schema: {
        params: PARAMS,
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: { ...RANGE_PROPERTIES, ...LOG_FILTER_PROPERTIES },
        },
      },
    },
    async (request, reply) => {
      const { service, severity, search, traceId } = request.query;
      if (tooManyWords(search)) return reply.code(400).send(BAD_SEARCH);
      const asked = await rangeOf(request);
      if ("problem" in asked) return reply.code(400).send(asked.problem);
      const { range } = asked;
      const volume = await logVolume(
        readerOf(reply),
        range,
        { service, severity, search, traceId: traceId?.toLowerCase() },
        now(),
      );
      return { ...answered(range, request), ...volume };
    },
  );

  app.get<{ Params: { id: string }; Querystring: LiveQuery }>(
    "/projects/:id/logs/live",
    {
      preHandler: [signedIn, canView],
      schema: {
        params: PARAMS,
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            environment: RANGE_PROPERTIES.environment,
            ...LOG_FILTER_PROPERTIES,
            after: { type: "string", pattern: "^[0-9]{1,19}$" },
          },
        },
      },
    },
    async (request, reply) => {
      const { service, severity, search, traceId } = request.query;
      const after = request.query.after === undefined ? undefined : BigInt(request.query.after);
      if (after !== undefined && after > MAX_NS) {
        return reply.code(400).send({ error: "invalid_cursor", message: "after is out of range." });
      }
      if (tooManyWords(search)) return reply.code(400).send(BAD_SEARCH);
      const { projectId, timeZone } = accessOf(request);
      const environment = environmentOf(request.query.environment);
      const live = await liveLogs(
        liveReader(clickhouse, limiter, liveLimiter, reply),
        { projectId, environment, retentionDays: keptDays(request) },
        { service, severity, search, traceId: traceId?.toLowerCase() },
        after,
        now(),
      );
      return { timeZone, environment, ...live };
    },
  );

  app.get<{ Params: { id: string; logId: string }; Querystring: { time: string } }>(
    "/projects/:id/logs/:logId",
    {
      preHandler: [signedIn, canView],
      schema: { params: LOG_PARAMS, querystring: NS_QUERY("time") },
    },
    async (request, reply) => {
      const { projectId, timeZone } = accessOf(request);
      const time = BigInt(request.query.time);
      if (time > MAX_NS) {
        return reply.code(400).send({ error: "invalid_time", message: "time is out of range." });
      }
      const log = await logDetail(readerOf(reply), projectId, request.params.logId, time);
      if (log === null) {
        // Reserve "not_found" for an unknown project from the access check.
        return reply.code(404).send({
          error: "no_log",
          message: "No log record with this ID is stored. It may be past its retention period.",
        });
      }
      return { timeZone, log };
    },
  );

  app.get<{ Params: { id: string }; Querystring: RangeQuery }>(
    "/projects/:id/metrics",
    { preHandler: [signedIn, canView], schema: { params: PARAMS, querystring: RANGE_QUERY } },
    async (request, reply) => {
      const asked = await rangeOf(request);
      if ("problem" in asked) return reply.code(400).send(asked.problem);
      const { range } = asked;
      return { ...answered(range, request), ...(await listMetrics(readerOf(reply), range)) };
    },
  );

  app.get<{ Params: { id: string }; Querystring: ChartQuery }>(
    "/projects/:id/metrics/chart",
    {
      preHandler: [signedIn, canView],
      schema: {
        params: PARAMS,
        querystring: {
          type: "object",
          required: ["name", "kind"],
          additionalProperties: false,
          properties: {
            ...RANGE_PROPERTIES,
            // Ingestion caps names at 1,024 bytes and keys at 256 characters.
            name: { type: "string", maxLength: MAX_NAME_BYTES },
            kind: { type: "string", enum: METRIC_KINDS },
            split: { type: "string", minLength: 1, maxLength: MAX_KEY_CHARS },
            host: { type: "string", minLength: 1, maxLength: MAX_VALUE_BYTES },
            attr: { type: "string", minLength: 1, maxLength: MAX_KEY_CHARS },
            attrValue: { type: "string", maxLength: MAX_VALUE_BYTES },
          },
          dependencies: { attr: ["attrValue"], attrValue: ["attr"] },
        },
      },
    },
    async (request, reply) => {
      const { name, kind, split, host, attr, attrValue } = request.query;
      if (Buffer.byteLength(name) > MAX_NAME_BYTES) {
        return reply.code(400).send({
          error: "invalid_name",
          message: `A metric's name holds at most ${MAX_NAME_BYTES} bytes.`,
        });
      }
      if (Buffer.byteLength(host ?? "") > MAX_VALUE_BYTES) {
        return reply.code(400).send({
          error: "invalid_host",
          message: `A host's name holds at most ${MAX_VALUE_BYTES} bytes.`,
        });
      }
      if (Buffer.byteLength(attrValue ?? "") > MAX_VALUE_BYTES) {
        return reply.code(400).send({
          error: "invalid_attribute",
          message: `An attribute's value holds at most ${MAX_VALUE_BYTES} bytes.`,
        });
      }
      const asked = await rangeOf(request);
      if ("problem" in asked) return reply.code(400).send(asked.problem);
      const { range } = asked;
      const chart = await metricChart(
        readerOf(reply),
        range,
        {
          name,
          kind,
          split,
          resource: host === undefined ? undefined : { key: HOST_KEY, value: host },
          attribute:
            attr === undefined || attrValue === undefined
              ? undefined
              : { keys: [attr], value: attrValue },
        },
        now(),
      );
      return { ...answered(range, request), ...chart };
    },
  );

  app.get<{ Params: { id: string }; Querystring: SparklineQuery }>(
    "/projects/:id/metrics/sparkline",
    {
      preHandler: [signedIn, canView],
      schema: {
        params: PARAMS,
        querystring: {
          type: "object",
          required: ["name", "kind"],
          additionalProperties: false,
          properties: {
            ...RANGE_PROPERTIES,
            name: { type: "string", maxLength: MAX_NAME_BYTES },
            kind: { type: "string", enum: METRIC_KINDS },
          },
        },
      },
    },
    async (request, reply) => {
      const { name, kind } = request.query;
      if (Buffer.byteLength(name) > MAX_NAME_BYTES) {
        return reply.code(400).send({
          error: "invalid_name",
          message: `A metric's name holds at most ${MAX_NAME_BYTES} bytes.`,
        });
      }
      const asked = await rangeOf(request);
      if ("problem" in asked) return reply.code(400).send(asked.problem);
      const { range } = asked;
      const days = (Date.parse(range.lastDay) - Date.parse(range.firstDay)) / 86_400_000 + 1;
      if (days > SPARKLINE_MAX_DAYS) {
        return reply.code(400).send({
          error: "range_too_long",
          message: `Sparklines are drawn for periods of up to ${SPARKLINE_MAX_DAYS} days.`,
        });
      }
      const sparkline = await metricSparkline(
        dashboardReader(clickhouse, limiter, reply, sparklineLimiter),
        range,
        { name, kind },
        now(),
      );
      return { ...answered(range, request), ...sparkline };
    },
  );

  app.get<{ Params: { id: string }; Querystring: RangeQuery }>(
    "/projects/:id/services",
    { preHandler: [signedIn, canView], schema: { params: PARAMS, querystring: RANGE_QUERY } },
    async (request, reply) => {
      const asked = await rangeOf(request);
      if ("problem" in asked) return reply.code(400).send(asked.problem);
      const { range } = asked;
      return { ...answered(range, request), ...(await listServices(readerOf(reply), range)) };
    },
  );

  app.get<{ Params: { id: string }; Querystring: RangeQuery }>(
    "/projects/:id/services/trend",
    { preHandler: [signedIn, canView], schema: { params: PARAMS, querystring: RANGE_QUERY } },
    async (request, reply) => {
      const asked = await rangeOf(request);
      if ("problem" in asked) return reply.code(400).send(asked.problem);
      const { range } = asked;
      return {
        ...answered(range, request),
        ...(await servicesTrend(readerOf(reply), range, now())),
      };
    },
  );

  app.get<{ Params: { id: string }; Querystring: ServiceChartQuery }>(
    "/projects/:id/services/chart",
    {
      preHandler: [signedIn, canView],
      schema: {
        params: PARAMS,
        querystring: {
          type: "object",
          required: ["service"],
          additionalProperties: false,
          properties: {
            ...RANGE_PROPERTIES,
            service: { type: "string", pattern: SERVICE_PATTERN },
            // Routes come from http.route (at most 4 KB) or the span name.
            route: { type: "string", minLength: 1, maxLength: MAX_VALUE_BYTES },
          },
        },
      },
    },
    async (request, reply) => {
      const { service, route } = request.query;
      if (Buffer.byteLength(route ?? "") > MAX_VALUE_BYTES) {
        return reply.code(400).send({
          error: "invalid_route",
          message: `A route holds at most ${MAX_VALUE_BYTES} bytes.`,
        });
      }
      const asked = await rangeOf(request);
      if ("problem" in asked) return reply.code(400).send(asked.problem);
      const { range } = asked;
      const reader = readerOf(reply);
      const [chart, labels] = await Promise.all([
        serviceChart(reader, range, { service, route: route ?? null }, now()),
        labelsInRange(reader, "spans", range, "AND kind = 'server'"),
      ]);
      return { ...answered(range, request), environments: labels.environments, ...chart };
    },
  );

  app.get<{ Params: { id: string }; Querystring: { environment?: string } }>(
    "/projects/:id/services/routes",
    {
      preHandler: [signedIn, canView],
      schema: {
        params: PARAMS,
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: { environment: { type: "string", pattern: ENVIRONMENT_PATTERN } },
        },
      },
    },
    async (request, reply) => {
      const at = now();
      const environment = environmentOf(request.query.environment);
      const found = await recentRoutes(readerOf(reply), {
        projectId: accessOf(request).projectId,
        environment,
        from: new Date(at.getTime() - RECENT_ROUTES_MS),
        to: at,
      });
      return { environment, maxRoutes: MAX_RECENT_ROUTES, ...found };
    },
  );

  app.get<{ Params: { id: string }; Querystring: DatabasesQuery }>(
    "/projects/:id/databases",
    {
      preHandler: [signedIn, canView],
      schema: {
        params: PARAMS,
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: { ...RANGE_PROPERTIES, sort: { type: "string", enum: DATABASE_SORTS } },
        },
      },
    },
    async (request, reply) => {
      const asked = await rangeOf(request);
      if ("problem" in asked) return reply.code(400).send(asked.problem);
      const { range } = asked;
      const sort = request.query.sort ?? "time";
      return {
        ...answered(range, request),
        sort,
        ...(await listDatabases(readerOf(reply), range, sort, now())),
      };
    },
  );

  app.get<{ Params: { id: string }; Querystring: RangeQuery }>(
    "/projects/:id/databases/trend",
    { preHandler: [signedIn, canView], schema: { params: PARAMS, querystring: RANGE_QUERY } },
    async (request, reply) => {
      const asked = await rangeOf(request);
      if ("problem" in asked) return reply.code(400).send(asked.problem);
      const { range } = asked;
      return {
        ...answered(range, request),
        ...(await databasesTrend(readerOf(reply), range, now())),
      };
    },
  );

  app.get<{ Params: { id: string; shapeId: string }; Querystring: RangeQuery }>(
    "/projects/:id/databases/shapes/:shapeId",
    {
      preHandler: [signedIn, canView],
      schema: {
        params: {
          type: "object",
          required: ["id", "shapeId"],
          properties: {
            id: { type: "string", pattern: UUID_PATTERN },
            shapeId: { type: "string", pattern: SHAPE_ID_PATTERN },
          },
        },
        querystring: RANGE_QUERY,
      },
    },
    async (request, reply) => {
      const shapeId = BigInt(request.params.shapeId);
      if (shapeId > MAX_UINT64) {
        return reply
          .code(400)
          .send({ error: "invalid_shape", message: "The shape's ID is out of range." });
      }
      const asked = await rangeOf(request);
      if ("problem" in asked) return reply.code(400).send(asked.problem);
      const { range } = asked;
      const reader = readerOf(reply);
      const [detail, labels] = await Promise.all([
        shapeDetail(reader, range, shapeId.toString(), now()),
        labelsInRange(reader, "spans", range, "AND kind = 'client'"),
      ]);
      return { ...answered(range, request), environments: labels.environments, ...detail };
    },
  );

  app.get<{ Params: { id: string }; Querystring: RangeQuery }>(
    "/projects/:id/hosts",
    { preHandler: [signedIn, canView], schema: { params: PARAMS, querystring: RANGE_QUERY } },
    async (request, reply) => {
      const asked = await rangeOf(request);
      if ("problem" in asked) return reply.code(400).send(asked.problem);
      const { range } = asked;
      return {
        ...answered(range, request),
        ...(await listHosts(readerOf(reply), range, now())),
      };
    },
  );

  app.get<{ Params: { id: string }; Querystring: HostQuery }>(
    "/projects/:id/hosts/charts",
    {
      preHandler: [signedIn, canView],
      schema: {
        params: PARAMS,
        querystring: {
          type: "object",
          required: ["host"],
          additionalProperties: false,
          properties: {
            ...RANGE_PROPERTIES,
            // Ingestion caps attribute values at 4 KB, which also bounds character count.
            host: { type: "string", minLength: 1, maxLength: MAX_VALUE_BYTES },
          },
        },
      },
    },
    async (request, reply) => {
      const { host } = request.query;
      if (Buffer.byteLength(host) > MAX_VALUE_BYTES) {
        return reply.code(400).send({
          error: "invalid_host",
          message: `A host's name holds at most ${MAX_VALUE_BYTES} bytes.`,
        });
      }
      const asked = await rangeOf(request);
      if ("problem" in asked) return reply.code(400).send(asked.problem);
      const { range } = asked;
      return {
        ...answered(range, request),
        ...(await hostCharts(readerOf(reply), range, host, now())),
      };
    },
  );

  done();
};
