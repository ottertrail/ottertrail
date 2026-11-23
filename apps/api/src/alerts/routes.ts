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

/** Leave room for ruleValuesOf to return specific validation errors. */
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

const BODY_LIMIT = 16 * 1024;
const DEFAULT_PAGE = 20;

const NO_RULE: Problem = {
  error: "rule_not_found",
  message: "The project has no alert rule with this ID.",
};

function accessOf(request: { projectAccess: ProjectAccess | null }): ProjectAccess {
  if (request.projectAccess === null) {
    throw new Error("requireProjectAccess must run before this route");
  }
  return request.projectAccess;
}

/** Require uptime and alerts plus view access to the kind's area (docs/access.md). */
function canSeeKind(user: UserAccess, kind: RuleKind): boolean {
  const area = sourceAreaOf(kind);
  return area === null || canUse(user, area, "view");
}

function canSeeTelemetry(user: UserAccess, kind: RuleKind): boolean {
  const area = sourceAreaOf(kind);
  return (area === "monitoring" || area === "ai") && canUse(user, area, "view");
}

const mayUseKind = (user: UserAccess, kind: string | undefined) =>
  isRuleKind(kind) && canSeeKind(user, kind);

/** The kinds the user may see; never empty, as check rules need only uptime and alerts. */
export const visibleKinds = (user: UserAccess) =>
  RULE_KINDS.filter((kind) => canSeeKind(user, kind));

/**
 * Project alert routes (rules.ts; docs/uptime-alerts.md, "Alerts"). A missing telemetry source
 * produces a warning so rules can be saved before deployment. Changes require the dashboard's
 * origin; requireProjectAccess scopes every route.
 */
export const alertRoutes: FastifyPluginCallback<{
  db: Kysely<Database>;
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
   * Warnings reveal whether a source reported, so return them only to readers of the kind's
   * area.
   */
  const saved = async (
    rule: Rule,
    access: ProjectAccess,
    reply: Parameters<typeof dashboardReader>[2],
  ) => ({
    rule,
    warning: canSeeTelemetry(access.user, rule.kind)
      ? await notSeenWarning(
          dashboardReader(clickhouse, limiter, reply),
          access.projectId,
          rule.kind,
          rule.settings,
          now(),
        )
      : null,
  });

  /** Hide rules of inaccessible kinds with the same response as missing rules. */
  const visibleRule = async (access: ProjectAccess, ruleId: string) => {
    const rule = await findRule(db, access.projectId, ruleId, visibleKinds(access.user));
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
        rules: (await listRules(db, projectId, visibleKinds(user))).filter((rule) =>
          canSeeKind(user, rule.kind),
        ),
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
      const created = await createRule(db, projectId, values, now(), visibleKinds(access.user));
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
      if (request.body.kind !== undefined && !mayUseKind(access.user, request.body.kind)) {
        return reply.code(403).send(FORBIDDEN);
      }
      const values = ruleValuesOf(request.body, valuesOfRule(current));
      if ("error" in values) return reply.code(400).send(values);
      const updated = await updateRule(
        db,
        projectId,
        current.id,
        values,
        now(),
        visibleKinds(access.user),
        {
          enabledSent: request.body.enabled !== undefined,
        },
      );
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
   * Expose channel names only. Addresses, URLs, and secrets require channel management access
   * (docs/access.md).
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
