import type { FastifyPluginCallback } from "fastify";
import type { Kysely } from "kysely";

import { canUse, FORBIDDEN, type ProjectAccess, requireProjectAccess } from "../access/access.ts";
import type { Auth } from "../auth/auth.ts";
import { requireSession } from "../auth/routes.ts";
import type { ClickHouseClient } from "../clickhouse/clickhouse.ts";
import type { Reader } from "../clickhouse/query.ts";
import { clickHouseErrorHandler } from "../clickhouse/route-errors.ts";
import { environmentOf } from "../collection/environment.ts";
import { EVENT_NAME_SCHEMA } from "../collection/routes.ts";
import type { Database } from "../db/schema.ts";
import { listSavedFunnels } from "../funnels/saved-funnels.ts";
import { localDays, previousDays } from "../reports/reports.ts";
import { RANGE_PROPERTIES, type RangeQuery, requestDays } from "../reports/routes.ts";
import { DashboardQueryLimiter, dashboardReader } from "../telemetry/dashboard-limit.ts";
import { dayIn } from "../visitors/visitor-ids.ts";
import { isVisitSourceName } from "../visits/visit-source.ts";
import {
  COUNTED,
  eventDetail,
  eventSources,
  listEvents,
  MAX_FILTERS,
  type ProductRange,
  productEnvironments,
  type PropertyFilter,
} from "./events.ts";
import {
  type Breakdown,
  BREAKDOWN_NAMES,
  funnel,
  funnelBreakdown,
  FUNNEL_COUNTS,
  FUNNEL_WINDOWS,
  type FunnelCount,
  funnelPeople,
  funnelRefusal,
  type FunnelStep,
  funnelStepsOf,
  funnelTimes,
  funnelTrend,
  type FunnelWindow,
  INVALID_STEPS,
  MAX_STEPS,
  MAX_VISITOR_WINDOW,
  PEOPLE_LIMIT,
  PEOPLE_OUTCOMES,
  type PeopleOutcome,
  previousReadEnd,
  trendUnit,
} from "./funnel.ts";
import { retention } from "./retention.ts";
import { KEY, VALUE } from "./steps.ts";

const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

/** "p.plan=team": a property filter in the address. The key is the rest of the name. */
const FILTER_PREFIX = "p.";

function accessOf(request: { projectAccess: ProjectAccess | null }): ProjectAccess {
  if (request.projectAccess === null) {
    throw new Error("requireProjectAccess must run before this route");
  }
  return request.projectAccess;
}

/**
 * Read p.<key> filters before the schema drops unknown parameters. Enforce
 * collection limits: names 1 to 100 characters, values up to 500, no NUL,
 * so invalid filters cannot silently show unfiltered counts.
 */
function filtersOf(url: string): PropertyFilter[] | null {
  const filters: PropertyFilter[] = [];
  for (const [name, value] of new URL(url, "http://localhost").searchParams) {
    if (!name.startsWith(FILTER_PREFIX)) continue;
    const filter = { key: name.slice(FILTER_PREFIX.length), value };
    if (!KEY.test(filter.key) || !VALUE.test(filter.value)) return null;
    filters.push(filter);
  }
  return filters;
}

/** An event's page: its name, the range, and p.<key> property filters. */
const eventSchema = {
  params: {
    type: "object",
    required: ["id", "name"],
    properties: { id: { type: "string", pattern: UUID_PATTERN }, name: EVENT_NAME_SCHEMA },
  },
  querystring: {
    type: "object",
    additionalProperties: false,
    properties: RANGE_PROPERTIES,
    // filtersOf validates raw property filters; keep the schema from dropping them.
    patternProperties: { "^p\\.": { type: "string" } },
  },
};

/** An event page's property filters, or why they are refused. */
function eventFiltersOf(
  url: string,
): { filters: PropertyFilter[] } | { problem: { error: string; message: string } } {
  const filters = filtersOf(url);
  if (filters === null) {
    return {
      problem: {
        error: "invalid_filter",
        message:
          "A filter is p.<property>=<value>: a property name of 1 to 100 characters and a value up to 500, without NUL.",
      },
    };
  }
  if (filters.length > MAX_FILTERS) {
    return {
      problem: { error: "too_many_filters", message: `At most ${MAX_FILTERS} property filters.` },
    };
  }
  return { filters };
}

/** Parse 2 to 8 page or event steps; return null on invalid input. */
export function parseSteps(text: string): FunnelStep[] | null {
  try {
    return funnelStepsOf(JSON.parse(text));
  } catch {
    return null;
  }
}

type FunnelQuery = RangeQuery & { steps: string; count?: FunnelCount; window?: FunnelWindow };

