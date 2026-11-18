import type { FastifyPluginCallback } from "fastify";
import type { Kysely } from "kysely";

import type { Auth } from "../auth/auth.ts";
import { requireTrustedOrigin } from "../auth/origin.ts";
import { requireSession } from "../auth/routes.ts";
import type { ClickHouseClient } from "../clickhouse/clickhouse.ts";
import { clickHouseErrorHandler } from "../clickhouse/route-errors.ts";
import type { Database } from "../db/schema.ts";
import { type ProjectAccess, requireProjectAccess } from "../projects/access.ts";
import { PERIODS, type RangeQuery } from "../reports/routes.ts";
import { DashboardQueryLimiter, dashboardReader } from "../telemetry/dashboard-limit.ts";
import { telemetryRange } from "../telemetry/dashboard-query.ts";
import { bucketsOf } from "../telemetry/metrics.ts";
import {
  type AddressPolicy,
  AddressNotAllowedError,
  type Lookup,
  resolveTarget,
  systemLookup,
} from "./addresses.ts";
import {
  type Check,
  type CheckInput,
  checkValuesOf,
  createCheck,
  deleteCheck,
  findCheck,
  incidentsIn,
  INTERVALS,
  listChecks,
  MAX_CHECKS,
  MAX_FAILURES_BEFORE_DOWN,
  MAX_NAME,
  MAX_TIMEOUT,
  MAX_URL,
  MAX_WORD,
  type Problem,
  updateCheck,
  uptimes,
  valuesOfCheck,
} from "./checks.ts";
import { latestFailures, RESULT_RETENTION_DAYS, responseChart } from "./results.ts";
import { MAX_STATUS_PARTS } from "./statuses.ts";

const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";
const DAY_PATTERN = "^\\d{4}-\\d{2}-\\d{2}$";

const PARAMS = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string", pattern: UUID_PATTERN } },
};

const CHECK_PARAMS = {
  type: "object",
  required: ["id", "checkId"],
  properties: {
    id: { type: "string", pattern: UUID_PATTERN },
    checkId: { type: "string", pattern: UUID_PATTERN },
  },
};

/** The fields a check takes; bounds a little past the real ones, which checkValuesOf words. */
const CHECK_FIELDS = {
  name: { type: "string", maxLength: MAX_NAME * 2 },
  url: { type: "string", maxLength: MAX_URL * 2 },
  method: { type: "string", enum: ["GET", "HEAD"] },
  intervalSeconds: { type: "integer", enum: [...INTERVALS] },
  timeoutSeconds: { type: "integer", minimum: 1, maximum: MAX_TIMEOUT },
  expectedStatuses: { type: "string", maxLength: MAX_STATUS_PARTS * 10 },
  // null, as JSON sends "no word", arrives as "": Fastify coerces it to a string.
  word: { type: "string", maxLength: MAX_WORD * 2 },
  wordMode: { type: "string", enum: ["present", "absent"] },
  failuresBeforeDown: { type: "integer", minimum: 1, maximum: MAX_FAILURES_BEFORE_DOWN },
};

/** A check's page reads whole days, as the telemetry pages do; no environment. */
const PERIOD_QUERY = {
  type: "object",
  additionalProperties: false,
  properties: {
    from: { type: "string", pattern: DAY_PATTERN },
    to: { type: "string", pattern: DAY_PATTERN },
    period: { type: "string", enum: PERIODS },
  },
};

/** How long a check's host may take to resolve when it is saved. */
const SAVE_LOOKUP_MS = 5000;

const DAY_MS = 86_400_000;

/** The access requireProjectAccess set: these routes always run it. */
function accessOf(request: { projectAccess: ProjectAccess | null }): ProjectAccess {
  if (request.projectAccess === null) {
    throw new Error("requireProjectAccess must run before this route");
  }
  return request.projectAccess;
}

const NO_CHECK: Problem = {
  error: "check_not_found",
  message: "The project has no check with this ID.",
};

/**
 * GET    /api/projects/:id/checks
 * POST   /api/projects/:id/checks                  { "url": "https://example.com/health", … }
 * GET    /api/projects/:id/checks/:checkId
 * PATCH  /api/projects/:id/checks/:checkId         { "paused": true } or any of the fields
 * DELETE /api/projects/:id/checks/:checkId
 * GET    /api/projects/:id/checks/:checkId/results[?period=7d|from=…&to=…]
 * GET    /api/projects/:id/checks/:checkId/incidents[?period=…]
 *
 * A project's uptime checks (docs/uptime-alerts.md): the list with each
 * check's state and uptime over the last 24 hours, 7 days, and 30 days;
 * changes, which need the dashboard's origin; and a check's page: its
 * response times and latest failures (ClickHouse, with the dashboard's
 * query settings and limit), its uptime over the
 * period, and its incidents (PostgreSQL). Like every project route, each
 * runs requireProjectAccess first, and reads only the project it found.
 */
