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
import { RANGE_PROPERTIES, type RangeQuery } from "../reports/routes.ts";
import { DashboardQueryLimiter, dashboardReader } from "./dashboard-limit.ts";
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
import { DATABASE_SORTS, type DatabaseSort, listDatabases, shapeDetail } from "./databases.ts";
import { HOST_KEY, hostCharts, listHosts } from "./hosts.ts";
import {
  logDetail,
  MAX_SEARCH_LENGTH,
  MAX_SEARCH_WORDS,
  searchLogs,
  searchWords,
  SEVERITIES,
  type Severity,
} from "./logs.ts";
import { listMetrics, METRIC_KINDS, type MetricKind, metricChart } from "./metrics.ts";
import { MAX_KEY_CHARS, MAX_NAME_BYTES, MAX_VALUE_BYTES } from "./normalize.ts";
import { listServices, MAX_RECENT_ROUTES, recentRoutes, serviceChart } from "./services.ts";
import { listTraces, spanDetail, traceDetail, traceWindow } from "./traces.ts";

const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

/** A moment as the dashboard sends it: an ISO 8601 time in UTC, such as an error's occurrence. */
const MOMENT_PATTERN = "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{1,9})?Z$";

/** How far back the alert form's route suggestions look: a day. */
const RECENT_ROUTES_MS = 86_400_000;

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

type ChartQuery = RangeQuery & {
  name: string;
  kind: MetricKind;
  split?: string;
  host?: string;
  attr?: string;
  attrValue?: string;
};

type HostQuery = RangeQuery & { host: string };

type ServiceChartQuery = RangeQuery & { service: string; route?: string };

type DatabasesQuery = RangeQuery & { sort?: DatabaseSort };

/** A query shape's ID: a UInt64 hash, as decimal text. */
const SHAPE_ID_PATTERN = "^[0-9]{1,20}$";
const MAX_UINT64 = 18_446_744_073_709_551_615n;

/** The range's parameters alone, for the lists that take nothing else. */
const RANGE_QUERY = { type: "object", additionalProperties: false, properties: RANGE_PROPERTIES };

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
 * GET /api/projects/:id/metrics[?period=…&environment=…]
 * GET /api/projects/:id/metrics/chart?name=…&kind=gauge|counter|updown|histogram[&split=<attribute key>&host=<host.name>&attr=<key>&attrValue=<value>&period=…&environment=…]
 *     (host: one host's series only; attr and attrValue: one attribute value's points only)
 * GET /api/projects/:id/services[?period=…&environment=…]
 * GET /api/projects/:id/services/chart?service=<name>[&route=<route>&period=…&environment=…]
 *     (one service's requests, or one route's, over the period, in time buckets)
 * GET /api/projects/:id/services/routes[?environment=…]
 *     (up to 200 distinct services and routes of the last 24 hours, for the alert form)
 * GET /api/projects/:id/databases[?period=…&environment=…&sort=time|p95|calls|failures]
 *     (each database's calls and its query shapes, the first 200 by the sort)
 * GET /api/projects/:id/databases/shapes/:shapeId[?period=…&environment=…]
 *     (one query shape over the period: charts, services, slowest calls, routes)
 * GET /api/projects/:id/hosts[?period=…&environment=…]
 * GET /api/projects/:id/hosts/charts?host=<host.name>[&period=…&environment=…]
 *
 * The Traces, Logs, Metrics, Services, Databases, and Hosts pages
 * (traces.ts, logs.ts, metrics.ts, services.ts, databases.ts, hosts.ts). Like every project
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
  /** Queries in flight on this process (dashboard-limit.ts); tests pass a smaller one. */
  limiter?: DashboardQueryLimiter;
}> = (
  app,
  {
    db,
    clickhouse,
    auth,
    retentionDays,
    now = () => new Date(),
    limiter = new DashboardQueryLimiter(),
  },
  done,
) => {
  const signedIn = requireSession(auth);
  const canView = requireProjectAccess(db, { area: "monitoring", level: "view" });
  const readerOf = (reply: Parameters<typeof dashboardReader>[2]) =>
    dashboardReader(clickhouse, limiter, reply);
  app.setErrorHandler(clickHouseErrorHandler);

  /** The request's days, in the instance's timezone, from the oldest kept; or the reason it is refused. */
  const rangeOf = (request: { query: RangeQuery; projectAccess: ProjectAccess | null }) =>
    telemetryRange(db, request.query, accessOf(request), now(), retentionDays);

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
      preHandler: [signedIn, canView],
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
      const list = await listTraces(readerOf(reply), range, {
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
      const detail = await traceDetail(
        readerOf(reply),
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
      preHandler: [signedIn, canView],
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
      const result = await searchLogs(readerOf(reply), range, {
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
        // Not "not_found", which the access check answers for an unknown project.
        return reply.code(404).send({
          error: "no_log",
          message: "No log record with this ID is kept: it may be past the retention.",
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
      return { ...answered(range), ...(await listMetrics(readerOf(reply), range)) };
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
            // As ingestion stores them: a name cut to 1,024 bytes (so at most
            // as many characters), a key to 256 characters.
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
      return { ...answered(range), ...chart };
    },
  );

  app.get<{ Params: { id: string }; Querystring: RangeQuery }>(
    "/projects/:id/services",
    { preHandler: [signedIn, canView], schema: { params: PARAMS, querystring: RANGE_QUERY } },
    async (request, reply) => {
      const asked = await rangeOf(request);
      if ("problem" in asked) return reply.code(400).send(asked.problem);
      const { range } = asked;
      return { ...answered(range), ...(await listServices(readerOf(reply), range)) };
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
            // A route is its http.route attribute (a value, at most 4 KB) or its span's name.
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
      return { ...answered(range), environments: labels.environments, ...chart };
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
        ...answered(range),
        sort,
        ...(await listDatabases(readerOf(reply), range, sort, now())),
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
      return { ...answered(range), environments: labels.environments, ...detail };
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
        ...answered(range),
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
            // As ingestion stores an attribute's value: at most 4 KB (so at most as many characters).
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
        ...answered(range),
        ...(await hostCharts(readerOf(reply), range, host, now())),
      };
    },
  );

  done();
};
