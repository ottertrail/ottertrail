import { describe, expect, test } from "vite-plus/test";

import { docsFor, DOCS_URL, SCREEN_DOCS } from "../src/lib/docs.ts";

/**
 * Every screen's Docs link (lib/docs.ts), listed in full: a screen added
 * to the dashboard without an entry here shows no link, by choice. Each
 * path was checked on the docs site's build and on the live site.
 */
const EXPECTED: Record<string, [topic: string, path: string]> = {
  "/projects": ["Projects", "/introduction/instances-and-projects/#projects"],
  "/settings/members": ["Members", "/team/members-and-roles/"],
  "/notifications": ["Notifications", "/introduction/notifications/"],
  "/account": ["Account settings", "/team/account-settings/#profile"],
  "/account?tab=password": ["Password settings", "/team/account-settings/#password"],
  "/account?tab=sessions": ["Sessions", "/team/account-settings/#sessions"],
  "/account?tab=appearance": ["Appearance settings", "/team/account-settings/#appearance"],
  "/settings": ["Instance settings", "/introduction/instances-and-projects/#the-instance"],
  "/settings?tab=location-data": [
    "Location data settings",
    "/self-hosting/location-data/#the-location-data-tab",
  ],
  "/settings?tab=storage": ["Storage settings", "/self-hosting/storage/"],
  "/settings?tab=backups": ["Backups settings", "/self-hosting/backups/#the-backups-tab"],
  "/settings?tab=server-log": ["Server log", "/self-hosting/server-log/"],
  "/settings?tab=ai-models": ["AI models settings", "/monitoring/ai-usage/#prices"],
  "/settings?tab=channels": ["Notification channels settings", "/uptime-and-alerts/channels/"],
  "/projects/$projectId/overview": ["Overview", "/introduction/overview/"],
  "/projects/$projectId/web-analytics": ["Web analytics", "/web-analytics/reports/"],
  "/projects/$projectId/web-analytics/now": ["Right now", "/web-analytics/reports/#right-now"],
  "/projects/$projectId/speed": ["Speed", "/web-analytics/web-vitals/"],
  "/projects/$projectId/heatmaps": ["Heatmaps", "/web-analytics/heatmaps/"],
  "/projects/$projectId/users": ["Users", "/users/the-users-page/"],
  "/projects/$projectId/errors": ["Errors", "/errors/resolving/"],
  "/projects/$projectId/replays": ["Replays", "/session-replay/error-replays/"],
  "/projects/$projectId/traces": ["Traces", "/monitoring/traces/"],
  "/projects/$projectId/logs": ["Logs", "/monitoring/logs/"],
  "/projects/$projectId/metrics": ["Metrics", "/monitoring/metrics/"],
  "/projects/$projectId/services": ["Services", "/monitoring/services/"],
  "/projects/$projectId/databases": ["Databases", "/monitoring/databases/"],
  "/projects/$projectId/ai": ["AI", "/monitoring/ai-usage/"],
  "/projects/$projectId/ai/calls": ["AI calls", "/monitoring/ai-usage/#the-calls-list"],
  "/projects/$projectId/hosts": ["Hosts", "/monitoring/hosts/"],
  "/projects/$projectId/uptime": ["Uptime", "/uptime-and-alerts/checks/"],
  "/projects/$projectId/alerts": ["Alerts", "/uptime-and-alerts/alert-rules/"],
  "/projects/$projectId/product/events": ["Events", "/product-analytics/custom-events/"],
  "/projects/$projectId/product/funnel": ["Funnel", "/product-analytics/funnels/"],
  "/projects/$projectId/product/retention": ["Retention", "/product-analytics/retention/"],
  "/projects/$projectId/product/active-users": ["Active users", "/product-analytics/active-users/"],
  "/projects/$projectId/users/$userId": ["User", "/users/the-users-page/#a-users-page"],
  "/projects/$projectId/errors/$fingerprint": ["Error", "/errors/resolving/#the-groups-page"],
  "/projects/$projectId/replays/$replayId": ["Replay", "/session-replay/error-replays/#the-player"],
  "/projects/$projectId/traces/$traceId": ["Trace", "/monitoring/traces/#a-trace"],
  "/projects/$projectId/ai/calls/$callId": ["AI call", "/monitoring/ai-usage/#the-calls-list"],
  "/projects/$projectId/ai/conversations/$conversationId": [
    "Conversation",
    "/monitoring/ai-usage/#conversations",
  ],
  "/projects/$projectId/metrics/$name": ["Metric", "/monitoring/metrics/#a-metrics-charts"],
  "/projects/$projectId/services/$service": [
    "Service",
    "/monitoring/services/#a-services-or-a-routes-page",
  ],
  "/projects/$projectId/databases/$shapeId": [
    "Query shape",
    "/monitoring/databases/#a-query-shapes-page",
  ],
  "/projects/$projectId/hosts/$host": ["Host", "/monitoring/hosts/"],
  "/projects/$projectId/uptime/$checkId": ["Check", "/uptime-and-alerts/checks/#a-check"],
  "/projects/$projectId/alerts/$ruleId": ["Rule", "/uptime-and-alerts/alert-rules/#a-rule"],
  "/projects/$projectId/product/events/$name": [
    "Event",
    "/product-analytics/custom-events/#one-event-and-its-properties",
  ],
  "/projects/$projectId/settings": ["Install settings", "/get-started/add-the-tracker/"],
  "/projects/$projectId/settings?tab=activity": [
    "Activity settings",
    "/introduction/project-settings/#activity",
  ],
  "/projects/$projectId/settings?tab=general": [
    "General settings",
    "/introduction/project-settings/#general",
  ],
  "/projects/$projectId/settings?tab=server": [
    "Your server settings",
    "/introduction/project-settings/",
  ],
  "/projects/$projectId/settings?tab=spam": [
    "Spam and bots settings",
    "/web-analytics/spam-and-bots/#the-spam-and-bots-tab",
  ],
  "/projects/$projectId/settings?tab=source-maps": ["Source maps settings", "/errors/source-maps/"],
  "/projects/$projectId/settings?tab=replay": [
    "Session replay settings",
    "/session-replay/turning-it-on/",
  ],
  "/projects/$projectId/settings?tab=danger": [
    "Danger zone settings",
    "/introduction/project-settings/#danger-zone",
  ],
};

