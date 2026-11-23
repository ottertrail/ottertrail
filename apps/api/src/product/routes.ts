import type { FastifyPluginCallback } from "fastify";
import type { Kysely } from "kysely";

import { type ProjectAccess, requireProjectAccess } from "../access/access.ts";
import type { Auth } from "../auth/auth.ts";
import { requireSession } from "../auth/routes.ts";
import type { ClickHouseClient } from "../clickhouse/clickhouse.ts";
import type { Reader } from "../clickhouse/query.ts";
import { clickHouseErrorHandler } from "../clickhouse/route-errors.ts";
import { environmentOf } from "../collection/environment.ts";
import { EVENT_NAME_SCHEMA } from "../collection/routes.ts";
import type { Database } from "../db/schema.ts";
import { localDays } from "../reports/reports.ts";
import { RANGE_PROPERTIES, type RangeQuery, requestDays } from "../reports/routes.ts";
import { dayIn } from "../visitors/visitor-ids.ts";
import {
  COUNTED,
  eventDetail,
  listEvents,
  MAX_FILTERS,
  type ProductRange,
  productEnvironments,
  type PropertyFilter,
} from "./events.ts";
import {
  funnel,
  FUNNEL_COUNTS,
  FUNNEL_WINDOWS,
  type FunnelCount,
  funnelRefusal,
  type FunnelStep,
  funnelStepsOf,
  type FunnelWindow,
  INVALID_STEPS,
  MAX_VISITOR_WINDOW,
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

/** Parse 2 to 5 page or event steps; return null on invalid input. */
export function parseSteps(text: string): FunnelStep[] | null {
  try {
    return funnelStepsOf(JSON.parse(text));
  } catch {
    return null;
  }
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
  now?: () => Date;
}> = (app, { db, clickhouse, auth, now = () => new Date() }, done) => {
  const signedIn = requireSession(auth);
  const canView = requireProjectAccess(db, { area: "product_analytics", level: "view" });
  const reader: Reader = { client: clickhouse };
  app.setErrorHandler(clickHouseErrorHandler);

  async function rangeOf(request: {
    query: RangeQuery;
    projectAccess: ProjectAccess | null;
  }): Promise<{ range: ProductRange } | { problem: { error: string; message: string } }> {
    const { projectId, timeZone } = accessOf(request);
    const days = requestDays(request.query, dayIn(timeZone)(now()));
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
    };
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
    {
      preHandler: [signedIn, canView],
      schema: {
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
      },
    },
    async (request, reply) => {
      const filters = filtersOf(request.url);
      if (filters === null) {
        return reply.code(400).send({
          error: "invalid_filter",
          message:
            "A filter is p.<property>=<value>: a property name of 1 to 100 characters and a value up to 500, without NUL.",
        });
      }
      if (filters.length > MAX_FILTERS) {
        return reply.code(400).send({
          error: "too_many_filters",
          message: `At most ${MAX_FILTERS} property filters.`,
        });
      }
      const asked = await rangeOf(request);
      if ("problem" in asked) return reply.code(400).send(asked.problem);
      const { range } = asked;
      const detail = await eventDetail(reader, range, request.params.name, filters);
      return { ...answer(range), filters, ...detail };
    },
  );

  app.get<{
    Params: { id: string };
    Querystring: RangeQuery & { steps: string; count?: FunnelCount; window?: FunnelWindow };
  }>(
    "/projects/:id/funnel",
    {
      preHandler: [signedIn, canView],
      schema: {
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", pattern: UUID_PATTERN } },
        },
        querystring: {
          type: "object",
          required: ["steps"],
          additionalProperties: false,
          properties: {
            ...RANGE_PROPERTIES,
            steps: { type: "string", maxLength: 8000 },
            count: { type: "string", enum: FUNNEL_COUNTS },
            window: { type: "integer", enum: FUNNEL_WINDOWS },
          },
        },
      },
    },
    async (request, reply) => {
      const steps = parseSteps(request.query.steps);
      if (steps === null) return reply.code(400).send(INVALID_STEPS);
      const count = request.query.count ?? "visitors";
      const window = request.query.window ?? MAX_VISITOR_WINDOW;
      const refusal = funnelRefusal(steps, count, window);
      if (refusal !== null) return reply.code(400).send(refusal);
      const asked = await rangeOf(request);
      if ("problem" in asked) return reply.code(400).send(asked.problem);
      const { range } = asked;
      const [results, environments] = await Promise.all([
        funnel(reader, range, steps, count, window),
        productEnvironments(reader, range, COUNTED.funnel),
      ]);
      return { ...answer(range), environments, count, window, steps: results };
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
