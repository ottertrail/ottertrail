import type { FastifyPluginCallback } from "fastify";
import type { Kysely } from "kysely";

import type { Auth } from "../auth/auth.ts";
import { requireSession } from "../auth/routes.ts";
import type { ClickHouseClient } from "../clickhouse/clickhouse.ts";
import type { Reader } from "../clickhouse/query.ts";
import { clickHouseErrorHandler } from "../clickhouse/route-errors.ts";
import { environmentOf } from "../collection/environment.ts";
import { EVENT_NAME_SCHEMA } from "../collection/routes.ts";
import type { Database } from "../db/schema.ts";
import { type ProjectAccess, requireProjectAccess } from "../organizations/access.ts";
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
  type FunnelStep,
  type FunnelWindow,
  MAX_STEPS,
  MAX_VISITOR_WINDOW,
  MIN_STEPS,
  overlappingStep,
} from "./funnel.ts";
import { retention } from "./retention.ts";
import { KEY, stepOf, VALUE } from "./steps.ts";

const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

/** "p.plan=team": a property filter in the address. The key is the rest of the name. */
const FILTER_PREFIX = "p.";

/** The access requireProjectAccess set: these routes always run it. */
function accessOf(request: { projectAccess: ProjectAccess | null }): ProjectAccess {
  if (request.projectAccess === null) {
    throw new Error("requireProjectAccess must run before this route");
  }
  return request.projectAccess;
}

/**
 * The property filters of a request: each "p.<key>" parameter of its
 * address, as sent. Null when one is not a filter collection could match
 * (a name of 1 to 100 characters, a value up to 500, no NUL): the schema
 * would drop such a parameter silently, and the page would show
 * unfiltered numbers under the filter.
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

/**
 * A funnel's steps from the address: a JSON array of 2 to 5 of
 * {"type":"event","name":"signup","filter":{"key":"plan","value":"team"}}
 * (filter optional) and {"type":"page","path":"/pricing"}. Null when not.
 */
export function parseSteps(text: string): FunnelStep[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length < MIN_STEPS || parsed.length > MAX_STEPS) {
    return null;
  }
  const steps = parsed.map(stepOf);
  return steps.every((step): step is FunnelStep => step !== null) ? steps : null;
}

/** What every answer says about its range. */
const answer = (range: ProductRange) => ({
  timeZone: range.timeZone,
  environment: range.environment,
  firstDay: range.firstDay,
  lastDay: range.lastDay,
});

/**
 * GET /api/projects/:id/events[?period=7d|from=…&to=…&environment=…]
 * GET /api/projects/:id/events/:name[?…&p.plan=team&p.seats=5]
 *
 * The project's product events, and one event with its properties
 * (events.ts; docs/product-analytics.md). Like every project route, both
 * run requireProjectAccess first.
 */
export const productRoutes: FastifyPluginCallback<{
  db: Kysely<Database>;
  clickhouse: ClickHouseClient;
  auth: Auth;
  now?: () => Date;
}> = (app, { db, clickhouse, auth, now = () => new Date() }, done) => {
  const signedIn = requireSession(auth);
  const projectAccess = requireProjectAccess(db);
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
      preHandler: [signedIn, projectAccess],
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
      preHandler: [signedIn, projectAccess],
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
          // A property filter: "p." and the property's name, up to 100
          // characters as collection allows, equal to a value up to 500.
          // Checked as sent by filtersOf: here only kept from being dropped.
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
      preHandler: [signedIn, projectAccess],
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
      if (steps === null) {
        return reply.code(400).send({
          error: "invalid_steps",
          message: `steps must be a JSON array of ${MIN_STEPS} to ${MAX_STEPS} steps: {"type":"event","name":…} or {"type":"page","path":"/…"}.`,
        });
      }
      const overlap = overlappingStep(steps);
      if (overlap !== null) {
        return reply.code(400).send({
          error: "steps_overlap",
          message: `Step ${overlap + 1} could match the same event as step ${overlap}, which would count it twice. Put another step between them, or filter both by different values of one property.`,
        });
      }
      const count = request.query.count ?? "visitors";
      const window = request.query.window ?? MAX_VISITOR_WINDOW;
      if (count === "visitors" && window > MAX_VISITOR_WINDOW) {
        return reply.code(400).send({
          error: "invalid_window",
          message:
            "Visitors can be followed for a day at most: their IDs change daily. Count users instead.",
        });
      }
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
      preHandler: [signedIn, projectAccess],
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