describe("SCREEN_DOCS", () => {
  test("lists exactly the screens with a docs page, and each one's page", () => {
    const listed: Record<string, [string, string]> = {};
    for (const [route, screen] of Object.entries(SCREEN_DOCS)) {
      if (screen === undefined) continue;
      listed[route] = [screen.topic, screen.path];
      for (const [tab, page] of Object.entries(screen.tabs ?? {})) {
        listed[`${route}?tab=${tab}`] = [page.topic, page.path];
      }
    }
    expect(listed).toEqual(EXPECTED);
  });

  test("every path is a page of the docs site, ending in a slash before any anchor", () => {
    for (const [, path] of Object.values(EXPECTED)) {
      expect(path).toMatch(/^\/[a-z0-9-]+(\/[a-z0-9-]+)*\/(#[a-z0-9-]+)?$/);
    }
  });
});

describe("docsFor", () => {
  test("gives the docs site's address for a screen", () => {
    expect(docsFor("/projects/$projectId/web-analytics", undefined)).toEqual({
      topic: "Web analytics",
      path: "/web-analytics/reports/",
      url: `${DOCS_URL}/web-analytics/reports/`,
    });
  });

  test("gives a settings tab its own page, and a tab without one the screen's", () => {
    expect(docsFor("/projects/$projectId/settings", "spam")?.url).toBe(
      `${DOCS_URL}/web-analytics/spam-and-bots/#the-spam-and-bots-tab`,
    );
    expect(docsFor("/settings", "general")?.url).toBe(
      `${DOCS_URL}/introduction/instances-and-projects/#the-instance`,
    );
    expect(docsFor("/settings", "no-such-tab")?.topic).toBe("Instance settings");
  });

  test("gives nothing for a screen without a page", () => {
    expect(docsFor("/sign-in", undefined)).toBeUndefined();
    expect(docsFor("/projects/$projectId/", undefined)).toBeUndefined();
    expect(docsFor(undefined, undefined)).toBeUndefined();
  });
});
