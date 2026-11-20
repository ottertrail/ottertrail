import type { RegisteredRouter } from "@tanstack/react-router";

/** The docs site: the one place its address is kept. */
export const DOCS_URL = "https://docs.ottertrail.app";

/** A screen's page on the docs site, and what the header's Docs link calls it. */
export interface DocsPage {
  /**
   * Names the link for screen readers, "<topic> docs (opens in a new tab)": the
   * page's title, or a settings tab's label and "settings".
   */
  topic: string;
  /** The page's path on the docs site, with a heading's anchor where one fits much better. */
  path: string;
}

/** A docs page with its full address, as the header links to it. */
export type DocsLinkTarget = DocsPage & { url: string };

/** A screen's docs: its page, and a better page for some of its settings tabs (`?tab=`). */
interface ScreenDocs extends DocsPage {
  tabs?: Record<string, DocsPage>;
}

type RoutePath = keyof RegisteredRouter["routesByPath"];

/**
 * The header's Docs link on each screen, by the route's path. A screen left
 * out has no page that explains it, and shows no link: no entry is better
 * than a page that does not fit. `tests/docs-links.test.ts` lists the map,
 * and every path in it was checked on the docs site.
 */
export const SCREEN_DOCS: Partial<Record<RoutePath, ScreenDocs>> = {
  // The workspace.
  "/projects": { topic: "Projects", path: "/introduction/instances-and-projects/#projects" },
  "/settings/members": { topic: "Members", path: "/team/members-and-roles/" },
  // The first tab the user may see depends on their role (General, or Storage
  // for an admin): the page that lists all four tabs.
  "/settings": {
    topic: "Instance settings",
    path: "/introduction/instances-and-projects/#the-instance",
    tabs: {
      "location-data": {
        topic: "Location data settings",
        path: "/self-hosting/location-data/#the-location-data-tab",
      },
      storage: { topic: "Storage settings", path: "/self-hosting/storage/" },
      channels: { topic: "Notification channels settings", path: "/uptime-and-alerts/channels/" },
    },
  },
  // A project's reports and lists.
  "/projects/$projectId/overview": { topic: "Overview", path: "/introduction/overview/" },
  "/projects/$projectId/web-analytics": { topic: "Web analytics", path: "/web-analytics/reports/" },
  "/projects/$projectId/speed": { topic: "Speed", path: "/web-analytics/web-vitals/" },
  "/projects/$projectId/heatmaps": { topic: "Heatmaps", path: "/web-analytics/heatmaps/" },
  "/projects/$projectId/users": { topic: "Users", path: "/users/the-users-page/" },
  "/projects/$projectId/errors": { topic: "Errors", path: "/errors/resolving/" },
  "/projects/$projectId/replays": { topic: "Replays", path: "/session-replay/error-replays/" },
  "/projects/$projectId/traces": { topic: "Traces", path: "/monitoring/traces/" },
  "/projects/$projectId/logs": { topic: "Logs", path: "/monitoring/logs/" },
  "/projects/$projectId/metrics": { topic: "Metrics", path: "/monitoring/metrics/" },
  "/projects/$projectId/services": { topic: "Services", path: "/monitoring/services/" },
  "/projects/$projectId/databases": { topic: "Databases", path: "/monitoring/databases/" },
  "/projects/$projectId/hosts": { topic: "Hosts", path: "/monitoring/hosts/" },
  "/projects/$projectId/uptime": { topic: "Uptime", path: "/uptime-and-alerts/checks/" },
  "/projects/$projectId/alerts": { topic: "Alerts", path: "/uptime-and-alerts/alert-rules/" },
  "/projects/$projectId/product/events": {
    topic: "Events",
    path: "/product-analytics/custom-events/",
  },
  "/projects/$projectId/product/funnel": { topic: "Funnel", path: "/product-analytics/funnels/" },
  "/projects/$projectId/product/retention": {
    topic: "Retention",
    path: "/product-analytics/retention/",
  },
  // Detail pages, where a section explains them better than their list's page.
  "/projects/$projectId/users/$userId": {
    topic: "User",
    path: "/users/the-users-page/#a-users-page",
  },
  "/projects/$projectId/errors/$fingerprint": {
    topic: "Error",
    path: "/errors/resolving/#the-groups-page",
  },
  "/projects/$projectId/replays/$replayId": {
    topic: "Replay",
    path: "/session-replay/error-replays/#the-player",
  },
  "/projects/$projectId/traces/$traceId": { topic: "Trace", path: "/monitoring/traces/#a-trace" },
  "/projects/$projectId/metrics/$name": {
    topic: "Metric",
    path: "/monitoring/metrics/#a-metrics-charts",
  },
  "/projects/$projectId/services/$service": {
    topic: "Service",
    path: "/monitoring/services/#a-services-or-a-routes-page",
  },
  "/projects/$projectId/databases/$shapeId": {
    topic: "Query shape",
    path: "/monitoring/databases/#a-query-shapes-page",
  },
  "/projects/$projectId/hosts/$host": { topic: "Host", path: "/monitoring/hosts/" },
  "/projects/$projectId/uptime/$checkId": {
    topic: "Check",
    path: "/uptime-and-alerts/checks/#a-check",
  },
  "/projects/$projectId/alerts/$ruleId": {
    topic: "Rule",
    path: "/uptime-and-alerts/alert-rules/#a-rule",
  },
  "/projects/$projectId/product/events/$name": {
    topic: "Event",
    path: "/product-analytics/custom-events/#one-event-and-its-properties",
  },
  // Install is the first tab, shown without `?tab=`.
  "/projects/$projectId/settings": {
    topic: "Install settings",
    path: "/get-started/add-the-tracker/",
    tabs: {
      general: { topic: "General settings", path: "/introduction/project-settings/#general" },
      server: { topic: "Your server settings", path: "/introduction/project-settings/" },
      spam: {
        topic: "Spam and bots settings",
        path: "/web-analytics/spam-and-bots/#the-spam-and-bots-tab",
      },
      "source-maps": { topic: "Source maps settings", path: "/errors/source-maps/" },
      replay: { topic: "Session replay settings", path: "/session-replay/turning-it-on/" },
      danger: {
        topic: "Danger zone settings",
        path: "/introduction/project-settings/#danger-zone",
      },
    },
  },
};

/**
 * The docs page for a screen: the route's path and the settings tab in the
 * address. A tab without a page of its own gets the screen's.
 */
export function docsFor(
  routePath: RoutePath | undefined,
  tab: string | undefined,
): DocsLinkTarget | undefined {
  const screen = routePath === undefined ? undefined : SCREEN_DOCS[routePath];
  if (screen === undefined) {
    return undefined;
  }
  const page = (tab === undefined ? undefined : screen.tabs?.[tab]) ?? screen;
  return { topic: page.topic, path: page.path, url: `${DOCS_URL}${page.path}` };
}
