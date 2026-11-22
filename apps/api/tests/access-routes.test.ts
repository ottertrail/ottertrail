import { expect, test } from "vite-plus/test";

import { PROJECT_REQUESTS, routeKey } from "./helpers/project-routes.ts";
import { describeDeclaration, registeredRoutes } from "./helpers/routes.ts";

/**
 * The routes anyone may call: health, collection with a project's key,
 * the scripts and the dashboard's files, sign-in, setup, and the heatmap
 * overlay's exchange and preflight. Every other
 * route must declare what it needs (docs/access.md).
 */
const PUBLIC_ROUTES = new Set([
  "GET /api/health",
  // Collection, with a project's public or secret key.
  "POST /api/events",
  "POST /api/server-events",
  "POST /api/ai-calls",
  "POST /api/replays",
  "POST /api/heatmaps",
  "PUT /api/source-maps",
  "POST /v1/traces",
  "POST /v1/logs",
  "POST /v1/metrics",
  // Scripts, and the dashboard's own files.
  "GET /t.js",
  "GET /v.js",
  "GET /r.js",
  "GET /h.js",
  "GET /o.js",
  "GET /replay-player.js",
  "GET /*",
  // Sign-in (Better Auth), setup, accepting an invitation, and a reset link.
  "GET /api/auth/*",
  "POST /api/auth/*",
  "GET /api/setup",
  "POST /api/setup",
  "POST /api/invite/preview",
  "POST /api/invite/accept",
  "POST /api/reset-password/preview",
  "POST /api/reset-password",
  // "Forgot password?" on the sign-in page: anyone may ask, so it answers
  // the same for every address, is limited per client address and per
  // email address, and only queues an email (docs/access.md).
  "POST /api/reset-password/request",
  // The heatmap overlay on a customer's site: exchanging a one-time link
  // token (in the body) for an overlay session, and the browser's
  // preflight for the read. They take no cookie; the read itself declares
  // the overlay token's access below (access.ts, requireOverlayAccess).
  "POST /api/heatmap-overlay/session",
  "OPTIONS /api/heatmap-overlay/:projectId/heatmap",
]);

