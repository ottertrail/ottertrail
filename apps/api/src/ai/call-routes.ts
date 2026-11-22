import type { FastifyPluginCallback, FastifyReply } from "fastify";
import type { Kysely } from "kysely";

import { canUse, type ProjectAccess, requireProjectAccess } from "../access/access.ts";
import type { Auth } from "../auth/auth.ts";
import { requireSession } from "../auth/routes.ts";
import type { ClickHouseClient } from "../clickhouse/clickhouse.ts";
import { clickHouseErrorHandler } from "../clickhouse/route-errors.ts";
import { environmentOf } from "../collection/environment.ts";
import { USER_ID_PATTERN } from "../collection/identity.ts";
import type { Database } from "../db/schema.ts";
import { localDays } from "../reports/reports.ts";
import { RANGE_PROPERTIES, type RangeQuery, requestDays } from "../reports/routes.ts";
import { DashboardQueryLimiter, dashboardReader } from "../telemetry/dashboard-limit.ts";
import { SERVICE_PATTERN, type TelemetryRange } from "../telemetry/dashboard-query.ts";
import { dayIn } from "../visitors/visitor-ids.ts";
import {
  aiCallById,
  type AiCallFilters,
  aiCallTotals,
  aiConversation,
  aiConversations,
  CALL_CURSOR_PATTERN,
  CALL_ID_PATTERN,
  callCursorOf,
  CALLS_PAGE_SIZE,
  listAiCalls,
  MAX_CONVERSATION_CALLS,
  MAX_CONVERSATIONS,
} from "./call-list.ts";
import { CONVERSATION_ID_PATTERN, MAX_AI_LABEL_CHARS } from "./calls.ts";
import { readPriceBook } from "./custom-prices.ts";
import type { PriceBook } from "./prices.ts";
import { aiLabels, type AiScope, hasAiCalls } from "./report.ts";

const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

/** A label as a filter: what the rows can hold (ai/calls.ts), with no control characters. */
const LABEL = { type: "string", pattern: `^[^\\u0000-\\u001F\\u007F]{1,${MAX_AI_LABEL_CHARS}}$` };

/** The list's filters: the AI page's (routes.ts), a user, a conversation, and the failed calls. */
const FILTER_PROPERTIES = {
  ...RANGE_PROPERTIES,
  service: { type: "string", pattern: SERVICE_PATTERN },
  provider: LABEL,
  model: LABEL,
  // "" is the calls that name no feature ("Unlabeled").
  feature: { type: "string", pattern: `^[^\\u0000-\\u001F\\u007F]{0,${MAX_AI_LABEL_CHARS}}$` },
  user: { type: "string", pattern: USER_ID_PATTERN },
  conversation: { type: "string", pattern: CONVERSATION_ID_PATTERN },
  status: { type: "string", enum: ["failed"] },
};

type ListQuery = RangeQuery & {
  service?: string;
  provider?: string;
  model?: string;
  feature?: string;
  user?: string;
  conversation?: string;
  status?: "failed";
  before?: string;
};

/** An ISO time in UTC, as the dashboard sends a call's start. */
const MOMENT_PATTERN = "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{1,9})?Z$";

/** A call with no time to look around is looked for this far back. */
const UNTIMED_LOOKUP_DAYS = 366;

const filtersOf = (query: ListQuery): AiCallFilters => ({
  service: query.service,
  provider: query.provider,
  model: query.model,
  feature: query.feature,
  user: query.user,
  conversation: query.conversation,
  failed: query.status === "failed" ? true : undefined,
});

function accessOf(request: { projectAccess: ProjectAccess | null }): ProjectAccess {
  if (request.projectAccess === null) {
    throw new Error("requireProjectAccess must run before this route");
  }
  return request.projectAccess;
}

const answered = (range: TelemetryRange) => ({
  timeZone: range.timeZone,
  environment: range.environment,
  firstDay: range.firstDay,
  lastDay: range.lastDay,
});

const scopeOf = (range: TelemetryRange, prices: PriceBook): AiScope => ({
  projectId: range.projectId,
  environment: range.environment,
  from: range.from,
  to: range.to,
  prices,
});

const listSchema = (params: object, extra: object = {}) => ({
  params,
  querystring: {
    type: "object",
    additionalProperties: false,
    properties: { ...FILTER_PROPERTIES, ...extra },
  },
});