/** A funnel's query: the range, its steps as JSON, who it counts, its window, and `more`. */
const funnelSchema = (more: Record<string, object> = {}, required: string[] = []) => ({
  params: {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string", pattern: UUID_PATTERN } },
  },
  querystring: {
    type: "object",
    required: ["steps", ...required],
    additionalProperties: false,
    properties: {
      ...RANGE_PROPERTIES,
      steps: { type: "string", maxLength: 8000 },
      count: { type: "string", enum: FUNNEL_COUNTS },
      window: { type: "integer", enum: FUNNEL_WINDOWS },
      ...more,
    },
  },
});

const INVALID_BREAKDOWN = {
  error: "invalid_breakdown",
  message: `by is one of ${BREAKDOWN_NAMES.join(", ")}, or p.<property>: a property name of 1 to 100 characters, without NUL.`,
};

/** "deviceType" … from the allow-list, or "p.plan": a property, named as the step filter's. */
function breakdownOf(text: string): Breakdown | null {
  if (text.startsWith(FILTER_PREFIX)) {
    const property = text.slice(FILTER_PREFIX.length);
    return KEY.test(property) ? { property } : null;
  }
  const name = BREAKDOWN_NAMES.find((item) => item === text);
  if (name === undefined) return null;
  return isVisitSourceName(name) ? { visit: name } : { column: name };
}

/** The project's hostnames: a referrer on one is not a source (visits/visit-source.ts). */
async function ownHostnames(db: Kysely<Database>, projectId: string): Promise<string[]> {
  const project = await db
    .selectFrom("projects")
    .select("allowed_hostnames")
    .where("id", "=", projectId)
    .executeTakeFirst();
  return project?.allowed_hostnames ?? [];
}

const answer = (range: ProductRange) => ({
  timeZone: range.timeZone,
  environment: range.environment,
  firstDay: range.firstDay,
  lastDay: range.lastDay,
});