/** What each dashboard route declares, as text: "errors:manage", "permission:channels" … */
const EXPECTED: Record<string, string> = {
  "GET /api/me": "signed_in",
  "PATCH /api/account": "signed_in",
  "POST /api/account/email": "signed_in",
  "POST /api/account/password": "signed_in",
  "GET /api/account/sessions": "signed_in",
  "DELETE /api/account/sessions": "signed_in",
  "DELETE /api/account/sessions/:id": "signed_in",
  "PUT /api/account/avatar": "signed_in",
  "DELETE /api/account/avatar": "signed_in",
  // Any signed-in user; a project's also checks the project (avatars/routes.ts).
  "GET /api/avatars/instance/:file": "signed_in",
  "GET /api/avatars/users/:userId/:file": "signed_in",
  "GET /api/avatars/projects/:projectId/:file": "signed_in",
  "GET /api/notifications": "signed_in",
  "GET /api/notifications/unread-count": "signed_in",
  "PATCH /api/notifications/:notificationId": "signed_in",
  "POST /api/notifications/read-all": "signed_in",
  "GET /api/settings": "permission:settings",
  "PATCH /api/settings": "permission:settings",
  "GET /api/settings/location-data": "permission:settings",
  "PUT /api/settings/avatar": "permission:settings",
  "DELETE /api/settings/avatar": "permission:settings",
  "GET /api/settings/storage": "permission:projects",
  "PATCH /api/settings/storage": "permission:channels",
  "GET /api/settings/ai-models": "permission:projects",
  "PUT /api/settings/ai-models/price": "permission:projects",
  "PUT /api/settings/ai-models/price-as": "permission:projects",
  "POST /api/settings/ai-models/reset": "permission:projects",
  "GET /api/settings/backups": "permission:settings",
  "PATCH /api/settings/backups": "permission:settings",
  "POST /api/settings/backups/test-connection": "permission:settings",
  "POST /api/settings/backups/run": "permission:settings",
  "POST /api/settings/backups/test-restore": "permission:settings",
  "GET /api/settings/backups/list": "permission:settings",
  "POST /api/settings/backups/key": "permission:settings",
  "POST /api/settings/backups/key/file": "permission:settings",
  "POST /api/settings/backups/key/saved": "permission:settings",
  "POST /api/settings/backups/key/replace": "permission:settings",
  "GET /api/projects": "signed_in",
  // The user's own stars; starring checks the project through checkProjectAccess.
  "GET /api/starred-projects": "signed_in",
  "PUT /api/starred-projects/:projectId": "signed_in",
  "DELETE /api/starred-projects/:projectId": "signed_in",
  "GET /api/members": "permission:members",
  "PATCH /api/members/:userId": "permission:members",
  "DELETE /api/members/:userId": "permission:members",
  "POST /api/members/:userId/reset-link": "permission:members",
  "POST /api/members/:userId/ownership": "permission:ownership",
  "POST /api/invitations": "permission:members",
  "POST /api/invitations/:invitationId/link": "permission:members",
  "DELETE /api/invitations/:invitationId": "permission:members",
  "POST /api/projects": "permission:projects",
  "GET /api/client-address": "permission:projects",
  "GET /api/channels": "permission:channels",
  "POST /api/channels": "permission:channels",
  "GET /api/channels/:channelId": "permission:channels",
  "PATCH /api/channels/:channelId": "permission:channels",
  "DELETE /api/channels/:channelId": "permission:channels",
  "GET /api/channels/:channelId/secret": "permission:channels",
  "POST /api/channels/:channelId/secret": "permission:channels",
  "POST /api/channels/:channelId/test": "permission:channels",
  "POST /api/channels/email-test": "permission:channels",
  "GET /api/channels/:channelId/deliveries": "permission:channels",

  "GET /api/projects/:id": "project",
  "PATCH /api/projects/:id": "project:permission:projects",
  "DELETE /api/projects/:id": "project:permission:projects",
  "POST /api/projects/:id/public-key": "project:permission:projects",
  "POST /api/projects/:id/secret-key": "project:permission:projects",
  "PUT /api/projects/:id/avatar": "project:permission:projects",
  "DELETE /api/projects/:id/avatar": "project:permission:projects",
  "GET /api/projects/:id/replays": "replays:view",
  "DELETE /api/projects/:id/replays": "project:permission:projects",
  "POST /api/projects/:id/spam-visits/preview": "project:permission:projects",
  "POST /api/projects/:id/spam-visits/delete": "project:permission:projects",

  "GET /api/projects/:id/analytics": "web_analytics:view",
  "GET /api/projects/:id/analytics/list": "web_analytics:view",
  "GET /api/projects/:id/speed": "web_analytics:view",
  "GET /api/projects/:id/heatmaps": "web_analytics:view",
  "GET /api/projects/:id/heatmaps/pages": "web_analytics:view",
  "POST /api/projects/:id/heatmaps/overlay-link": "web_analytics:view",
  // An overlay session token in place of the cookie, checked by the same rules.
  "GET /api/heatmap-overlay/:projectId/heatmap": "overlay:web_analytics:view",

  "GET /api/projects/:id/events": "product_analytics:view",
  "GET /api/projects/:id/events/:name": "product_analytics:view",
  "GET /api/projects/:id/funnel": "product_analytics:view",
  "GET /api/projects/:id/retention": "product_analytics:view",
  "GET /api/projects/:id/goals": "product_analytics:view",
  "POST /api/projects/:id/goals": "product_analytics:manage",
  "DELETE /api/projects/:id/goals/:goalId": "product_analytics:manage",
  "GET /api/projects/:id/funnels": "product_analytics:view",
  "POST /api/projects/:id/funnels": "product_analytics:manage",
  "PUT /api/projects/:id/funnels/:funnelId": "product_analytics:manage",
  "DELETE /api/projects/:id/funnels/:funnelId": "product_analytics:manage",

  "GET /api/projects/:id/errors": "errors:view",
  "GET /api/projects/:id/errors/:fingerprint": "errors:view",
  "PATCH /api/projects/:id/errors/:fingerprint": "errors:manage",
  "PUT /api/projects/:id/errors/:fingerprint/assignee": "errors:manage",
  "GET /api/projects/:id/error-assignees": "errors:manage",
  "GET /api/projects/:id/source-maps": "errors:view",
  "GET /api/projects/:id/source-maps/files": "errors:view",
  "DELETE /api/projects/:id/source-maps": "errors:manage",

  "GET /api/projects/:id/replays/list": "replays:view",
  "GET /api/projects/:id/replays/:replayId": "replays:view",
  "GET /api/projects/:id/replays/:replayId/timeline": "replays:view",
  "GET /api/projects/:id/replays/:replayId/player": "replays:view",

  "GET /api/projects/:id/users": "users:view",
  "GET /api/projects/:id/users/:userId": "users:view",

  "GET /api/projects/:id/traces": "monitoring:view",
  "GET /api/projects/:id/traces/chart": "monitoring:view",
  "GET /api/projects/:id/traces/:traceId": "monitoring:view",
  "GET /api/projects/:id/traces/:traceId/spans/:spanId": "monitoring:view",
  "GET /api/projects/:id/logs": "monitoring:view",
  "GET /api/projects/:id/logs/volume": "monitoring:view",
  "GET /api/projects/:id/logs/live": "monitoring:view",
  "GET /api/projects/:id/logs/:logId": "monitoring:view",
  "GET /api/projects/:id/metrics": "monitoring:view",
  "GET /api/projects/:id/metrics/chart": "monitoring:view",
  "GET /api/projects/:id/metrics/sparkline": "monitoring:view",
  "GET /api/projects/:id/services": "monitoring:view",
  "GET /api/projects/:id/services/chart": "monitoring:view",
  "GET /api/projects/:id/services/trend": "monitoring:view",
  "GET /api/projects/:id/services/routes": "monitoring:view",
  "GET /api/projects/:id/databases": "monitoring:view",
  "GET /api/projects/:id/databases/trend": "monitoring:view",
  "GET /api/projects/:id/databases/shapes/:shapeId": "monitoring:view",
  "GET /api/projects/:id/hosts": "monitoring:view",
  "GET /api/projects/:id/hosts/charts": "monitoring:view",
  "GET /api/projects/:id/ai": "monitoring:view",
  "GET /api/projects/:id/ai/chart": "monitoring:view",
  "GET /api/projects/:id/ai/calls": "monitoring:view",

  "GET /api/projects/:id/checks": "uptime_alerts:view",
  "POST /api/projects/:id/checks": "uptime_alerts:manage",
  "GET /api/projects/:id/checks/:checkId": "uptime_alerts:view",
  "PATCH /api/projects/:id/checks/:checkId": "uptime_alerts:manage",
  "DELETE /api/projects/:id/checks/:checkId": "uptime_alerts:manage",
  "GET /api/projects/:id/checks/:checkId/results": "uptime_alerts:view",
  "GET /api/projects/:id/checks/:checkId/incidents": "uptime_alerts:view",
  "GET /api/projects/:id/alert-rules": "uptime_alerts:view",
  "POST /api/projects/:id/alert-rules": "uptime_alerts:manage",
  "GET /api/projects/:id/alert-rules/:ruleId": "uptime_alerts:view",
  "PATCH /api/projects/:id/alert-rules/:ruleId": "uptime_alerts:manage",
  "DELETE /api/projects/:id/alert-rules/:ruleId": "uptime_alerts:manage",
  "GET /api/projects/:id/alert-rules/:ruleId/history": "uptime_alerts:view",
  "GET /api/projects/:id/alerts": "uptime_alerts:view",
  "GET /api/projects/:id/alerts/firing": "uptime_alerts:view",
  "GET /api/projects/:id/alert-channels": "uptime_alerts:view",

  "GET /api/projects/:id/overview/layout": "project",
  "PUT /api/projects/:id/overview/layout": "project",
  "DELETE /api/projects/:id/overview/layout": "project",
  "GET /api/projects/:id/overview/attention": "uptime_alerts:view",
  "GET /api/projects/:id/overview/errors": "errors:view",
  "GET /api/projects/:id/overview/uptime": "uptime_alerts:view",
  "GET /api/projects/:id/overview/services": "monitoring:view",
  "GET /api/projects/:id/overview/speed": "web_analytics:view",
  "GET /api/projects/:id/overview/main-goal": "product_analytics:view",
  "GET /api/projects/:id/overview/traffic": "web_analytics:view",
  "GET /api/projects/:id/overview/goals": "product_analytics:view",
  "GET /api/projects/:id/overview/users": "product_analytics:view",
  "GET /api/projects/:id/overview/sources": "web_analytics:view",
};

