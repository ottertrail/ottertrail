/**
 * One request for every route on one project, valid enough to pass each
 * route's schema, so that the access check is what answers. Keyed by the
 * route as Fastify registers it: tests/access-routes.test.ts fails when a
 * project route is missing here.
 */
export interface ProjectRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** The route as registered, such as "/api/projects/:id/goals/:goalId". */
  route: string;
  url: (projectId: string) => string;
  payload?: object;
}

const SOME_ID = "00000000-0000-4000-8000-000000000000";
const FINGERPRINT = "1-0123456789abcdef0123";
const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const SOME_FUNNEL = {
  name: "Some funnel",
  steps: [
    { type: "page", path: "/" },
    { type: "event", name: "signup" },
  ],
  count: "visitors",
  window: 3600,
  updatedAt: "2026-11-17T12:00:00.000Z",
};
const FUNNEL_STEPS = encodeURIComponent(
  JSON.stringify([
    { type: "page", path: "/" },
    { type: "event", name: "signup" },
  ]),
);

function request(
  method: ProjectRequest["method"],
  route: string,
  path: string,
  payload?: object,
): ProjectRequest {
  return {
    method,
    route: `/api/projects/:id${route}`,
    url: (id) => `/api/projects/${id}${path}`,
    ...(payload === undefined ? {} : { payload }),
  };
}

const OVERVIEW_WIDGETS = [
  "attention",
  "errors",
  "uptime",
  "services",
  "ai-cost",
  "speed",
  "main-goal",
  "traffic",
  "goals",
  "users",
  "sources",
];