export const uptimeRoutes: FastifyPluginCallback<{
  db: Kysely<Database>;
  clickhouse: ClickHouseClient;
  auth: Auth;
  trustedOrigins: readonly string[];
  /** UPTIME_ALLOW_PRIVATE_ADDRESSES, checked when a check is saved, as the worker checks it. */
  policy: AddressPolicy;
  /** Resolves a check's host when it is saved; tests pass a fake. */
  lookup?: Lookup;
  now?: () => Date;
  /** The dashboard's query limit, shared with the telemetry pages. */
  limiter?: DashboardQueryLimiter;
}> = (
  app,
  {
    db,
    clickhouse,
    auth,
    trustedOrigins,
    policy,
    lookup = systemLookup,
    now = () => new Date(),
    limiter = new DashboardQueryLimiter(),
  },
  done,
) => {
  const signedIn = requireSession(auth);
  const projectAccess = requireProjectAccess(db);
  const fromDashboard = requireTrustedOrigin(trustedOrigins);
  app.setErrorHandler(clickHouseErrorHandler);

  /**
   * Why a check's URL may not be saved: its host resolves to an address
   * checks may not reach. A host that does not resolve (yet) is saved,
   * and its runs fail with a DNS cause until it does.
   */
  async function addressProblem(
    url: string,
    log: { info: (fields: object, message: string) => void },
  ): Promise<Problem | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SAVE_LOOKUP_MS);
    try {
      await resolveTarget(new URL(url), { lookup, policy, signal: controller.signal });
      return null;
    } catch (error) {
      if (error instanceof AddressNotAllowedError) {
        // The answer names the address only when it was typed; the log keeps it.
        log.info(
          { host: error.host, address: error.address, kind: error.kind },
          "an uptime check's address was refused",
        );
        return { error: "address_not_allowed", message: error.message };
      }
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** The checks with their uptime over the last 24 hours, 7 days, and 30 days. */
  async function withUptime(projectId: string, checks: Check[]) {
    const moment = now();
    const ago = (days: number) => ({
      from: new Date(moment.getTime() - days * DAY_MS),
      to: moment,
    });
    const shares = await uptimes(db, projectId, checks, [ago(1), ago(7), ago(30)], moment);
    return checks.map((check) => {
      const [day = null, week = null, month = null] = shares.get(check.id) ?? [];
      return { ...check, uptime: { day, week, month } };
    });
  }

  app.get<{ Params: { id: string } }>(
    "/projects/:id/checks",
    { preHandler: [signedIn, projectAccess], schema: { params: PARAMS } },
    async (request) => {
      const { projectId, timeZone } = accessOf(request);
      const checks = await listChecks(db, projectId);
      return {
        timeZone,
        maxChecks: MAX_CHECKS,
        checks: await withUptime(projectId, checks),
      };
    },
  );

  app.post<{ Params: { id: string }; Body: CheckInput }>(
    "/projects/:id/checks",
    {
      preHandler: [fromDashboard, signedIn, projectAccess],
      schema: {
        params: PARAMS,
        body: {
          type: "object",
          required: ["url"],
          additionalProperties: false,
          properties: CHECK_FIELDS,
        },
      },
    },
    async (request, reply) => {
      const { projectId } = accessOf(request);
      const values = checkValuesOf(request.body);
      if ("error" in values) return reply.code(400).send(values);
      const refused = await addressProblem(values.url, request.log);
      if (refused !== null) return reply.code(400).send(refused);
      const created = await createCheck(db, projectId, values, now());
      if ("refused" in created) {
        return reply.code(409).send({
          error: "too_many_checks",
          message: `A project has at most ${MAX_CHECKS} checks.`,
        });
      }
      const [check] = await withUptime(projectId, [created.check]);
      return reply.code(201).send({ check });
    },
  );

  app.get<{ Params: { id: string; checkId: string } }>(
    "/projects/:id/checks/:checkId",
    { preHandler: [signedIn, projectAccess], schema: { params: CHECK_PARAMS } },
    async (request, reply) => {
      const { projectId, timeZone } = accessOf(request);
      const check = await findCheck(db, projectId, request.params.checkId);
      if (check === null) return reply.code(404).send(NO_CHECK);
      const [withShares] = await withUptime(projectId, [check]);
      return { timeZone, check: withShares };
    },
  );

  app.patch<{ Params: { id: string; checkId: string }; Body: CheckInput & { paused?: boolean } }>(
    "/projects/:id/checks/:checkId",
    {
      preHandler: [fromDashboard, signedIn, projectAccess],
      schema: {
        params: CHECK_PARAMS,
        body: {
          type: "object",
          additionalProperties: false,
          minProperties: 1,
          properties: { ...CHECK_FIELDS, paused: { type: "boolean" } },
        },
      },
    },
    async (request, reply) => {
      const { projectId } = accessOf(request);
      const current = await findCheck(db, projectId, request.params.checkId);
      if (current === null) return reply.code(404).send(NO_CHECK);
      const { paused, ...input } = request.body;
      const values = checkValuesOf(input, valuesOfCheck(current));
      if ("error" in values) return reply.code(400).send(values);
      if (values.url !== current.url) {
        const refused = await addressProblem(values.url, request.log);
        if (refused !== null) return reply.code(400).send(refused);
      }
      const updated = await updateCheck(db, projectId, current.id, values, paused, now());
      if (updated === null) return reply.code(404).send(NO_CHECK);
      const [check] = await withUptime(projectId, [updated]);
      return { check };
    },
  );

  app.delete<{ Params: { id: string; checkId: string } }>(
    "/projects/:id/checks/:checkId",
    { preHandler: [fromDashboard, signedIn, projectAccess], schema: { params: CHECK_PARAMS } },
    async (request, reply) => {
      const deleted = await deleteCheck(db, accessOf(request).projectId, request.params.checkId);
      return deleted ? reply.code(204).send() : reply.code(404).send(NO_CHECK);
    },
  );

  /** The check and the period's days, or the answer that refuses them. */
  async function checkAndRange(request: {
    params: { checkId: string };
    query: RangeQuery;
    projectAccess: ProjectAccess | null;
  }) {
    const access = accessOf(request);
    const check = await findCheck(db, access.projectId, request.params.checkId);
    if (check === null) return { ok: false, status: 404, problem: NO_CHECK } as const;
    const asked = await telemetryRange(db, request.query, access, now(), RESULT_RETENTION_DAYS);
    if ("problem" in asked) return { ok: false, status: 400, problem: asked.problem } as const;
    return { ok: true, check, range: asked.range, timeZone: access.timeZone } as const;
  }

  app.get<{ Params: { id: string; checkId: string }; Querystring: RangeQuery }>(
    "/projects/:id/checks/:checkId/results",
    {
      preHandler: [signedIn, projectAccess],
      schema: { params: CHECK_PARAMS, querystring: PERIOD_QUERY },
    },
    async (request, reply) => {
      const found = await checkAndRange(request);
      if (!found.ok) return reply.code(found.status).send(found.problem);
      const { check, range, timeZone } = found;
      const moment = now();
      const buckets = bucketsOf(range, moment);
      const reader = dashboardReader(clickhouse, limiter, reply);
      const target = { id: check.id, projectId: range.projectId };
      const chart = await responseChart(reader, target, buckets);
      const failures = await latestFailures(reader, target, range.from, range.to);
      // Uptime reads incidents, which PostgreSQL keeps past the results' 90 days.
      const [share = null] =
        (
          await uptimes(
            db,
            range.projectId,
            [check],
            [{ from: range.dayStart, to: range.to }],
            moment,
          )
        ).get(check.id) ?? [];
      return {
        timeZone,
        firstDay: range.firstDay,
        lastDay: range.lastDay,
        retentionDays: RESULT_RETENTION_DAYS,
        uptime: share,
        ...chart,
        latestFailures: failures,
      };
    },
  );

  app.get<{ Params: { id: string; checkId: string }; Querystring: RangeQuery }>(
    "/projects/:id/checks/:checkId/incidents",
    {
      preHandler: [signedIn, projectAccess],
      schema: { params: CHECK_PARAMS, querystring: PERIOD_QUERY },
    },
    async (request, reply) => {
      const found = await checkAndRange(request);
      if (!found.ok) return reply.code(found.status).send(found.problem);
      const { check, range, timeZone } = found;
      const list = await incidentsIn(db, range.projectId, check.id, range.dayStart, range.to);
      return { timeZone, firstDay: range.firstDay, lastDay: range.lastDay, ...list };
    },
  );

  done();
};