test("every dashboard route declares the area or permission it needs; public routes are listed", async () => {
  const routes = await registeredRoutes();
  const undeclared = [...routes]
    .filter(([key, declarations]) => !PUBLIC_ROUTES.has(key) && declarations.length === 0)
    .map(([key]) => key);
  expect(undeclared).toEqual([]);

  // Public routes declare nothing; the others one each, of the right
  // scope: a project's routes need the project.
  const scopes = [...routes].map(([key, declarations]) => ({
    key,
    scopes: declarations.map((declaration) => declaration.scope),
  }));
  expect(scopes).toEqual(
    [...routes.keys()].map((key) => ({
      key,
      scopes: PUBLIC_ROUTES.has(key)
        ? []
        : [
            key.includes("/api/projects/:id")
              ? "project"
              : key.includes("/api/heatmap-overlay/")
                ? "overlay"
                : "instance",
          ],
    })),
  );

  // The map in docs/access.md, route by route.
  const declared = Object.fromEntries(
    [...routes]
      .filter(([key]) => !PUBLIC_ROUTES.has(key))
      .map(([key, declarations]) => [key, declarations.map(describeDeclaration).join(", ")]),
  );
  expect(declared).toEqual(EXPECTED);
  // And every public route exists, so the list stays true.
  expect([...PUBLIC_ROUTES].filter((key) => !routes.has(key))).toEqual([]);
});

test("the per-area tests have a request for every project route", async () => {
  const routes = await registeredRoutes();
  const projectRoutes = [...routes.keys()].filter((key) => key.includes("/api/projects/:id"));
  expect(PROJECT_REQUESTS.map(({ method, route }) => routeKey(method, route)).toSorted()).toEqual(
    projectRoutes.toSorted(),
  );
});