export const PROJECT_REQUESTS: readonly ProjectRequest[] = [
  request("GET", "/overview/layout", "/overview/layout"),
  request("PUT", "/overview/layout", "/overview/layout", { order: ["traffic"], hidden: [] }),
  request("DELETE", "/overview/layout", "/overview/layout"),
  ...OVERVIEW_WIDGETS.map((widget) =>
    request("GET", `/overview/${widget}`, `/overview/${widget}?period=7d`),
  ),
  request("GET", "", ""),
  request("PATCH", "", "", { name: "Renamed" }),
  request("DELETE", "", "", { confirmName: "Some site" }),
  request("POST", "/public-key", "/public-key"),
  request("POST", "/secret-key", "/secret-key"),
  request("PUT", "/avatar", "/avatar"),
  request("DELETE", "/avatar", "/avatar"),
  request("POST", "/spam-visits/preview", "/spam-visits/preview", {
    from: "2026-11-15",
    to: "2026-11-15",
  }),
  request("POST", "/spam-visits/delete", "/spam-visits/delete", {
    from: "2026-11-15",
    to: "2026-11-15",
    confirmVisits: 1,
  }),
  request("GET", "/analytics", "/analytics?period=7d"),
  request("GET", "/analytics/list", "/analytics/list?report=pages&period=7d"),
  request("GET", "/speed", "/speed?period=7d"),
  request("GET", "/heatmaps", "/heatmaps?period=7d&path=%2Fpricing"),
  request("GET", "/heatmaps/pages", "/heatmaps/pages?period=7d"),
  request("POST", "/heatmaps/overlay-link", "/heatmaps/overlay-link"),
  request("GET", "/heatmaps/snapshots", "/heatmaps/snapshots?path=%2Fpricing"),
  request("GET", "/heatmaps/snapshots/:device", "/heatmaps/snapshots/desktop?path=%2Fpricing"),
  request(
    "GET",
    "/heatmaps/snapshots/:device/player",
    "/heatmaps/snapshots/desktop/player?path=%2Fpricing&period=7d",
  ),
  request(
    "GET",
    "/heatmaps/snapshots/:device/heatmap",
    "/heatmaps/snapshots/desktop/heatmap?path=%2Fpricing&period=7d",
  ),
  request("DELETE", "/heatmaps/snapshots/:device", "/heatmaps/snapshots/desktop?path=%2Fpricing"),
  request("GET", "/users", "/users"),
  request("GET", "/users/:userId", "/users/user-42"),
  request("GET", "/events", "/events?period=7d"),
  request("GET", "/events/:name", "/events/signup?period=7d"),
  request("GET", "/funnel", `/funnel?period=7d&steps=${FUNNEL_STEPS}`),
  request("GET", "/retention", "/retention?period=30d"),
  request("GET", "/goals", "/goals"),
  request("POST", "/goals", "/goals", { name: "A goal", step: { type: "page", path: "/" } }),
  request("DELETE", "/goals/:goalId", `/goals/${SOME_ID}`),
  request("GET", "/funnels", "/funnels"),
  request("POST", "/funnels", "/funnels", SOME_FUNNEL),
  request("PUT", "/funnels/:funnelId", `/funnels/${SOME_ID}`, SOME_FUNNEL),
  request("DELETE", "/funnels/:funnelId", `/funnels/${SOME_ID}`),
  request("GET", "/errors", "/errors?period=7d"),
  request("GET", "/errors/:fingerprint", `/errors/${FINGERPRINT}?period=7d`),
  request("PATCH", "/errors/:fingerprint", `/errors/${FINGERPRINT}`, { status: "resolved" }),
  request("PUT", "/errors/:fingerprint/assignee", `/errors/${FINGERPRINT}/assignee`, {
    assignee: null,
  }),
  request("GET", "/error-assignees", "/error-assignees"),
  request("GET", "/source-maps", "/source-maps"),
  request("GET", "/source-maps/files", "/source-maps/files?release=1.4.2"),
  request("DELETE", "/source-maps", "/source-maps?release=1.4.2"),
  request("GET", "/replays", "/replays"),
  request("GET", "/replays/list", "/replays/list?period=7d"),
  request("GET", "/replays/:replayId", `/replays/${SOME_ID}`),
  request("GET", "/replays/:replayId/timeline", `/replays/${SOME_ID}/timeline`),
  request("GET", "/replays/:replayId/player", `/replays/${SOME_ID}/player`),
  request("DELETE", "/replays", "/replays"),
  request("GET", "/traces", "/traces?period=7d"),
  request("GET", "/traces/chart", "/traces/chart?period=7d"),
  request("GET", "/traces/:traceId", `/traces/${TRACE_ID}`),
  request(
    "GET",
    "/traces/:traceId/spans/:spanId",
    `/traces/${TRACE_ID}/spans/00f067aa0ba902b7?start=1795003200000000000`,
  ),
  request("GET", "/logs", "/logs?period=7d"),
  request("GET", "/logs/volume", "/logs/volume?period=7d"),
  request("GET", "/logs/live", "/logs/live"),
  request("GET", "/logs/:logId", `/logs/${"0".repeat(32)}?time=1795003200000000000`),
  request("GET", "/metrics", "/metrics?period=7d"),
  request("GET", "/metrics/chart", "/metrics/chart?period=7d&name=http.requests&kind=counter"),
  request(
    "GET",
    "/metrics/sparkline",
    "/metrics/sparkline?period=7d&name=http.requests&kind=counter",
  ),
  request("GET", "/services", "/services?period=7d"),
  request("GET", "/services/trend", "/services/trend?period=7d"),
  request("GET", "/services/chart", "/services/chart?period=7d&service=web"),
  request("GET", "/services/routes", "/services/routes"),
  request("GET", "/databases", "/databases?period=7d"),
  request("GET", "/databases/trend", "/databases/trend?period=7d"),
  request("GET", "/databases/shapes/:shapeId", "/databases/shapes/42?period=7d"),
  request("GET", "/hosts", "/hosts?period=7d"),
  request("GET", "/hosts/charts", "/hosts/charts?period=7d&host=web-1"),
  request("GET", "/ai", "/ai?period=7d"),
  request("GET", "/ai/chart", "/ai/chart?period=7d&split=feature"),
  request("GET", "/ai/calls", "/ai/calls?period=7d"),
  request("GET", "/ai/call-list", "/ai/call-list?period=7d"),
  request("GET", "/ai/calls/:callId", `/ai/calls/${SOME_ID}`),
  request("GET", "/ai/conversations", "/ai/conversations?period=7d"),
  request("GET", "/ai/conversations/:conversationId", "/ai/conversations/conv-1?period=7d"),
  request("GET", "/checks", "/checks"),
  request("POST", "/checks", "/checks", { url: "https://example.com/health" }),
  request("GET", "/checks/:checkId", `/checks/${SOME_ID}`),
  request("PATCH", "/checks/:checkId", `/checks/${SOME_ID}`, { paused: true }),
  request("DELETE", "/checks/:checkId", `/checks/${SOME_ID}`),
  request("GET", "/checks/:checkId/results", `/checks/${SOME_ID}/results?period=7d`),
  request("GET", "/checks/:checkId/incidents", `/checks/${SOME_ID}/incidents?period=7d`),
  request("GET", "/alert-rules", "/alert-rules"),
  request("POST", "/alert-rules", "/alert-rules", { kind: "check_down", channelIds: [SOME_ID] }),
  request("GET", "/alert-rules/:ruleId", `/alert-rules/${SOME_ID}`),
  request("PATCH", "/alert-rules/:ruleId", `/alert-rules/${SOME_ID}`, { enabled: false }),
  request("DELETE", "/alert-rules/:ruleId", `/alert-rules/${SOME_ID}`),
  request("GET", "/alert-rules/:ruleId/history", `/alert-rules/${SOME_ID}/history`),
  request("GET", "/alerts", "/alerts"),
  request("GET", "/alerts/firing", "/alerts/firing"),
  request("GET", "/alert-channels", "/alert-channels"),
];

/** The key a route goes by in the tables: "GET /api/projects/:id/goals". */
export const routeKey = (method: string, route: string) => `${method} ${route}`;
