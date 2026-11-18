import type { FastifyPluginCallback } from "fastify";
import type { Kysely } from "kysely";

import {
  canUse,
  FORBIDDEN,
  type ProjectAccess,
  requireProjectAccess,
  type UserAccess,
} from "../access/access.ts";
import type { Auth } from "../auth/auth.ts";
import { requireTrustedOrigin } from "../auth/origin.ts";
import { requireSession } from "../auth/routes.ts";
import type { ClickHouseClient } from "../clickhouse/clickhouse.ts";
import type { Database } from "../db/schema.ts";
import { listChannels } from "../notifications/channels.ts";
import type { Problem } from "../outbound/url.ts";
import { DashboardQueryLimiter, dashboardReader } from "../telemetry/dashboard-limit.ts";
import { RULE_HOURLY_CAP } from "./fire.ts";
import {
  MAX_RULE_CHANNELS,
  MAX_RULE_NAME,
  MAX_RULES,
  RULE_KINDS,
  isRuleKind,
  type RuleKind,
  SETTINGS_SCHEMA,
  sourceAreaOf,
} from "./kinds.ts";
import {
  createRule,
  deleteRule,
  findRule,
  firingAlerts,
  HISTORY_RETENTION_DAYS,
  listHistory,
  listRules,
  MAX_HISTORY_PAGE,
  type Rule,
  type RuleInput,
  ruleValuesOf,
  updateRule,
  valuesOfRule,
} from "./rules.ts";
import { notSeenWarning } from "./telemetry-rules.ts";

const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

const PARAMS = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string", pattern: UUID_PATTERN } },
};

const RULE_PARAMS = {
  type: "object",
  required: ["id", "ruleId"],
  properties: {
    id: { type: "string", pattern: UUID_PATTERN },
    ruleId: { type: "string", pattern: UUID_PATTERN },
  },
};

/** A rule's fields; bounds a little past the real ones where ruleValuesOf words them. */
const RULE_FIELDS = {
  name: { type: "string", maxLength: MAX_RULE_NAME * 2 },
  kind: { type: "string", enum: [...RULE_KINDS] },
  settings: SETTINGS_SCHEMA,
  channelIds: {
    type: "array",
    maxItems: MAX_RULE_CHANNELS,
    items: { type: "string", pattern: UUID_PATTERN },
  },
  enabled: { type: "boolean" },
};

const PAGE_QUERY = {
  type: "object",
  additionalProperties: false,
  properties: {
    before: { type: "string", pattern: UUID_PATTERN },
    limit: { type: "integer", minimum: 1, maximum: MAX_HISTORY_PAGE },
  },
};

/** A rule is a name, a few settings, and up to 20 channel IDs. */
const BODY_LIMIT = 16 * 1024;
const DEFAULT_PAGE = 20;

const NO_RULE: Problem = {
  error: "rule_not_found",
  message: "The project has no alert rule with this ID.",
};

/** The access requireProjectAccess set: these routes always run it. */
function accessOf(request: { projectAccess: ProjectAccess | null }): ProjectAccess {
  if (request.projectAccess === null) {
    throw new Error("requireProjectAccess must run before this route");
  }
  return request.projectAccess;
}

/**
 * Whether the user may see rules of this kind: uptime and alerts (the
 * route checks it), and the area the kind watches (docs/access.md).
 */
function canSeeKind(user: UserAccess, kind: RuleKind): boolean {
  const area = sourceAreaOf(kind);
  return area === null || canUse(user, area, "view");
}

/** Whether a kind sent in a request is one the user may use; the schema refuses unknown kinds first. */
const mayUseKind = (user: UserAccess, kind: string | undefined) =>
  isRuleKind(kind) && canSeeKind(user, kind);

/** The kinds the user may see; never empty, as check rules need only uptime and alerts. */
const visibleKinds = (user: UserAccess) => RULE_KINDS.filter((kind) => canSeeKind(user, kind));