const PROJECT = { id: { type: "string", pattern: UUID_PATTERN } };
const PARAMS = { type: "object", required: ["id"], properties: PROJECT };

const USERS_NEEDED = {
  error: "forbidden",
  message: "Filtering AI calls by user needs access to the Users area.",
};

/**
 * GET /api/projects/:id/ai/call-list[?…the AI page's filters…&user=…&conversation=…&status=failed&before=…]
 *     (the calls, newest first, a page at a time, and the period's totals)
 * GET /api/projects/:id/ai/calls/:callId[?at=…]
 *     (one call, every stored field, and where its price comes from)
 * GET /api/projects/:id/ai/conversations[?…the same filters…]
 *     (the period's conversations, by their last call)
 * GET /api/projects/:id/ai/conversations/:conversationId[?…the same filters…]
 *     (one conversation's calls in the period, in order, and its figures)
 *
 * The AI calls list (docs/ai-usage.md, "The calls list"; call-list.ts).
 * Each runs requireProjectAccess for the AI area at view, as the AI page's
 * routes do, and reads only the project it found. A call's user, and the
 * `user` filter, need users at view too: without it, users are null,
 * `usersHidden` is true, and a request with `user` is refused (403), so a
 * user's calls cannot be found by their ID.
 */
export const aiCallListRoutes: FastifyPluginCallback<{
  db: Kysely<Database>;
  clickhouse: ClickHouseClient;
  auth: Auth;
  /** How long spans are kept: a call older has no trace left to open. */
  traceRetentionDays: number;
  now?: () => Date;
  limiter?: DashboardQueryLimiter;
}> = (
  app,
  {
    db,
    clickhouse,
    auth,
    traceRetentionDays,
    now = () => new Date(),
    limiter = new DashboardQueryLimiter(),
  },
  done,
) => {
  const signedIn = requireSession(auth);
  const canView = requireProjectAccess(db, { area: "ai", level: "view" });
  const readerOf = (reply: FastifyReply) => dashboardReader(clickhouse, limiter, reply);
  app.setErrorHandler(clickHouseErrorHandler);

  async function rangeOf(
    request: { query: ListQuery; projectAccess: ProjectAccess | null },
    moment: Date,
  ): Promise<{ range: TelemetryRange } | { problem: { error: string; message: string } }> {
    const { projectId, timeZone } = accessOf(request);
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
        dayStart: from,
        from,
        to,
      },
    };
  }

  /** The request's range, scope, and filters; or the answer that refuses it. */
  async function prepared(
    request: { query: ListQuery; projectAccess: ProjectAccess | null },
    reply: FastifyReply,
  ) {
    const withUsers = canUse(accessOf(request).user, "users", "view");
    if (request.query.user !== undefined && !withUsers) {
      await reply.code(403).send(USERS_NEEDED);
      return null;
    }
    const asked = await rangeOf(request, now());
    if ("problem" in asked) {
      await reply.code(400).send(asked.problem);
      return null;
    }
    const { range } = asked;
    return {
      range,
      scope: scopeOf(range, await readPriceBook(db)),
      filters: filtersOf(request.query),
      withUsers,
    };
  }

  /** What the filter bar offers, as the AI page's report answers it (routes.ts). */
  async function labelsOf(reply: FastifyReply, scope: AiScope) {
    const reader = readerOf(reply);
    const [labels, received] = await Promise.all([
      aiLabels(reader, scope),
      hasAiCalls(reader, scope.projectId),
    ]);
    return {
      environments: labels.environments,
      services: labels.services,
      filterOptions: {
        services: labels.services,
        providers: labels.providers,
        models: labels.models,
        features: labels.features,
      },
      received,
    };
  }

  app.get<{ Params: { id: string }; Querystring: ListQuery }>(
    "/projects/:id/ai/call-list",
    {
      preHandler: [signedIn, canView],
      schema: listSchema(PARAMS, { before: { type: "string", pattern: CALL_CURSOR_PATTERN } }),
    },
    async (request, reply) => {
      const before = callCursorOf(request.query.before);
      if (before === null) {
        return reply
          .code(400)
          .send({ error: "invalid_cursor", message: "The cursor is out of range." });
      }
      const ready = await prepared(request, reply);
      if (ready === null) return reply;
      const { range, scope, filters, withUsers } = ready;
      const reader = readerOf(reply);
      // A later page (Load older calls) is only its calls: the first page's
      // totals and filter options stand for the whole list.
      const later = before !== undefined;
      const [page, totals, labels] = await Promise.all([
        listAiCalls(reader, scope, filters, { before, withUsers }),
        later ? null : aiCallTotals(reader, scope, filters),
        later ? null : labelsOf(reply, scope),
      ]);
      return {
        ...answered(range),
        ...(labels ?? { environments: null, services: null, filterOptions: null, received: null }),
        usersHidden: !withUsers,
        pageSize: CALLS_PAGE_SIZE,
        totals,
        calls: page.calls,
        next: page.next,
      };
    },
  );

  app.get<{ Params: { id: string; callId: string }; Querystring: { at?: string } }>(
    "/projects/:id/ai/calls/:callId",
    {
      preHandler: [signedIn, canView],
      schema: {
        params: {
          type: "object",
          required: ["id", "callId"],
          properties: { ...PROJECT, callId: { type: "string", pattern: CALL_ID_PATTERN } },
        },
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: { at: { type: "string", pattern: MOMENT_PATTERN } },
        },
      },
    },
    async (request, reply) => {
      const { projectId, timeZone, user } = accessOf(request);
      const withUsers = canUse(user, "users", "view");
      const moment = now();
      const at = request.query.at === undefined ? undefined : new Date(request.query.at);
      if (at !== undefined && Number.isNaN(at.getTime())) {
        return reply.code(400).send({ error: "invalid_time", message: "`at` is not a time." });
      }
      const found = await aiCallById(
        readerOf(reply),
        {
          projectId,
          id: request.params.callId,
          at,
          from: new Date(moment.getTime() - UNTIMED_LOOKUP_DAYS * 86_400_000),
          to: new Date(moment.getTime() + 3_600_000),
          prices: await readPriceBook(db),
        },
        withUsers,
      );
      if (found === null) {
        // Not "not_found", which the access check answers for an unknown project.
        return reply.code(404).send({ error: "no_such_call", message: "No AI call has this ID." });
      }
      const keptFrom = moment.getTime() - traceRetentionDays * 86_400_000;
      return {
        timeZone,
        usersHidden: !withUsers,
        traceRetentionDays,
        // Its trace's spans are kept no longer than this: older, the trace is gone.
        traceKept: found.call.traceId !== "" && found.call.at.getTime() >= keptFrom,
        call: found.call,
        price: found.price,
      };
    },
  );

  app.get<{ Params: { id: string }; Querystring: ListQuery }>(
    "/projects/:id/ai/conversations",
    { preHandler: [signedIn, canView], schema: listSchema(PARAMS) },
    async (request, reply) => {
      const ready = await prepared(request, reply);
      if (ready === null) return reply;
      const { range, scope, filters, withUsers } = ready;
      const [list, labels] = await Promise.all([
        aiConversations(readerOf(reply), scope, filters, { withUsers }),
        labelsOf(reply, scope),
      ]);
      return {
        ...answered(range),
        ...labels,
        usersHidden: !withUsers,
        limit: MAX_CONVERSATIONS,
        more: list.more,
        conversations: list.conversations,
      };
    },
  );

  app.get<{ Params: { id: string; conversationId: string }; Querystring: ListQuery }>(
    "/projects/:id/ai/conversations/:conversationId",
    {
      preHandler: [signedIn, canView],
      schema: listSchema({
        type: "object",
        required: ["id", "conversationId"],
        properties: {
          ...PROJECT,
          conversationId: { type: "string", pattern: CONVERSATION_ID_PATTERN },
        },
      }),
    },
    async (request, reply) => {
      const ready = await prepared(request, reply);
      if (ready === null) return reply;
      const { range, scope, filters, withUsers } = ready;
      const conversation = await aiConversation(
        readerOf(reply),
        scope,
        filters,
        request.params.conversationId,
        { withUsers },
      );
      return {
        ...answered(range),
        conversationId: request.params.conversationId,
        usersHidden: !withUsers,
        limit: MAX_CONVERSATION_CALLS,
        more: conversation.more,
        figures: conversation.figures,
        calls: conversation.calls,
      };
    },
  );

  done();
};
