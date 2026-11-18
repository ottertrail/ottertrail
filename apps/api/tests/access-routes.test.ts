import { expect, test } from "vite-plus/test";

import { PROJECT_REQUESTS, routeKey } from "./helpers/project-routes.ts";
import { describeDeclaration, registeredRoutes } from "./helpers/routes.ts";

/**
 * The routes anyone may call: health, collection with a project's key,
 * the scripts and the dashboard's files, sign-in, and setup. Every other
 * route must declare what it needs (docs/access.md).
 */
const PUBLIC_ROUTES = new Set([
  "GET /api/health",
  // Collection, with a project's public or secret key.
  "POST /api/events",
  "POST /api/server-events",
  "POST /api/replays",
  "PUT /api/source-maps",
  "POST /v1/traces",
  "POST /v1/logs",
  "POST /v1/metrics",
  // Scripts, and the dashboard's own files.
  "GET /t.js",
  "GET /v.js",
  "GET /r.js",
  "GET /replay-player.js",
  "GET /*",
  // Sign-in (Better Auth) and setup.
  "GET /api/auth/*",
  "POST /api/auth/*",
  "GET /api/setup",
  "POST /api/setup",
]);

/** What each dashboard route declares, as text: "errors:manage", "permission:channels" … */
const EXPECTED: Record<string, string> = {
  "GET /api/me": "signed_in",
  "GET /api/settings": "permission:settings",
  "PATCH /api/settings": "permission:settings",
  "GET /api/projects": "signed_in",
  "POST /api/projects": "permission:projects",
  "GET /api/channels": "permission:channels",
  "POST /api/channels": "permission:channels",
  "GET /api/channels/:channelId": "permission:channels",
  "PATCH /api/channels/:channelId": "permission:channels",
  "DELETE /api/channels/:channelId": "permission:channels",
  "GET /api/channels/:channelId/secret": "permission:channels",
  "POST /api/channels/:channelId/secret": "permission:channels",
  "POST /api/channels/:channelId/test": "permission:channels",
  "GET /api/channels/:channelId/deliveries": "permission:channels",

  "GET /api/projects/:id": "project",
  "PATCH /api/projects/:id": "project:permission:projects",
  "DELETE /api/projects/:id": "project:permission:projects",
  "POST /api/projects/:id/public-key": "project:permission:projects",
  "POST /api/projects/:id/secret-key": "project:permission:projects",
  "GET /api/projects/:id/replays": "replays:view",
  "DELETE /api/projects/:id/replays": "project:permission:projects",

  "GET /api/projects/:id/analytics": "web_analytics:view",
  "GET /api/projects/:id/analytics/list": "web_analytics:view",
  "GET /api/projects/:id/speed": "web_analytics:view",

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
  "GET /api/projects/:id/traces/:traceId": "monitoring:view",
  "GET /api/projects/:id/traces/:traceId/spans/:spanId": "monitoring:view",
  "GET /api/projects/:id/logs": "monitoring:view",
  "GET /api/projects/:id/logs/:logId": "monitoring:view",
  "GET /api/projects/:id/metrics": "monitoring:view",
  "GET /api/projects/:id/metrics/chart": "monitoring:view",
  "GET /api/projects/:id/services": "monitoring:view",
  "GET /api/projects/:id/services/chart": "monitoring:view",
  "GET /api/projects/:id/services/routes": "monitoring:view",
  "GET /api/projects/:id/databases": "monitoring:view",
  "GET /api/projects/:id/databases/shapes/:shapeId": "monitoring:view",
  "GET /api/projects/:id/hosts": "monitoring:view",
  "GET /api/projects/:id/hosts/charts": "monitoring:view",

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
        : [key.includes("/api/projects/:id") ? "project" : "instance"],
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