/**
 * GET    /api/projects/:id/alert-rules
 * POST   /api/projects/:id/alert-rules                 { "kind": "check_down", "channelIds": […], … }
 * GET    /api/projects/:id/alert-rules/:ruleId
 * PATCH  /api/projects/:id/alert-rules/:ruleId         any fields, or { "enabled": false }
 * DELETE /api/projects/:id/alert-rules/:ruleId
 * GET    /api/projects/:id/alert-rules/:ruleId/history[?before=<alert ID>&limit=20]
 * GET    /api/projects/:id/alerts[?before=<alert ID>&limit=20]   the project's alerts
 * GET    /api/projects/:id/alerts/firing
 * GET    /api/projects/:id/alert-channels                the instance's channels, by name only
 *
 * A project's alert rules (rules.ts; docs/uptime-alerts.md, "Alerts"):
 * at most 50, each sending to one or more of the instance's channels. A
 * rule's channels must exist and its check must be the project's (400
 * otherwise). A telemetry rule whose service, route, or metric has not
 * reported in the last days is saved, with a `warning` saying so: it may
 * be set up before the app is deployed. Changes need the dashboard's
 * origin. Like every project
 * route, each runs requireProjectAccess first, and reads only the
 * project it found.
 */
export const alertRoutes: FastifyPluginCallback<{
  db: Kysely<Database>;
  /** Where a telemetry rule's service or metric is looked for. */
  clickhouse: ClickHouseClient;
  auth: Auth;
  trustedOrigins: readonly string[];
  /** The dashboard's limit on ClickHouse queries at once, shared with its pages. */
  limiter?: DashboardQueryLimiter;
  now?: () => Date;
}> = (
  app,
  {
    db,
    clickhouse,
    auth,
    trustedOrigins,
    limiter = new DashboardQueryLimiter(),
    now = () => new Date(),
  },
  done,
) => {
  const signedIn = requireSession(auth);
  const canView = requireProjectAccess(db, { area: "uptime_alerts", level: "view" });
  const canManage = requireProjectAccess(db, { area: "uptime_alerts", level: "manage" });
  const fromDashboard = requireTrustedOrigin(trustedOrigins);

  /**
   * The rule as answered, with why a telemetry rule may not fire yet, if it
   * may not. The warning says whether a service, route, or metric reported,
   * so only those who may read monitoring get it.
   */
  const saved = async (
    rule: Rule,
    access: ProjectAccess,
    reply: Parameters<typeof dashboardReader>[2],
  ) => ({
    rule,
    warning: canUse(access.user, "monitoring", "view")
      ? await notSeenWarning(
          dashboardReader(clickhouse, limiter, reply),
          access.projectId,
          rule.kind,
          rule.settings,
          now(),
        )
      : null,
  });

  /** The rule, if it exists and the user may see its kind; otherwise null, as a missing rule. */
  const visibleRule = async (access: ProjectAccess, ruleId: string) => {
    const rule = await findRule(db, access.projectId, ruleId);
    return rule === null || !canSeeKind(access.user, rule.kind) ? null : rule;
  };

  app.get<{ Params: { id: string } }>(
    "/projects/:id/alert-rules",
    { preHandler: [signedIn, canView], schema: { params: PARAMS } },
    async (request) => {
      const { projectId, timeZone, user } = accessOf(request);
      return {
        timeZone,
        maxRules: MAX_RULES,
        hourlyCap: RULE_HOURLY_CAP,
        rules: (await listRules(db, projectId)).filter((rule) => canSeeKind(user, rule.kind)),
      };
    },
  );

  app.post<{ Params: { id: string }; Body: RuleInput }>(
    "/projects/:id/alert-rules",
    {
      preHandler: [fromDashboard, signedIn, canManage],
      bodyLimit: BODY_LIMIT,
      schema: {
        params: PARAMS,
        body: {
          type: "object",
          required: ["kind", "channelIds"],
          additionalProperties: false,
          properties: RULE_FIELDS,
        },
      },
    },
    async (request, reply) => {
      const access = accessOf(request);
      const { projectId } = access;
      if (!mayUseKind(access.user, request.body.kind)) return reply.code(403).send(FORBIDDEN);
      const values = ruleValuesOf(request.body);
      if ("error" in values) return reply.code(400).send(values);
      const created = await createRule(db, projectId, values, now());
      if ("refused" in created) {
        return reply.code(409).send({
          error: "too_many_rules",
          message: `A project has at most ${MAX_RULES} alert rules.`,
        });
      }
      if ("problem" in created) return reply.code(400).send(created.problem);
      return reply.code(201).send(await saved(created.rule, access, reply));
    },
  );

  app.get<{ Params: { id: string; ruleId: string } }>(
    "/projects/:id/alert-rules/:ruleId",
    { preHandler: [signedIn, canView], schema: { params: RULE_PARAMS } },
    async (request, reply) => {
      const rule = await visibleRule(accessOf(request), request.params.ruleId);
      return rule === null ? reply.code(404).send(NO_RULE) : { rule };
    },
  );

  app.patch<{ Params: { id: string; ruleId: string }; Body: RuleInput }>(
    "/projects/:id/alert-rules/:ruleId",
    {
      preHandler: [fromDashboard, signedIn, canManage],
      bodyLimit: BODY_LIMIT,
      schema: {
        params: RULE_PARAMS,
        body: {
          type: "object",
          additionalProperties: false,
          minProperties: 1,
          properties: RULE_FIELDS,
        },
      },
    },
    async (request, reply) => {
      const access = accessOf(request);
      const { projectId } = access;
      const current = await visibleRule(access, request.params.ruleId);
      if (current === null) return reply.code(404).send(NO_RULE);
      // Another kind needs its own area too.
      if (request.body.kind !== undefined && !mayUseKind(access.user, request.body.kind)) {
        return reply.code(403).send(FORBIDDEN);
      }
      const values = ruleValuesOf(request.body, valuesOfRule(current));
      if ("error" in values) return reply.code(400).send(values);
      const updated = await updateRule(db, projectId, current.id, values, now(), {
        enabledSent: request.body.enabled !== undefined,
      });
      if (updated === null) return reply.code(404).send(NO_RULE);
      if ("problem" in updated) return reply.code(400).send(updated.problem);
      // Only a change of what it watches is looked for again.
      return request.body.kind === undefined && request.body.settings === undefined
        ? { rule: updated.rule, warning: null }
        : saved(updated.rule, access, reply);
    },
  );

  app.delete<{ Params: { id: string; ruleId: string } }>(
    "/projects/:id/alert-rules/:ruleId",
    { preHandler: [fromDashboard, signedIn, canManage], schema: { params: RULE_PARAMS } },
    async (request, reply) => {
      const access = accessOf(request);
      if ((await visibleRule(access, request.params.ruleId)) === null) {
        return reply.code(404).send(NO_RULE);
      }
      const deleted = await deleteRule(db, access.projectId, request.params.ruleId);
      return deleted ? reply.code(204).send() : reply.code(404).send(NO_RULE);
    },
  );

  app.get<{
    Params: { id: string; ruleId: string };
    Querystring: { before?: string; limit?: number };
  }>(
    "/projects/:id/alert-rules/:ruleId/history",
    {
      preHandler: [signedIn, canView],
      schema: { params: RULE_PARAMS, querystring: PAGE_QUERY },
    },
    async (request, reply) => {
      const access = accessOf(request);
      const { projectId, timeZone } = access;
      const rule = await visibleRule(access, request.params.ruleId);
      if (rule === null) return reply.code(404).send(NO_RULE);
      const page = await listHistory(db, projectId, {
        ruleId: rule.id,
        kinds: visibleKinds(access.user),
        before: request.query.before,
        limit: request.query.limit ?? DEFAULT_PAGE,
      });
      return { timeZone, retentionDays: HISTORY_RETENTION_DAYS, ...page };
    },
  );

  app.get<{ Params: { id: string }; Querystring: { before?: string; limit?: number } }>(
    "/projects/:id/alerts",
    { preHandler: [signedIn, canView], schema: { params: PARAMS, querystring: PAGE_QUERY } },
    async (request) => {
      const { projectId, timeZone, user } = accessOf(request);
      const page = await listHistory(db, projectId, {
        kinds: visibleKinds(user),
        before: request.query.before,
        limit: request.query.limit ?? DEFAULT_PAGE,
      });
      return { timeZone, retentionDays: HISTORY_RETENTION_DAYS, ...page };
    },
  );

  /**
   * The instance's channels by name, for choosing a rule's: never their
   * addresses, URLs, or secrets, which only the Settings page shows to
   * those who manage channels (docs/access.md).
   */
  app.get<{ Params: { id: string } }>(
    "/projects/:id/alert-channels",
    { preHandler: [signedIn, canView], schema: { params: PARAMS } },
    async () => ({
      channels: (await listChannels(db)).map(({ id, name, kind }) => ({ id, name, kind })),
    }),
  );

  app.get<{ Params: { id: string } }>(
    "/projects/:id/alerts/firing",
    { preHandler: [signedIn, canView], schema: { params: PARAMS } },
    async (request) => {
      const { projectId, timeZone, user } = accessOf(request);
      return { timeZone, alerts: await firingAlerts(db, projectId, visibleKinds(user)) };
    },
  );

  done();
};