/** Product events and properties (events.ts; docs/product-analytics.md). */
export const productRoutes: FastifyPluginCallback<{
  db: Kysely<Database>;
  clickhouse: ClickHouseClient;
  auth: Auth;
  /** The dashboard's query limit (telemetry/dashboard-limit.ts), for an event's sources, the saved funnels' results, a breakdown, the trend, the times between steps, and a list of people. */
  limiter?: DashboardQueryLimiter;
  now?: () => Date;
}> = (
  app,
  { db, clickhouse, auth, limiter = new DashboardQueryLimiter(), now = () => new Date() },
  done,
) => {
  const signedIn = requireSession(auth);
  const canView = requireProjectAccess(db, { area: "product_analytics", level: "view" });
  const reader: Reader = { client: clickhouse };
  app.setErrorHandler(clickHouseErrorHandler);

  async function rangeOf(request: {
    query: RangeQuery;
    projectAccess: ProjectAccess | null;
  }): Promise<
    { range: ProductRange; moment: Date } | { problem: { error: string; message: string } }
  > {
    const { projectId, timeZone } = accessOf(request);
    // One reading of the clock: the period's days and the comparison's cut-off agree.
    const moment = now();
    const days = requestDays(request.query, dayIn(timeZone)(moment));
    if ("problem" in days) return days;
    const { from, to } = await localDays(db, days.from, days.to, timeZone);
    return {
      range: {
        projectId,
        environment: environmentOf(request.query.environment),
        timeZone,
        firstDay: days.from,
        lastDay: days.to,
        from,
        to,
      },
      moment,
    };
  }

  /** A funnel's steps, count, and window, checked, and its range. */
  async function funnelOf(request: {
    query: FunnelQuery;
    projectAccess: ProjectAccess | null;
  }): Promise<
    | {
        range: ProductRange;
        moment: Date;
        steps: FunnelStep[];
        count: FunnelCount;
        window: FunnelWindow;
      }
    | { problem: { error: string; message: string } }
  > {
    const steps = parseSteps(request.query.steps);
    if (steps === null) return { problem: INVALID_STEPS };
    const count = request.query.count ?? "visitors";
    const window = request.query.window ?? MAX_VISITOR_WINDOW;
    const refusal = funnelRefusal(steps, count, window);
    if (refusal !== null) return { problem: refusal };
    const asked = await rangeOf(request);
    if ("problem" in asked) return asked;
    return { ...asked, steps, count, window };
  }

  app.get<{ Params: { id: string }; Querystring: RangeQuery }>(
    "/projects/:id/events",
    {
      preHandler: [signedIn, canView],
      schema: {
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", pattern: UUID_PATTERN } },
        },
        querystring: { type: "object", additionalProperties: false, properties: RANGE_PROPERTIES },
      },
    },
    async (request, reply) => {
      const asked = await rangeOf(request);
      if ("problem" in asked) return reply.code(400).send(asked.problem);
      const { range } = asked;
      const [events, environments] = await Promise.all([
        listEvents(reader, range),
        productEnvironments(reader, range),
      ]);
      return { ...answer(range), environments, events };
    },
  );

  app.get<{
    Params: { id: string; name: string };
    Querystring: RangeQuery & Record<string, string>;
  }>(
    "/projects/:id/events/:name",
    { preHandler: [signedIn, canView], schema: eventSchema },
    async (request, reply) => {
      const filters = eventFiltersOf(request.url);
      if ("problem" in filters) return reply.code(400).send(filters.problem);
      const asked = await rangeOf(request);
      if ("problem" in asked) return reply.code(400).send(asked.problem);
      const { range } = asked;
      const detail = await eventDetail(reader, range, request.params.name, filters.filters);
      return { ...answer(range), filters: filters.filters, ...detail };
    },
  );

  /**
   * The event by its visit's source and campaign (events.ts, eventSources):
   * its own request, so the event's page does not wait for it, and its
   * query within the dashboard's query limit.
   */
  app.get<{
    Params: { id: string; name: string };
    Querystring: RangeQuery & Record<string, string>;
  }>(
    "/projects/:id/events/:name/sources",
    { preHandler: [signedIn, canView], schema: eventSchema },
    async (request, reply) => {
      const filters = eventFiltersOf(request.url);
      if ("problem" in filters) return reply.code(400).send(filters.problem);
      const asked = await rangeOf(request);
      if ("problem" in asked) return reply.code(400).send(asked.problem);
      const { range } = asked;
      const sources = await eventSources(
        dashboardReader(clickhouse, limiter, reply),
        range,
        request.params.name,
        filters.filters,
        await ownHostnames(db, range.projectId),
      );
      return { ...answer(range), filters: filters.filters, ...sources };
    },
  );

  app.get<{ Params: { id: string }; Querystring: FunnelQuery }>(
    "/projects/:id/funnel",
    {
      preHandler: [signedIn, canView],
      schema: funnelSchema(),
    },
    async (request, reply) => {
      const asked = await funnelOf(request);
      if ("problem" in asked) return reply.code(400).send(asked.problem);
      const { range, moment, steps, count, window } = asked;
      // The period before, compared as the Web analytics summary is (reports.ts, previousDays).
      const previous = await previousDays(
        db,
        range.firstDay,
        range.lastDay,
        range.timeZone,
        moment,
      );
      const before: ProductRange = {
        ...range,
        firstDay: previous.firstDay,
        lastDay: previous.lastDay,
        from: previous.from,
        to: previous.to,
      };
      const [results, earlier, environments] = await Promise.all([
        funnel(reader, range, steps, count, window),
        funnel(reader, before, steps, count, window, {
          until: previousReadEnd(range, previous, window, moment),
        }),
        productEnvironments(reader, range, COUNTED.funnel),
      ]);
      return {
        ...answer(range),
        environments,
        count,
        window,
        steps: results,
        previous: {
          firstDay: previous.firstDay,
          lastDay: previous.lastDay,
          until: previous.until,
          reached: earlier.map((step) => step.reached),
        },
      };
    },
  );

  /**
   * The funnel by one dimension (funnel.ts, funnelBreakdown): its own
   * request, so choosing one leaves the funnel's answer as it is, and its
   * query within the dashboard's query limit.
   */
  app.get<{ Params: { id: string }; Querystring: FunnelQuery & { by: string } }>(
    "/projects/:id/funnel/breakdown",
    {
      preHandler: [signedIn, canView],
      schema: funnelSchema({ by: { type: "string", minLength: 1, maxLength: 200 } }, ["by"]),
    },
    async (request, reply) => {
      const by = breakdownOf(request.query.by);
      if (by === null) return reply.code(400).send(INVALID_BREAKDOWN);
      const asked = await funnelOf(request);
      if ("problem" in asked) return reply.code(400).send(asked.problem);
      const { range, steps, count, window } = asked;
      if ("property" in by && steps[0]?.type !== "event") {
        return reply.code(400).send({
          error: "invalid_breakdown",
          message: "Only a funnel whose step 1 is an event can be broken down by a property.",
        });
      }
      const rows = await funnelBreakdown(
        dashboardReader(clickhouse, limiter, reply),
        range,
        steps,
        count,
        window,
        by,
        "visit" in by ? await ownHostnames(db, range.projectId) : [],
      );
      return { ...answer(range), count, window, by: request.query.by, rows };
    },
  );

  /**
   * The funnel's overall conversion per day, or per week for a long period,
   * by each person's first step 1 (funnel.ts, funnelTrend): one query,
   * within the dashboard's query limit.
   */
  app.get<{ Params: { id: string }; Querystring: FunnelQuery }>(
    "/projects/:id/funnel/trend",
    { preHandler: [signedIn, canView], schema: funnelSchema() },
    async (request, reply) => {
      const asked = await funnelOf(request);
      if ("problem" in asked) return reply.code(400).send(asked.problem);
      const { range, steps, count, window } = asked;
      const unit = trendUnit(range);
      const points = await funnelTrend(
        dashboardReader(clickhouse, limiter, reply),
        range,
        steps,
        count,
        window,
        unit,
      );
      return { ...answer(range), count, window, unit, points };
    },
  );

  /**
   * The time from each step to the next and from step 1 to the last
   * (funnel.ts, funnelTimes): one query, within the dashboard's query limit.
   */
  app.get<{ Params: { id: string }; Querystring: FunnelQuery }>(
    "/projects/:id/funnel/times",
    { preHandler: [signedIn, canView], schema: funnelSchema() },
    async (request, reply) => {
      const asked = await funnelOf(request);
      if ("problem" in asked) return reply.code(400).send(asked.problem);
      const { range, steps, count, window } = asked;
      const times = await funnelTimes(
        dashboardReader(clickhouse, limiter, reply),
        range,
        steps,
        count,
        window,
      );
      return { ...answer(range), count, window, ...times };
    },
  );

  /**
   * The signed-in users whose furthest step is `step` (funnel.ts,
   * funnelPeople). They are user IDs, so this needs the users area as
   * well as product analytics, as the Users pages do.
   */
  app.get<{
    Params: { id: string };
    Querystring: FunnelQuery & { step: number; outcome: PeopleOutcome };
  }>(
    "/projects/:id/funnel/people",
    {
      preHandler: [signedIn, canView],
      schema: funnelSchema(
        {
          step: { type: "integer", minimum: 1, maximum: MAX_STEPS },
          outcome: { type: "string", enum: PEOPLE_OUTCOMES },
        },
        ["step", "outcome"],
      ),
    },
    async (request, reply) => {
      if (!canUse(accessOf(request).user, "users", "view")) {
        return reply.code(403).send(FORBIDDEN);
      }
      const asked = await funnelOf(request);
      if ("problem" in asked) return reply.code(400).send(asked.problem);
      const { range, steps, count, window } = asked;
      const { step, outcome } = request.query;
      if (count !== "users") {
        return reply.code(400).send({
          error: "people_need_users",
          message: "Lists of people need a funnel that counts users. Visitor IDs are not people.",
        });
      }
      const last = steps.length;
      if (step > last || (outcome === "converted") !== (step === last)) {
        return reply.code(400).send({
          error: "invalid_step",
          message: `"converted" is for the last step, ${last}; "dropped" for steps 1 to ${last - 1}.`,
        });
      }
      const people = await funnelPeople(
        dashboardReader(clickhouse, limiter, reply),
        range,
        steps,
        window,
        step,
      );
      return { ...answer(range), step, outcome, limit: PEOPLE_LIMIT, ...people };
    },
  );

  /**
   * Every saved funnel's counts for one period and environment, for the
   * saved funnels list: one request whose queries stay within the
   * dashboard's query limit, rather than one request per funnel.
   */
  app.get<{ Params: { id: string }; Querystring: RangeQuery }>(
    "/projects/:id/funnels/results",
    {
      preHandler: [signedIn, canView],
      schema: {
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", pattern: UUID_PATTERN } },
        },
        querystring: { type: "object", additionalProperties: false, properties: RANGE_PROPERTIES },
      },
    },
    async (request, reply) => {
      const asked = await rangeOf(request);
      if ("problem" in asked) return reply.code(400).send(asked.problem);
      const { range } = asked;
      const saved = await listSavedFunnels(db, range.projectId);
      const limited = dashboardReader(clickhouse, limiter, reply);
      // A stored definition that no longer passes the checks gets no result.
      const valid = saved.filter(
        (item) =>
          item.steps.length > 0 && funnelRefusal(item.steps, item.count, item.window) === null,
      );
      const funnels = await Promise.all(
        valid.map(async (item) => ({
          id: item.id,
          count: item.count,
          window: item.window,
          steps: await funnel(limited, range, item.steps, item.count, item.window),
        })),
      );
      return { ...answer(range), funnels };
    },
  );

  app.get<{ Params: { id: string }; Querystring: RangeQuery }>(
    "/projects/:id/retention",
    {
      preHandler: [signedIn, canView],
      schema: {
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", pattern: UUID_PATTERN } },
        },
        querystring: { type: "object", additionalProperties: false, properties: RANGE_PROPERTIES },
      },
    },
    async (request, reply) => {
      const asked = await rangeOf(request);
      if ("problem" in asked) return reply.code(400).send(asked.problem);
      const { range } = asked;
      const today = dayIn(range.timeZone)(now());
      const [report, environments] = await Promise.all([
        retention(reader, range, today),
        productEnvironments(reader, range, COUNTED.retention),
      ]);
      return { ...answer(range), environments, ...report };
    },
  );

  done();
};
