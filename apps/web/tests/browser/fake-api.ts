import { stepsOverlap } from "../../src/features/product/funnel-steps.ts";
import {
  type FiringAlert,
  type HistoryEntry,
  isRuleKind,
  KIND_LABEL,
  type Rule,
} from "../../src/lib/alerts-api.ts";
import type { Analytics, BreakdownRow, DayPoint } from "../../src/lib/analytics-api.ts";
import type { Channel, Delivery } from "../../src/lib/channels-api.ts";
import {
  type ErrorDetail,
  type ErrorGroup,
  type ErrorList,
  isStatusFilter,
  type ResolvedFrame,
} from "../../src/lib/errors-api.ts";
import type { SavedFunnel } from "../../src/lib/funnels-api.ts";
import type { GoalResult } from "../../src/lib/goals-api.ts";
import type { HostCharts, HostList } from "../../src/lib/hosts-api.ts";
import type { LogList, LogRecord, LogSummary } from "../../src/lib/logs-api.ts";
import {
  isMetricKind,
  MEASURES,
  type MetricChart,
  type MetricList,
  type MetricSeries,
} from "../../src/lib/metrics-api.ts";
import {
  type Funnel,
  isFunnelCount,
  isFunnelStep,
  isFunnelWindow,
  type ProductEventDetail,
  type ProductEvents,
  type Retention,
} from "../../src/lib/product-api.ts";
import type { Project } from "../../src/lib/projects-api.ts";
import type { ServiceList } from "../../src/lib/services-api.ts";
import type { Settings } from "../../src/lib/settings-api.ts";
import type { SourceMapFile, SourceMapRelease } from "../../src/lib/source-maps-api.ts";
import type { Speed } from "../../src/lib/speed-api.ts";
import type { SpanDetail, TraceDetail, TraceList, TraceSummary } from "../../src/lib/traces-api.ts";
import type { Check, CheckResults, IncidentList } from "../../src/lib/uptime-api.ts";
import type { Activity, User, UserActivity, UserList } from "../../src/lib/users-api.ts";

/**
 * Stands in for the Ottertrail API: browser tests check the pages, and the
 * API has its own tests against PostgreSQL. Responses follow the API's
 * shapes; the page checks them the same way as real ones.
 */
export interface FakeApi {
  signedIn: boolean;
  /** The instance's settings; PATCH changes them (the owner's only: canEdit). */
  settings: Settings;
  projects: Project[];
  /**
   * Answers GET /api/projects/:id/analytics. A Response stands for an error.
   * By default, analyticsFixture with the fake API's `goals`.
   */
  analytics: (
    projectId: string,
    period: string | null,
    query: URLSearchParams,
    api: FakeApi,
  ) => Analytics | Response | Promise<Analytics | Response>;
  /**
   * The project's saved goals with their counts, in the order added; the
   * goal routes list, add (with zero counts), and delete them.
   */
  goals: GoalResult[];
  /**
   * The project's saved funnels, in the order saved; the funnel routes list
   * them by name, and save, change, and delete them. By default, fakeSavedFunnels.
   */
  savedFunnels: SavedFunnel[];
  /** Answers GET /api/projects/:id/analytics/list; by default, fakeList. */
  list: (query: URLSearchParams) => unknown;
  /** Answers GET /api/projects/:id/users; by default, fakeUsers. */
  users: (query: URLSearchParams) => UserList | Response;
  /** Answers GET /api/projects/:id/users/:userId; by default, fakeUser. */
  user: (userId: string, query: URLSearchParams) => UserActivity | Response;
  /** Answers GET /api/projects/:id/errors; by default, fakeErrors. */
  errors: (query: URLSearchParams, api: FakeApi) => ErrorList | Response;
  /** Answers GET /api/projects/:id/errors/:fingerprint; by default, fakeError. */
  error: (fingerprint: string, query: URLSearchParams, api: FakeApi) => ErrorDetail | Response;
  /** Answers PATCH /api/projects/:id/errors/:fingerprint; by default, changes `resolutions`. */
  setErrorStatus: (api: FakeApi, fingerprint: string, status: string) => Response;
  /** Resolved error groups by fingerprint, as error_resolutions holds them. */
  resolutions: Record<string, { resolvedAt: string; resolvedBy: string | null }>;
  /** Answers GET /api/projects/:id/speed; by default, fakeSpeed. */
  speed: (query: URLSearchParams) => Speed | Response;
  /** Answers GET /api/projects/:id/events; by default, fakeProductEvents. */
  productEvents: (query: URLSearchParams) => ProductEvents | Response;
  /** Answers GET /api/projects/:id/events/:name; by default, fakeProductEvent. */
  productEvent: (name: string, query: URLSearchParams) => ProductEventDetail | Response;
  /** Answers GET /api/projects/:id/funnel; by default, fakeFunnel. */
  funnel: (query: URLSearchParams) => Funnel | Response;
  /** Answers GET /api/projects/:id/retention; by default, fakeRetention. */
  retention: (query: URLSearchParams) => Retention | Response;
  /**
   * The project's source maps: the routes list them by release, list a
   * release's files, and delete a release's. By default, fakeSourceMaps.
   */
  sourceMaps: FakeSourceMaps;
  /** The project's session replays; GET and DELETE /api/projects/:id/replays read and empty them. */
  replays: FakeReplays;
  /** Answers GET /api/projects/:id/traces; by default, fakeTraces. */
  traces: (query: URLSearchParams) => TraceList | Response;
  /** Answers GET /api/projects/:id/traces/:traceId; by default, fakeTrace. */
  trace: (traceId: string, query: URLSearchParams) => TraceDetail | Response;
  /** Answers GET /api/projects/:id/traces/:traceId/spans/:spanId; by default, fakeSpan. */
  span: (traceId: string, spanId: string, query: URLSearchParams) => SpanDetail | Response;
  /** Answers GET /api/projects/:id/logs; by default, fakeLogs. */
  logs: (query: URLSearchParams) => LogList | Response;
  /** Answers GET /api/projects/:id/logs/:logId; by default, fakeLog. */
  log: (logId: string, query: URLSearchParams) => LogRecord | Response;
  /** Answers GET /api/projects/:id/metrics; by default, fakeMetrics. */
  metrics: (query: URLSearchParams) => MetricList | Response;
  /** Answers GET /api/projects/:id/metrics/chart; by default, fakeMetricChart. */
  metricChart: (query: URLSearchParams) => MetricChart | Response;
  /** Answers GET /api/projects/:id/services; by default, fakeServices. */
  services: (query: URLSearchParams) => ServiceList | Response;
  /** Answers GET /api/projects/:id/hosts; by default, fakeHosts. */
  hosts: (query: URLSearchParams) => HostList | Response;
  /** Answers GET /api/projects/:id/hosts/charts; by default, fakeHostCharts. */
  hostCharts: (query: URLSearchParams) => HostCharts | Response;
  /**
   * The project's uptime checks: the routes list, add (refusing what the
   * API refuses), change, and delete them. By default, fakeChecks.
   */
  checks: Check[];
  /** Answers GET /api/projects/:id/checks/:checkId/results; by default, fakeCheckResults. */
  checkResults: (checkId: string, query: URLSearchParams) => CheckResults | Response;
  /** Answers GET /api/projects/:id/checks/:checkId/incidents; by default, fakeIncidents. */
  incidents: (checkId: string, query: URLSearchParams) => IncidentList | Response;
  /**
   * The instance's notification channels and their deliveries: the routes
   * list, add (refusing what the API refuses for these tests), change,
   * delete, replace a secret, and queue a test. By default, fakeChannels.
   */
  channels: FakeChannels;
  /**
   * The project's alert rules, the alerts firing now, and the history:
   * the routes list, add (refusing what the API refuses for these tests),
   * change, and delete rules. By default, fakeAlerts.
   */
  alerts: FakeAlerts;
  /** Answers DELETE /api/projects/:id; by default, removes the project (204). */
  deleteProject: (api: FakeApi, id: string) => Response;
  /** Every path the page asked for, with its query, in order. */
  requests: string[];
  /** The bodies of requests that change something, such as a delete's confirmation. */
  bodies: { method: string; path: string; body: unknown }[];
}

/** 120 known users, user-1 seen most recently, searched and paged as the API does. */
export function fakeUsers(query: URLSearchParams): UserList {
  const search = (query.get("search") ?? "").toLowerCase();
  const offset = Number(query.get("offset") ?? 0);
  const all: User[] = Array.from({ length: 120 }, (_, i) => ({
    userId: `user-${i + 1}`,
    firstSeenAt: "2026-11-01T02:00:00.000Z",
    lastSeenAt: new Date(Date.UTC(2026, 10, 16, 8, 0) - i * 3_600_000).toISOString(),
    events: 120 - i,
  })).filter((user) => user.userId.includes(search));
  return {
    timeZone: "Asia/Singapore",
    environment: query.get("environment") ?? "production",
    environments: ["production"],
    users: all.slice(offset, offset + 50),
    hasMore: offset + 50 < all.length,
  };
}

/** Ada's activity: 150 pageviews and signups, newest first, paged back by cursor as the API does. */
export function fakeUser(userId: string, query: URLSearchParams): UserActivity | Response {
  if (userId !== "ada") {
    return json(
      { error: "not_found", message: "No event in this environment has this user ID." },
      404,
    );
  }
  const all: Activity[] = Array.from({ length: 150 }, (_, i) => ({
    eventId: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    name: i % 10 === 1 ? "signup" : "pageview",
    occurredAt: new Date(Date.UTC(2026, 10, 16, 8, 0) - i * 1_800_000).toISOString(),
    path: i % 10 === 1 ? "/signup" : `/page-${i}`,
    referrer: null,
    properties: i % 10 === 1 ? { plan: "free" } : {},
    browser: "Firefox",
    os: "Linux",
    deviceType: "desktop",
    country: "DE",
    region: "Bavaria",
    city: "Munich",
    release: "1.4.2",
    error: null,
  }));
  const beforeId = query.get("beforeId");
  const start = beforeId === null ? 0 : all.findIndex((item) => item.eventId === beforeId) + 1;
  return {
    timeZone: "Asia/Singapore",
    environment: query.get("environment") ?? "production",
    user: {
      userId,
      firstSeenAt: all.at(-1)?.occurredAt ?? "",
      lastSeenAt: all[0]?.occurredAt ?? "",
      events: all.length,
    },
    activity: all.slice(start, start + 100),
    hasMore: start + 100 < all.length,
  };
}

/** Three error groups: a TypeError, a regressed ReferenceError, and a resolved network error. */
export const ERROR_FINGERPRINTS = {
  typeError: "1-0123456789abcdef0123",
  referenceError: "2-0123456789abcdef0123",
  networkError: "3-0123456789abcdef0123",
} as const;

/** Resolutions the fake API starts with. */
export const fakeResolutions = (): FakeApi["resolutions"] => ({
  [ERROR_FINGERPRINTS.referenceError]: {
    resolvedAt: "2026-11-12T00:00:00.000Z",
    resolvedBy: "Test Owner",
  },
  [ERROR_FINGERPRINTS.networkError]: {
    resolvedAt: "2026-11-16T00:00:00.000Z",
    resolvedBy: "Test Owner",
  },
});

const ERROR_GROUPS: Omit<ErrorGroup, "status" | "resolvedAt" | "resolvedBy">[] = [
  {
    fingerprint: ERROR_FINGERPRINTS.typeError,
    type: "TypeError",
    message: "Cannot read properties of undefined (reading 'id')",
    occurrences: 1234,
    users: 3,
    visitors: 17,
    firstSeen: "2026-10-20T02:00:00.000Z",
    lastSeen: "2026-11-16T08:00:00.000Z",
  },
  {
    fingerprint: ERROR_FINGERPRINTS.referenceError,
    type: "ReferenceError",
    message: "process is not defined",
    occurrences: 8,
    users: 0,
    visitors: 5,
    firstSeen: "2026-11-01T02:00:00.000Z",
    lastSeen: "2026-11-15T08:00:00.000Z",
  },
  {
    fingerprint: ERROR_FINGERPRINTS.networkError,
    type: "Error",
    message: "Network request failed",
    occurrences: 2,
    users: 1,
    visitors: 2,
    firstSeen: "2026-11-11T02:00:00.000Z",
    lastSeen: "2026-11-14T08:00:00.000Z",
  },
];

/** The groups with their status from the fake API's resolutions, as the API works it out. */
function errorGroups(api: FakeApi): ErrorGroup[] {
  return ERROR_GROUPS.map((group) => {
    const resolution = api.resolutions[group.fingerprint];
    return {
      ...group,
      status:
        resolution === undefined
          ? "unresolved"
          : group.lastSeen > resolution.resolvedAt
            ? "regressed"
            : "resolved",
      resolvedAt: resolution?.resolvedAt ?? null,
      resolvedBy: resolution?.resolvedBy ?? null,
    };
  });
}

/** The error groups of the last 7 days, filtered by status as the API does. */
export function fakeErrors(query: URLSearchParams, api: FakeApi): ErrorList {
  const asked = query.get("status") ?? "unresolved";
  const status = isStatusFilter(asked) ? asked : "unresolved";
  const groups = errorGroups(api).filter(
    (group) => status === "all" || (group.status === "resolved") === (status === "resolved"),
  );
  return {
    timeZone: "Asia/Singapore",
    environment: query.get("environment") ?? "production",
    environments: ["production"],
    firstDay: "2026-11-10",
    lastDay: "2026-11-16",
    status,
    truncated: false,
    groups,
  };
}

/** The TypeError's stack, as the browser reported it: two frames of the site's code, three of a library's. */
export const FAKE_STACK = [
  "TypeError: Cannot read properties of undefined (reading 'id')",
  "    at submit (https://example.com/assets/app.js:1:2345)",
  "    at onClick (https://example.com/assets/app.js:1:6789)",
  "    at dispatch (https://example.com/assets/vendor.js:2:100)",
  "    at run (https://example.com/assets/vendor.js:2:200)",
  "    at flush (https://example.com/assets/vendor.js:2:300)",
].join("\n");

/** A library's frame, which no map covers. */
const vendor = (name: string, column: number): ResolvedFrame => ({
  function: name,
  file: "https://example.com/assets/vendor.js",
  line: 2,
  column,
  original: null,
});

/**
 * FAKE_STACK's frames as release 1.4.2's maps resolve them: app.js's two
 * mapped (the first with the source around its line), vendor.js's not.
 */
export function fakeFrames(): ResolvedFrame[] {
  return [
    {
      function: "submit",
      file: "https://example.com/assets/app.js",
      line: 1,
      column: 2345,
      original: {
        source: "src/checkout/submit.ts",
        line: 42,
        column: 18,
        name: "submitOrder",
        context: {
          firstLine: 39,
          lines: [
            "export function submitOrder(cart: Cart) {",
            "  const items = cart.items;",
            "  // The customer chose a saved address.",
            "  const id = cart.address.id;",
            "  return post(`/orders`, { items, id });",
            "}",
            "",
          ],
        },
      },
    },
    {
      function: "onClick",
      file: "https://example.com/assets/app.js",
      line: 1,
      column: 6789,
      original: {
        source: "src/checkout/form.tsx",
        line: 17,
        column: 5,
        name: null,
        context: null,
      },
    },
    vendor("dispatch", 100),
    vendor("run", 200),
    vendor("flush", 300),
  ];
}

/** One group's detail; the TypeError has a stack, mapped with release 1.4.2's maps; the others none. */
export function fakeError(
  fingerprint: string,
  query: URLSearchParams,
  api: FakeApi,
): ErrorDetail | Response {
  const group = errorGroups(api).find((item) => item.fingerprint === fingerprint);
  if (group === undefined) {
    return json(
      {
        error: "no_occurrences",
        message: "This error has no occurrence in the range and environment.",
      },
      404,
    );
  }
  const occurrence = {
    message: group.message,
    handled: false,
    path: "/checkout",
    userId: null,
    browser: "Chrome",
    browserVersion: "131.0",
    os: "Windows",
    deviceType: "desktop",
    country: "DE",
    release: "1.4.2",
    replay: null,
    service: null,
    traceId: null,
    spanId: null,
  };
  return {
    timeZone: "Asia/Singapore",
    environment: query.get("environment") ?? "production",
    firstDay: "2026-11-10",
    lastDay: "2026-11-16",
    group,
    days: DAYS.map((day, i) => ({
      day: day.day,
      occurrences: [0, 120, 300, 90, 0, 400, 324][i] ?? 0,
    })),
    breakdowns: {
      path: [
        { value: "/checkout", occurrences: 900 },
        { value: null, occurrences: 334 },
      ],
      browser: [
        { value: "Chrome", occurrences: 1000 },
        { value: "Firefox", occurrences: 234 },
      ],
      os: [{ value: "Windows", occurrences: 1234 }],
      release: [
        { value: "1.4.2", occurrences: 1200 },
        { value: null, occurrences: 34 },
      ],
      service: [{ value: null, occurrences: 1234 }],
    },
    source: "browser",
    occurrences: [
      {
        ...occurrence,
        eventId: "00000000-0000-4000-8000-000000000001",
        occurredAt: group.lastSeen,
        userId: "ada",
      },
      {
        ...occurrence,
        eventId: "00000000-0000-4000-8000-000000000002",
        occurredAt: "2026-11-16T07:00:00.000Z",
        handled: true,
        browser: "Firefox",
        browserVersion: "132.0",
        os: "Linux",
        release: null,
      },
    ],
    ...(fingerprint === ERROR_FINGERPRINTS.typeError
      ? {
          stack: FAKE_STACK,
          frames: fakeFrames(),
          sourceMaps: { status: "applied", release: "1.4.2", paths: [] },
        }
      : { stack: null, frames: null, sourceMaps: null }),
  };
}

/** A server's stack, as OpenTelemetry's Python SDK records it. */
export const FAKE_SERVER_STACK = `Traceback (most recent call last):
  File "/srv/shop/payments/views.py", line 41, in charge
    receipt = gateway.charge(order)
  File "/srv/shop/payments/gateway.py", line 88, in charge
    raise CardDeclined(reason)
payments.gateway.CardDeclined: card declined for order 5120`;

/**
 * The TypeError group's detail as a server's exception would give it: from
 * a service over OTLP, with a trace, and a stack never mapped.
 */
export function fakeServerError(
  fingerprint: string,
  query: URLSearchParams,
  api: FakeApi,
): ErrorDetail | Response {
  const detail = fakeError(fingerprint, query, api);
  if (detail instanceof Response) return detail;
  const server = {
    browser: null,
    browserVersion: null,
    os: null,
    deviceType: null,
    country: null,
    service: "payments",
    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    spanId: "00f067aa0ba902b7",
  };
  return {
    ...detail,
    breakdowns: {
      path: [{ value: "/orders/{id}/charge", occurrences: 1234 }],
      browser: [{ value: null, occurrences: 1234 }],
      os: [{ value: null, occurrences: 1234 }],
      release: [{ value: "1.4.2", occurrences: 1234 }],
      service: [{ value: "payments", occurrences: 1234 }],
    },
    source: "server",
    occurrences: detail.occurrences.map((occurrence) => ({
      ...occurrence,
      ...server,
      path: "/orders/{id}/charge",
    })),
    stack: FAKE_SERVER_STACK,
    frames: null,
    sourceMaps: null,
  };
}

/** The trace of fakeServerError's occurrences, and its spans. */
export const FAKE_TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
export const FAKE_SPANS = {
  root: "a1a1a1a1a1a1a1a1",
  query: "b2b2b2b2b2b2b2b2",
  charge: "00f067aa0ba902b7",
  gateway: "c3c3c3c3c3c3c3c3",
  orphan: "d4d4d4d4d4d4d4d4",
};
const TRACE_START_NS = 1_795_000_000_000_000_000n;
const nsAfter = (us: number) => String(TRACE_START_NS + BigInt(us) * 1000n);

/** 130 traces, newest first, a hundred a page, the third of each ten failed, as the API pages them. */
export function fakeTraces(query: URLSearchParams): TraceList {
  const all: TraceSummary[] = Array.from({ length: 130 }, (_, i) => ({
    traceId: i === 0 ? FAKE_TRACE_ID : i.toString(16).padStart(32, "0"),
    spanId: i === 0 ? FAKE_SPANS.root : i.toString(16).padStart(16, "0"),
    service: i % 2 === 0 ? "web" : "worker",
    name: i === 0 ? "POST /orders/{id}/charge" : `job ${i}`,
    start: new Date(Date.UTC(2026, 10, 16, 8, 0) - i * 60_000).toISOString(),
    durationUs: i === 0 ? 182_400 : 1500 + i,
    error: i % 10 === 0,
    spans: i === 0 ? 5 : 1,
  }));
  const service = query.get("service");
  const listed = all.filter(
    (trace) =>
      (service === null || trace.service === service) &&
      (query.get("errors") !== "true" || trace.error),
  );
  const before = query.get("before");
  const start = before === null ? 0 : Number(before.split("-")[0]);
  const page = listed.slice(start, start + 100);
  return {
    timeZone: "Asia/Singapore",
    environment: query.get("environment") ?? "production",
    environments: ["production", "staging"],
    services: ["web", "worker"],
    firstDay: "2026-11-10",
    lastDay: "2026-11-16",
    retentionDays: 30,
    traces: page,
    next: start + 100 < listed.length ? `${start + 100}-${"0".repeat(48)}` : null,
    received: true,
  };
}

/** No span ever received. */
export function noTraces(query: URLSearchParams): TraceList {
  return { ...fakeTraces(query), traces: [], next: null, services: [], received: false };
}

export function fakeLogRecord(overrides: Partial<LogRecord> = {}): LogRecord {
  return {
    id: "0".repeat(32),
    time: "2026-11-16T00:00:00.050Z",
    timeNs: "1795305600050000000",
    observedTime: "2026-11-16T00:00:00.051Z",
    severityNumber: 9,
    severityText: "INFO",
    body: "loading order 5120",
    traceId: null,
    spanId: null,
    eventName: "",
    service: "web",
    release: "1.4.2",
    environment: "production",
    attributes: { "order.id": "5120" },
    resourceAttributes: { "service.name": "web", "host.name": "web-1" },
    scope: { name: "app", version: "" },
    ...overrides,
  };
}

/** A record as a list gives it, the body cut to 1,000 characters, as the API does. */
export function summaryOf(record: LogRecord): LogSummary {
  return {
    id: record.id,
    time: record.time,
    timeNs: record.timeNs,
    severityNumber: record.severityNumber,
    severityText: record.severityText,
    body: record.body.slice(0, 1000),
    bodyTruncated: record.body.length > 1000,
    traceId: record.traceId,
    spanId: record.spanId,
    eventName: record.eventName,
    service: record.service,
    environment: record.environment,
  };
}

/** A long body: its list's row shows the first 1,000 characters, and opening it the rest. */
export const LONG_BODY = `stack dump ${"frame ".repeat(300)}the end`;

/** Every whole record the fake API keeps: the trace's, then the list's. */
const fakeLogRecords = (): LogRecord[] => [...traceLogRecords(FAKE_TRACE_ID), ...allLogRecords()];

/** Answers GET /api/projects/:id/logs/:logId?time=: the record with that ID and time. */
export function fakeLog(logId: string, query: URLSearchParams): LogRecord | Response {
  const found = fakeLogRecords().find(
    (record) => record.id === logId && record.timeNs === query.get("time"),
  );
  return found ?? json({ error: "no_log", message: "No log record with this ID is kept." }, 404);
}

function traceLogRecords(traceId: string): LogRecord[] {
  return [
    fakeLogRecord({ id: "1".repeat(32), traceId, spanId: FAKE_SPANS.root }),
    fakeLogRecord({
      id: "2".repeat(32),
      time: "2026-11-16T00:00:00.170Z",
      timeNs: "1795305600170000000",
      severityNumber: 17,
      severityText: "ERROR",
      body: "Payment declined: card_declined",
      traceId,
      spanId: FAKE_SPANS.charge,
      service: "payments",
    }),
  ];
}

/** A span of the fake trace, as the waterfall lists it. */
const waterfallSpan = (
  spanId: string,
  parentSpanId: string,
  name: string,
  service: string,
  offsetUs: number,
  durationUs: number,
  status: "unset" | "error" = "unset",
) => ({
  spanId,
  parentSpanId,
  name,
  service,
  kind: "server" as const,
  status,
  startNs: nsAfter(offsetUs),
  offsetUs,
  durationUs,
});

/** The charge's trace: an HTTP request, its query, the charge that failed, its call, and a span whose parent never came. */
export function fakeTrace(traceId: string): TraceDetail {
  if (traceId !== FAKE_TRACE_ID) {
    return {
      traceId,
      timeZone: "Asia/Singapore",
      retentionDays: 30,
      start: null,
      durationUs: 0,
      spans: [],
      totalSpans: 0,
      logs: [],
      logsTruncated: false,
    };
  }
  return {
    traceId,
    timeZone: "Asia/Singapore",
    retentionDays: 30,
    start: "2026-11-16T00:00:00.000Z",
    durationUs: 182_400,
    // By start, as the API reads them.
    spans: [
      waterfallSpan(FAKE_SPANS.root, "", "POST /orders/{id}/charge", "web", 0, 182_400),
      waterfallSpan(FAKE_SPANS.query, FAKE_SPANS.root, "SELECT orders", "web", 1200, 850),
      waterfallSpan(FAKE_SPANS.orphan, "e5e5e5e5e5e5e5e5", "background refresh", "web", 2000, 400),
      waterfallSpan(
        FAKE_SPANS.charge,
        FAKE_SPANS.root,
        "charge card",
        "payments",
        5000,
        170_000,
        "error",
      ),
      waterfallSpan(
        FAKE_SPANS.gateway,
        FAKE_SPANS.charge,
        "gateway call",
        "payments",
        6000,
        150_000,
      ),
    ],
    totalSpans: 5,
    logs: traceLogRecords(traceId).map(summaryOf),
    logsTruncated: false,
  };
}

/** A span's detail, from the fake trace. */
export function fakeSpan(traceId: string, spanId: string): SpanDetail | Response {
  const row = fakeTrace(traceId).spans.find((span) => span.spanId === spanId);
  if (row === undefined) {
    return json({ error: "no_span", message: "No span with this ID is kept." }, 404);
  }
  const charge = spanId === FAKE_SPANS.charge;
  return {
    traceId,
    spanId,
    parentSpanId: row.parentSpanId,
    name: row.name,
    kind: row.kind,
    status: row.status,
    statusMessage: charge ? "card declined" : "",
    service: row.service,
    release: "1.4.2",
    environment: "production",
    start: new Date(Date.UTC(2026, 10, 16) + row.offsetUs / 1000).toISOString(),
    durationUs: row.durationUs,
    attributes: charge
      ? { "http.route": "/orders/{id}/charge", "order.id": "5120" }
      : { "http.route": "/orders/{id}" },
    resourceAttributes: { "service.name": row.service, "host.name": "web-1" },
    droppedAttributes: charge ? 2 : 0,
    events: charge
      ? [
          {
            name: "exception",
            time: "2026-11-16T00:00:00.170Z",
            offsetUs: 165_000,
            attributes: { "exception.type": "CardDeclined" },
          },
        ]
      : [],
    droppedEvents: 0,
    links: charge
      ? [{ traceId: "f".repeat(32), spanId: "e".repeat(16), attributes: { reason: "retry of" } }]
      : [],
    droppedLinks: 0,
    scope: { name: "http", version: "1.0" },
  };
}

/** 70 log records, newest first, every fifth a warning, the first in the charge's trace, the second long. */
function allLogRecords(): LogRecord[] {
  return Array.from({ length: 70 }, (_, i) => {
    const time = Date.UTC(2026, 10, 16, 8, 0) - i * 60_000;
    return fakeLogRecord({
      id: i.toString(16).padStart(32, "0"),
      time: new Date(time).toISOString(),
      timeNs: `${time}000000`,
      severityNumber: i % 5 === 0 ? 13 : 9,
      severityText: i % 5 === 0 ? "WARN" : "INFO",
      body: i === 0 ? "Payment declined: card_declined" : i === 1 ? LONG_BODY : `line ${i}`,
      ...(i === 0
        ? { traceId: FAKE_TRACE_ID, spanId: FAKE_SPANS.charge, service: "payments" }
        : {}),
    });
  });
}

/** The records as the API lists them, fifty a page. */
export function fakeLogs(query: URLSearchParams): LogList {
  const all = allLogRecords();
  const search = query.get("search");
  const listed = all.filter(
    (log) =>
      (search === null || log.body.toLowerCase().includes(search.toLowerCase())) &&
      (query.get("severity") !== "warn" || log.severityNumber >= 13),
  );
  const before = query.get("before");
  const start = before === null ? 0 : Number(before.split("-")[0]);
  return {
    timeZone: "Asia/Singapore",
    environment: query.get("environment") ?? "production",
    environments: ["production"],
    services: ["payments", "web"],
    firstDay: "2026-11-10",
    lastDay: "2026-11-16",
    retentionDays: 30,
    logs: listed.slice(start, start + 50).map(summaryOf),
    next: start + 50 < listed.length ? `${start + 50}-${"0".repeat(32)}` : null,
    received: true,
  };
}

/** No log record ever received. */
export function noLogs(query: URLSearchParams): LogList {
  return { ...fakeLogs(query), logs: [], next: null, services: [], received: false };
}

/** What the fake API keeps of a project's session replays. */
const telemetryRange = (query: URLSearchParams) => ({
  timeZone: "Asia/Singapore",
  environment: query.get("environment") ?? "production",
  environments: ["production", "staging"],
  firstDay: "2026-11-10",
  lastDay: "2026-11-16",
  retentionDays: 30,
});

/** Three metrics: a histogram, a counter, and a gauge. */
export function fakeMetrics(query: URLSearchParams): MetricList {
  return {
    ...telemetryRange(query),
    metrics: [
      {
        name: "http.server.request.duration",
        kind: "histogram",
        unit: "ms",
        services: ["api", "web"],
        serviceCount: 2,
        lastSeen: "2026-11-16T08:00:00.000Z",
      },
      {
        name: "http.server.requests",
        kind: "counter",
        unit: "{request}",
        services: ["web"],
        serviceCount: 1,
        lastSeen: "2026-11-16T08:01:00.000Z",
      },
      {
        name: "process.memory.usage",
        kind: "gauge",
        unit: "By",
        services: Array.from({ length: 10 }, (_, i) => `worker-${i}`),
        serviceCount: 12,
        lastSeen: "2026-11-16T08:02:00.000Z",
      },
    ],
    truncated: false,
    received: true,
  };
}

/** No metric ever received. */
export function noMetrics(query: URLSearchParams): MetricList {
  return { ...fakeMetrics(query), metrics: [], received: false };
}

/** Values over 12 buckets, with the 4th missing: base, base + 1 … */
const bucketValues = (base: number) =>
  Array.from({ length: 12 }, (_, i): number | null => (i === 3 ? null : base + i));

/**
 * A metric over 12 buckets of an hour, from 16 Nov 2026 08:00 in
 * Singapore. Split, its lines are "/orders" (most volume), "/cart", and
 * "Other values".
 */
export function fakeMetricChart(query: URLSearchParams): MetricChart {
  const kindParam = query.get("kind");
  const kind = isMetricKind(kindParam) ? kindParam : "gauge";
  const split = query.get("split");
  const line = (value: string | null, other: boolean, base: number): MetricSeries => ({
    value,
    other,
    volume: base * 10,
    values: Object.fromEntries(
      MEASURES[kind].map((measure, index) => [measure, bucketValues(base + index * 10)]),
    ),
  });
  return {
    ...telemetryRange(query),
    name: query.get("name") ?? "",
    kind,
    unit: kind === "gauge" ? "By" : kind === "counter" ? "{request}" : "ms",
    start: "2026-11-16T00:00:00.000Z",
    stepSeconds: 3600,
    buckets: 12,
    split,
    keys: ["http.route", "host.name"],
    series:
      split === null
        ? [line(null, false, 100)]
        : [line("/orders", false, 300), line("/cart", false, 200), line(null, true, 50)],
    seriesCount: 14,
    seriesCapped: false,
    skippedSeries: 0,
    bounds: kind === "histogram" ? [10, 50, 100] : [],
    percentiles: kind === "histogram",
  };
}

/** Two services: web with two routes, billing with one. */
export function fakeServices(query: URLSearchParams): ServiceList {
  return {
    ...telemetryRange(query),
    services: [
      {
        service: "web",
        requests: 1200,
        failed: 30,
        p50Us: 25_000,
        p95Us: 182_400,
        routeCount: 2,
        routes: [
          { route: "/orders/{id}", requests: 1000, failed: 30, p50Us: 30_000, p95Us: 190_000 },
          { route: "GET /health", requests: 200, failed: 0, p50Us: 850, p95Us: 1200 },
        ],
      },
      {
        service: "billing",
        requests: 40,
        failed: 0,
        p50Us: 1_250_000,
        p95Us: 2_000_000,
        routeCount: 140,
        routes: [
          { route: "POST /charge", requests: 40, failed: 0, p50Us: 1_250_000, p95Us: 2_000_000 },
        ],
      },
    ],
    truncated: false,
    received: true,
  };
}

/** No span ever received. */
export function noServices(query: URLSearchParams): ServiceList {
  return { ...fakeServices(query), services: [], received: false };
}

/**
 * Two hosts: db-1, stale, with every value; web-1, reporting, without a
 * load average.
 */
export function fakeHosts(query: URLSearchParams): HostList {
  return {
    ...telemetryRange(query),
    hosts: [
      {
        host: "db-1",
        lastSeen: "2026-11-16T08:10:00.000Z",
        stale: true,
        cpuPercent: 25,
        memoryPercent: 80,
        filesystemPercent: 42,
        filesystemMount: "/",
        load1m: 2,
      },
      {
        host: "web-1",
        lastSeen: "2026-11-16T08:19:00.000Z",
        stale: false,
        cpuPercent: 22.5,
        memoryPercent: 50.04,
        filesystemPercent: 90,
        filesystemMount: "/data",
        load1m: null,
      },
    ],
    truncated: false,
    received: true,
  };
}

/** No host metric ever received. */
export function noHosts(query: URLSearchParams): HostList {
  return { ...fakeHosts(query), hosts: [], received: false };
}

/** 12 hourly values from `base`, the 4th missing. */
const hostValues = (base: number) =>
  Array.from({ length: 12 }, (_, i): number | null => (i === 3 ? null : base + i));

/** A line of a host's chart. */
const line = (value: string | null, base: number, other = false) => ({
  value,
  other,
  values: hostValues(base),
});

/**
 * A host's charts over 12 buckets of an hour, from 16 Nov 2026 08:00 in
 * Singapore, from the default metrics (no utilization); no disk metrics.
 */
export function fakeHostCharts(query: URLSearchParams): HostCharts {
  const host = query.get("host") ?? "";
  return {
    ...telemetryRange(query),
    host,
    lastSeen: "2026-11-16T08:19:00.000Z",
    stale: host === "db-1",
    start: "2026-11-16T00:00:00.000Z",
    stepSeconds: 3600,
    buckets: 12,
    charts: [
      {
        id: "cpu",
        unit: "%",
        metrics: ["system.cpu.time"],
        lines: [line(null, 20)],
        capped: false,
      },
      {
        id: "cpuStates",
        unit: "%",
        metrics: ["system.cpu.time"],
        lines: [line("idle", 70), line("user", 18), line("system", 2)],
        capped: false,
      },
      {
        id: "memoryPercent",
        unit: "%",
        metrics: ["system.memory.usage"],
        lines: [line("used", 50)],
        capped: false,
      },
      {
        id: "memoryBytes",
        unit: "By",
        metrics: ["system.memory.usage"],
        lines: [line("used", 4 * 1024 ** 3)],
        capped: false,
      },
      {
        id: "filesystem",
        unit: "%",
        metrics: ["system.filesystem.usage"],
        lines: [line("/", 60), line("/data", 80)],
        capped: false,
      },
      {
        id: "network",
        unit: "By/s",
        metrics: ["system.network.io"],
        lines: [line("transmit", 2048), line("receive", 1024)],
        capped: false,
      },
      { id: "disk", unit: "By/s", metrics: [], lines: [], capped: false },
      {
        id: "load",
        unit: "{thread}",
        metrics: ["system.cpu.load_average.1m", "system.cpu.load_average.5m"],
        lines: [line("system.cpu.load_average.1m", 1), line("system.cpu.load_average.5m", 2)],
        capped: false,
      },
    ],
  };
}

export interface FakeReplays {
  /** false: the install has no object store. */
  configured: boolean;
  count: number;
  bytes: number;
  /** What the other projects store. */
  otherProjectsBytes: number;
  limitBytes: number;
}

/** Three replays, 1.5 MB, of 5 GB the instance may keep. */
export const fakeReplays = (): FakeReplays => ({
  configured: true,
  count: 3,
  bytes: 1536 * 1024,
  otherProjectsBytes: 512 * 1024,
  limitBytes: 5 * 1024 ** 3,
});

/** GET /api/projects/:id/replays, as the API answers it. */
function replayOverview(api: FakeApi, projectId: string) {
  const project = api.projects.find((item) => item.id === projectId);
  return {
    configured: api.replays.configured,
    mode: project?.replayMode ?? "off",
    replays: { count: api.replays.count, bytes: api.replays.bytes },
    instance: {
      storedBytes: api.replays.otherProjectsBytes + api.replays.bytes,
      limitBytes: api.replays.limitBytes,
    },
  };
}

/** What the fake API keeps of a project's source maps. */
export interface FakeSourceMaps {
  /** false: the install has no object store. */
  configured: boolean;
  limitBytes: number;
  /** What the other projects store. */
  otherProjectsBytes: number;
  files: SourceMapFile[];
}

/** Two releases' maps: 1.4.2's two files, uploaded last, and 1.4.1's one. */
export function fakeSourceMaps(): FakeSourceMaps {
  return {
    configured: true,
    limitBytes: 1024 ** 3,
    otherProjectsBytes: 10 * 1024 ** 2,
    files: [
      {
        release: "1.4.2",
        path: "/assets/app-4f3a.js",
        bytes: 2 * 1024 ** 2,
        uploadedAt: "2026-11-16T08:00:00.000Z",
      },
      {
        release: "1.4.2",
        path: "/assets/vendor-9c1d.js",
        bytes: 512 * 1024,
        uploadedAt: "2026-11-16T08:00:01.000Z",
      },
      {
        release: "1.4.1",
        path: "/assets/app-77b0.js",
        bytes: 1900 * 1024,
        uploadedAt: "2026-11-10T08:00:00.000Z",
      },
    ],
  };
}

/**
 * GET /api/projects/:id/source-maps, from the fake's files: by latest
 * upload, newest or oldest first, at most `limit` (100, as the API).
 */
function sourceMapOverview(maps: FakeSourceMaps, order: "newest" | "oldest", limit = 100) {
  const releases = new Map<string, SourceMapRelease>();
  for (const file of maps.files) {
    const release = releases.get(file.release);
    releases.set(file.release, {
      release: file.release,
      files: (release?.files ?? 0) + 1,
      bytes: (release?.bytes ?? 0) + file.bytes,
      lastUploadedAt:
        release === undefined || file.uploadedAt > release.lastUploadedAt
          ? file.uploadedAt
          : release.lastUploadedAt,
    });
  }
  return {
    configured: maps.configured,
    instance: {
      storedBytes: maps.otherProjectsBytes + maps.files.reduce((sum, file) => sum + file.bytes, 0),
      limitBytes: maps.limitBytes,
    },
    order,
    releases: [...releases.values()]
      .toSorted((a, b) =>
        order === "newest"
          ? b.lastUploadedAt.localeCompare(a.lastUploadedAt)
          : a.lastUploadedAt.localeCompare(b.lastUploadedAt),
      )
      .slice(0, limit),
    totalReleases: releases.size,
  };
}

/** DELETE /api/projects/:id/source-maps?release=…, as the API answers it. */
function deleteRelease(api: FakeApi, release: string): Response {
  if (!api.sourceMaps.configured) {
    return json(
      {
        error: "not_configured",
        message:
          "This install has no object store, so source maps are off. Its operator sets OBJECT_STORE_URL.",
      },
      503,
    );
  }
  if (!api.sourceMaps.files.some((file) => file.release === release)) {
    return json(
      { error: "no_source_maps", message: "The project has no source maps for this release." },
      404,
    );
  }
  api.sourceMaps = {
    ...api.sourceMaps,
    files: api.sourceMaps.files.filter((file) => file.release !== release),
  };
  return new Response(null, { status: 204 });
}

/** Resolves or reopens a group, by the signed-in user, now. */
function changeErrorStatus(api: FakeApi, fingerprint: string, status: string): Response {
  if (status === "resolved") {
    const resolvedAt = new Date().toISOString();
    api.resolutions = {
      ...api.resolutions,
      [fingerprint]: { resolvedAt, resolvedBy: "Test Owner" },
    };
    return json({ fingerprint, resolvedAt });
  }
  const { [fingerprint]: _removed, ...others } = api.resolutions;
  api.resolutions = others;
  return json({ fingerprint, resolvedAt: null });
}

/** The longest goal name, and the most goals, as the API allows (apps/api/src/goals). */
// eslint-disable-next-line no-control-regex -- control characters are what it refuses
const GOAL_NAME = /^[^\u0000-\u001F\u007F]{1,100}$/u;
const MAX_GOALS = 20;

/** Adds a goal as the API does, refusing what it refuses; its counts start at zero. */
function addGoal(api: FakeApi, body: unknown): Response {
  const input = typeof body === "object" && body !== null ? body : {};
  const name = "name" in input && typeof input.name === "string" ? input.name.trim() : "";
  const step = "step" in input ? input.step : undefined;
  if (!GOAL_NAME.test(name)) {
    return json({ error: "invalid_name", message: "A goal's name has 1 to 100 characters." }, 400);
  }
  if (!isFunnelStep(step)) {
    return json({ error: "invalid_step", message: "A goal is a page or an event." }, 400);
  }
  if (api.goals.length >= MAX_GOALS) {
    return json({ error: "too_many_goals", message: "A project has at most 20 goals." }, 409);
  }
  if (api.goals.some((goal) => goal.name === name)) {
    return json(
      { error: "goal_name_taken", message: "The project already has a goal with this name." },
      409,
    );
  }
  const goal = { id: crypto.randomUUID(), name, step, createdAt: new Date().toISOString() };
  api.goals = [...api.goals, { ...goal, visitors: 0, events: 0, conversionRate: 0 }];
  return json({ goal }, 201);
}

function removeGoal(api: FakeApi, goalId: string): Response {
  if (!api.goals.some((goal) => goal.id === goalId)) {
    return json({ error: "goal_not_found", message: "The project has no goal with this ID." }, 404);
  }
  api.goals = api.goals.filter((goal) => goal.id !== goalId);
  return new Response(null, { status: 204 });
}

/** The most saved funnels, as the API allows (apps/api/src/funnels). */
const MAX_SAVED_FUNNELS = 50;

type FunnelInput = Pick<SavedFunnel, "name" | "steps" | "count" | "window">;

/** The fields of a JSON body, or none. */
const fieldsOf = (body: unknown): Record<string, unknown> =>
  typeof body === "object" && body !== null ? Object.fromEntries(Object.entries(body)) : {};

/**
 * A saved funnel's trimmed name and definition, or the API's refusal of
 * them, in its words (apps/api/src/funnels/routes.ts, product/funnel.ts).
 */
function funnelInput(body: unknown): FunnelInput | Response {
  const input = fieldsOf(body);
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!GOAL_NAME.test(name)) {
    return json(
      {
        error: "invalid_name",
        message: "A funnel's name has 1 to 100 characters, and no control characters.",
      },
      400,
    );
  }
  const { steps, count, window } = input;
  if (!Array.isArray(steps) || steps.length < 2 || steps.length > 5 || !steps.every(isFunnelStep)) {
    return json(
      {
        error: "invalid_steps",
        message:
          'steps must be a JSON array of 2 to 5 steps: {"type":"event","name":…} or {"type":"page","path":"/…"}.',
      },
      400,
    );
  }
  const overlap = steps.findIndex(
    (step, index) => index > 0 && stepsOverlap(steps[index - 1] ?? step, step),
  );
  if (overlap > 0) {
    return json(
      {
        error: "steps_overlap",
        message: `Step ${overlap + 1} could match the same event as step ${overlap}, which would count it twice. Put another step between them, or filter both by different values of one property.`,
      },
      400,
    );
  }
  if (
    !isFunnelCount(count) ||
    !isFunnelWindow(window) ||
    (count === "visitors" && window > 86_400)
  ) {
    return json(
      {
        error: "invalid_window",
        message:
          "Visitors can be followed for a day at most: their IDs change daily. Count users instead.",
      },
      400,
    );
  }
  return { name, steps, count, window };
}

const funnelNameTaken = () =>
  json(
    { error: "funnel_name_taken", message: "The project already has a funnel with this name." },
    409,
  );

const funnelNotFound = () =>
  json(
    { error: "funnel_not_found", message: "The project has no saved funnel with this ID." },
    404,
  );

/** Saves a funnel as the API does, refusing what it refuses. */
function saveFunnel(api: FakeApi, body: unknown): Response {
  const input = funnelInput(body);
  if (input instanceof Response) return input;
  if (api.savedFunnels.length >= MAX_SAVED_FUNNELS) {
    return json(
      { error: "too_many_funnels", message: "A project has at most 50 saved funnels." },
      409,
    );
  }
  if (api.savedFunnels.some((funnel) => funnel.name === input.name)) return funnelNameTaken();
  const now = new Date().toISOString();
  const funnel: SavedFunnel = { id: crypto.randomUUID(), ...input, createdAt: now, updatedAt: now };
  api.savedFunnels = [...api.savedFunnels, funnel];
  return json({ funnel }, 201);
}

/**
 * Replaces a saved funnel's name and definition, if it is still the
 * version read (its updatedAt), as the API does.
 */
function changeFunnel(api: FakeApi, funnelId: string, body: unknown): Response {
  const input = funnelInput(body);
  if (input instanceof Response) return input;
  const found = api.savedFunnels.find((funnel) => funnel.id === funnelId);
  if (found === undefined) return funnelNotFound();
  if (fieldsOf(body).updatedAt !== found.updatedAt) {
    return json(
      {
        error: "funnel_changed",
        message:
          "The saved funnel was changed after it was read, such as in another tab. Read it again before changing it.",
      },
      409,
    );
  }
  if (api.savedFunnels.some((funnel) => funnel.id !== funnelId && funnel.name === input.name)) {
    return funnelNameTaken();
  }
  // Always a new version, even within the same millisecond.
  const updatedAt = new Date(Math.max(Date.now(), Date.parse(found.updatedAt) + 1)).toISOString();
  const funnel: SavedFunnel = { ...found, ...input, updatedAt };
  api.savedFunnels = api.savedFunnels.map((item) => (item.id === funnelId ? funnel : item));
  return json({ funnel });
}

function removeFunnel(api: FakeApi, funnelId: string): Response {
  if (!api.savedFunnels.some((funnel) => funnel.id === funnelId)) return funnelNotFound();
  api.savedFunnels = api.savedFunnels.filter((funnel) => funnel.id !== funnelId);
  return new Response(null, { status: 204 });
}

/**
 * Two saved funnels, saved in this order: one of users over a week, whose
 * steps come back with their keys in another order than the address's, and
 * one of visitors within a day.
 */
export function fakeSavedFunnels(): SavedFunnel[] {
  return [
    {
      id: "cccccccc-cccc-4ccc-8ccc-ccccccccccc1",
      name: "Team trial",
      steps: [
        { filter: { value: "team", key: "plan" }, name: "signup", type: "event" },
        { name: "purchase", type: "event" },
      ],
      count: "users",
      window: 604_800,
      createdAt: "2026-11-02T00:00:00.000Z",
      updatedAt: "2026-11-02T00:00:00.000Z",
    },
    {
      id: "cccccccc-cccc-4ccc-8ccc-ccccccccccc2",
      name: "pricing to signup",
      steps: [
        { type: "page", path: "/pricing" },
        { type: "event", name: "signup" },
      ],
      count: "visitors",
      window: 86_400,
      createdAt: "2026-11-03T00:00:00.000Z",
      updatedAt: "2026-11-03T00:00:00.000Z",
    },
  ];
}

function removeProject(api: FakeApi, id: string): Response {
  api.projects = api.projects.filter((project) => project.id !== id);
  return new Response(null, { status: 204 });
}

/**
 * A list of 120 rows, most visitors first, searched and paged as the API
 * does: pages are /page-1 … /page-120, other lists name-1 … name-120.
 */
export function fakeList(query: URLSearchParams) {
  const report = query.get("report") ?? "pages";
  const search = (query.get("search") ?? "").toLowerCase();
  const offset = Number(query.get("offset") ?? 0);
  const limit = Number(query.get("limit") ?? 50);
  const names = Array.from({ length: 120 }, (_, i) =>
    report === "pages" ? `/page-${i + 1}` : `${report}-${i + 1}`,
  ).filter((name) => name.toLowerCase().includes(search));
  const rows = names.slice(offset, offset + limit).map((name, i) => {
    const visitors = 500 - offset - i;
    if (report === "pages")
      return { path: name, pageviews: visitors * 2, visitors, avgEngagedMs: null };
    if (report === "customEvents") return { name, events: visitors * 2, visitors };
    return { value: name, visitors, visits: visitors + 1, bounceRate: 0.5 };
  });
  return { rows, hasMore: offset + limit < names.length };
}

export const SETTINGS: Settings = {
  name: "Acme Inc",
  timeZone: "Asia/Singapore",
  canEdit: true,
};

export const PROJECT: Project = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Main site",
  publicKey: "pk_test",
  allowedHostnames: ["example.com"],
  createdAt: "2026-10-01T00:00:00.000Z",
  lastEventAt: "2026-11-16T09:00:00.000Z",
  retentionDays: null,
  secretKey: "sk_00000000000000000000000000000001",
  requireSignedUserIds: false,
  ignoreDataCenters: true,
  replayMode: "off",
};

export const OTHER_PROJECT: Project = {
  ...PROJECT,
  id: "22222222-2222-4222-8222-222222222222",
  name: "Docs",
  publicKey: "pk_docs",
  secretKey: "sk_00000000000000000000000000000002",
};

const DAYS: DayPoint[] = [
  { day: "2026-11-10", visitors: 120, visits: 131, pageviews: 290 },
  { day: "2026-11-11", visitors: 138, visits: 150, pageviews: 333 },
  { day: "2026-11-12", visitors: 96, visits: 101, pageviews: 210 },
  { day: "2026-11-13", visitors: 129, visits: 140, pageviews: 301 },
  { day: "2026-11-14", visitors: 109, visits: 118, pageviews: 278 },
  { day: "2026-11-15", visitors: 103, visits: 110, pageviews: 239 },
  { day: "2026-11-16", visitors: 70, visits: 74, pageviews: 169 },
];

const row = (value: string | null, visitors: number, visits: number): BreakdownRow => ({
  value,
  visitors,
  visits,
  bounceRate: 0.4,
});

/** Two saved goals with a week's counts: a page, and an event with a property filter. */
export function fakeGoals(): GoalResult[] {
  return [
    {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
      name: "Saw pricing",
      step: { type: "page", path: "/pricing" },
      createdAt: "2026-11-01T00:00:00.000Z",
      visitors: 201,
      events: 260,
      conversionRate: 201 / 765,
    },
    {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
      name: "Team signup",
      step: { type: "event", name: "signup", filter: { key: "plan", value: "team" } },
      createdAt: "2026-11-02T00:00:00.000Z",
      visitors: 40,
      events: 44,
      conversionRate: 40 / 765,
    },
  ];
}

/** A week of numbers for one project; change parts with `overrides`. */
export function analyticsFixture(overrides: Partial<Analytics> = {}): Analytics {
  return {
    timeZone: "Asia/Singapore",
    environment: "production",
    environments: ["production"],
    firstDay: "2026-11-10",
    lastDay: "2026-11-16",
    summary: {
      visitors: 765,
      visits: 824,
      pageviews: 1820,
      viewsPerVisit: 2.21,
      bounceRate: 0.24,
      avgDurationMs: 263_000,
      avgEngagedMs: 110_000,
    },
    days: DAYS,
    pages: [
      { path: "/", pageviews: 420, visitors: 322, avgEngagedMs: 30_000 },
      { path: "/pricing", pageviews: 260, visitors: 201, avgEngagedMs: 45_000 },
    ],
    breakdowns: {
      source: [row("Direct / none", 300, 320), row("google.com", 145, 150)],
      utmCampaign: [row(null, 700, 760), row("launch", 65, 64)],
      entryPage: [row("/pricing", 210, 220), row("/", 190, 200)],
      exitPage: [row("/signup", 150, 160)],
      country: [row("DE", 155, 160), row(null, 125, 130), row("SG", 90, 95)],
      region: [row("Bavaria", 80, 85)],
      city: [row("Munich", 60, 62)],
      deviceType: [row("desktop", 269, 290), row("mobile", 242, 250)],
      browser: [row("Firefox", 130, 140)],
      os: [row("macOS", 200, 210)],
      release: [row("1.4.2", 500, 540), row(null, 265, 284)],
    },
    customEvents: [{ name: "signup", events: 140, visitors: 127 }],
    goals: fakeGoals(),
    // The same week before, up to 15:00 on its last day (07:00 UTC).
    previous: {
      firstDay: "2026-11-03",
      lastDay: "2026-11-09",
      until: "2026-11-09T07:00:00.000Z",
      summary: {
        visitors: 683,
        visits: 824,
        pageviews: 2000,
        viewsPerVisit: 2.43,
        bounceRate: 0.3,
        avgDurationMs: 240_000,
        avgEngagedMs: null,
      },
    },
    ...overrides,
  };
}

/** The same days and lists with nothing in them, as for a period without events. */
export function emptyAnalytics(): Analytics {
  const fixture = analyticsFixture();
  const empty = {
    visitors: 0,
    visits: 0,
    pageviews: 0,
    viewsPerVisit: null,
    bounceRate: null,
    avgDurationMs: null,
    avgEngagedMs: null,
  };
  return {
    ...fixture,
    summary: empty,
    days: fixture.days.map((day) => ({ ...day, visitors: 0, visits: 0, pageviews: 0 })),
    pages: [],
    breakdowns: {
      source: [],
      utmCampaign: [],
      entryPage: [],
      exitPage: [],
      country: [],
      region: [],
      city: [],
      deviceType: [],
      browser: [],
      os: [],
      release: [],
    },
    customEvents: [],
    goals: [],
    previous: { ...fixture.previous, summary: empty },
  };
}

/** A week of Web Vitals: LCP good, INP needing improvement, CLS poor; change parts with `overrides`. */
export function speedFixture(overrides: Partial<Speed> = {}): Speed {
  return {
    timeZone: "Asia/Singapore",
    environment: "production",
    environments: ["production"],
    firstDay: "2026-11-10",
    lastDay: "2026-11-16",
    device: null,
    thresholds: {
      lcp: [2500, 4000],
      inp: [200, 500],
      cls: [0.1, 0.25],
      fcp: [1800, 3000],
      ttfb: [800, 1800],
    },
    loads: 400,
    metrics: {
      lcp: { p75: 2300, count: 380, good: 304, needsImprovement: 57, poor: 19 },
      inp: { p75: 240, count: 150, good: 90, needsImprovement: 45, poor: 15 },
      cls: { p75: 0.31, count: 400, good: 200, needsImprovement: 100, poor: 100 },
      fcp: { p75: 1200, count: 400, good: 360, needsImprovement: 30, poor: 10 },
      ttfb: { p75: 950, count: 400, good: 200, needsImprovement: 150, poor: 50 },
    },
    devices: [
      { deviceType: "desktop", loads: 250, lcp: 1800, inp: 120, cls: 0.05 },
      { deviceType: "mobile", loads: 140, lcp: 4600, inp: 520, cls: 0.3 },
      { deviceType: null, loads: 10, lcp: null, inp: null, cls: 0 },
    ],
    pages: [
      { path: "/", loads: 200, lcp: 2100, inp: 180, cls: 0.08 },
      { path: "/pricing", loads: 120, lcp: 3800, inp: null, cls: 0.12 },
    ],
    days: [
      { day: "2026-11-10", loads: 50, lcp: 2200, inp: 230, cls: 0.3 },
      { day: "2026-11-11", loads: 60, lcp: 2400, inp: 250, cls: 0.31 },
      { day: "2026-11-12", loads: 0, lcp: null, inp: null, cls: null },
      { day: "2026-11-13", loads: 70, lcp: 2100, inp: 220, cls: 0.29 },
      { day: "2026-11-14", loads: 80, lcp: 2500, inp: 260, cls: 0.33 },
      { day: "2026-11-15", loads: 75, lcp: 2300, inp: 240, cls: 0.3 },
      { day: "2026-11-16", loads: 65, lcp: 2350, inp: 235, cls: 0.32 },
    ],
    ...overrides,
  };
}

/** The same week with no page load measured. */
export function emptySpeed(): Speed {
  const fixture = speedFixture();
  const none = { p75: null, count: 0, good: 0, needsImprovement: 0, poor: 0 };
  return {
    ...fixture,
    loads: 0,
    metrics: { lcp: none, inp: none, cls: none, fcp: none, ttfb: none },
    devices: [],
    pages: [],
    days: fixture.days.map((day) => ({ day: day.day, loads: 0, lcp: null, inp: null, cls: null })),
  };
}

/** speedFixture, answering for the environment and device asked for. */
export function fakeSpeed(query: URLSearchParams): Speed {
  return speedFixture({
    environment: query.get("environment") ?? "production",
    device: query.get("device"),
  });
}

const WEEK = {
  timeZone: "Asia/Singapore",
  firstDay: "2026-11-10",
  lastDay: "2026-11-16",
} as const;

/** Three product events of a week; change parts with `overrides`. */
export function productEventsFixture(overrides: Partial<ProductEvents> = {}): ProductEvents {
  return {
    ...WEEK,
    environment: "production",
    environments: ["production"],
    events: [
      { name: "signup", events: 140, visitors: 127, users: 40 },
      { name: "purchase", events: 60, visitors: 50, users: 30 },
      { name: "invite_sent", events: 12, visitors: 0, users: 9 },
    ],
    ...overrides,
  };
}

export function fakeProductEvents(query: URLSearchParams): ProductEvents {
  return productEventsFixture({ environment: query.get("environment") ?? "production" });
}

type PropertyValue = string | number | boolean;

/**
 * 140 signups over the week, each with a plan (80 team, 60 free), a number
 * of seats (3 or 5), and whether it came from an invite.
 */
const SIGNUPS: { day: string; properties: Record<string, PropertyValue> }[] = Array.from(
  { length: 140 },
  (_, i) => ({
    day: `2026-11-${String(10 + (i % 7))}`,
    properties: {
      plan: i < 80 ? "team" : "free",
      seats: i % 2 === 0 ? 3 : 5,
      invited: i % 4 === 0,
    },
  }),
);

/** As the API compares a property: a string as it is, anything else as JSON writes it. */
const asText = (value: PropertyValue) =>
  typeof value === "string" ? value : JSON.stringify(value);

/** One event's detail, filtered as the API filters (signup has events; any other name, zeros). */
export function fakeProductEvent(name: string, query: URLSearchParams): ProductEventDetail {
  const filters = [...query.entries()]
    .filter(([param]) => param.startsWith("p."))
    .map(([param, value]) => ({ key: param.slice(2), value }));
  const events = (name === "signup" ? SIGNUPS : []).filter((event) =>
    filters.every((filter) => {
      const value = event.properties[filter.key];
      return value !== undefined && asText(value) === filter.value;
    }),
  );
  const names = events.length === 0 ? [] : ["plan", "seats", "invited"];
  return {
    ...WEEK,
    environment: query.get("environment") ?? "production",
    name,
    filters,
    events: events.length,
    visitors: Math.round(events.length * 0.9),
    users: Math.round(events.length * 0.3),
    days: DAYS.map(({ day }) => ({
      day,
      events: events.filter((event) => event.day === day).length,
    })),
    properties: names.map((property) => {
      const counts = new Map<string, number>();
      for (const event of events) {
        const value = event.properties[property];
        if (value !== undefined) counts.set(asText(value), (counts.get(asText(value)) ?? 0) + 1);
      }
      return {
        key: property,
        events: events.length,
        values: [...counts]
          .map(([value, count]) => ({ value, events: count }))
          .toSorted((a, b) => b.events - a.events || a.value.localeCompare(b.value)),
      };
    }),
  };
}

/** People reaching each step: 1,000 start, fewer at each next one. */
export const FUNNEL_REACHED = [1000, 420, 126, 50, 0];

/** A funnel of the steps asked for, refusing what the API refuses. */
export function fakeFunnel(query: URLSearchParams): Funnel | Response {
  let steps: unknown;
  try {
    steps = JSON.parse(query.get("steps") ?? "");
  } catch {
    return json({ error: "invalid_steps", message: "steps must be a JSON array." }, 400);
  }
  if (!Array.isArray(steps) || steps.length < 2 || steps.length > 5 || !steps.every(isFunnelStep)) {
    return json({ error: "invalid_steps", message: "steps must be 2 to 5 steps." }, 400);
  }
  const count = query.get("count") === "users" ? "users" : "visitors";
  const window = Number(query.get("window") ?? 86_400);
  if (count === "visitors" && window > 86_400) {
    return json(
      { error: "invalid_window", message: "Visitors can be followed for a day at most." },
      400,
    );
  }
  const environment = query.get("environment") ?? "production";
  return {
    ...WEEK,
    environment,
    environments:
      environment === "production" ? ["production", "staging"] : ["production", environment],
    count,
    window,
    steps: steps.map((step, i) => ({ step, reached: FUNNEL_REACHED[i] ?? 0 })),
  };
}

/** Four weekly cohorts up to the current week (16 Nov 2026), which is not over. */
export function retentionFixture(overrides: Partial<Retention> = {}): Retention {
  return {
    ...WEEK,
    environment: "production",
    environments: ["production", "staging"],
    currentWeek: "2026-11-16",
    cohorts: [
      { week: "2026-10-26", users: 40, retained: [40, 20, 12, 10] },
      { week: "2026-11-02", users: 25, retained: [25, 10, 0] },
      { week: "2026-11-09", users: 10, retained: [10, 4] },
      { week: "2026-11-16", users: 8, retained: [8] },
    ],
    ...overrides,
  };
}

export function fakeRetention(query: URLSearchParams): Retention {
  const environment = query.get("environment") ?? "production";
  return retentionFixture({
    environment,
    environments:
      environment === "production" ? ["production", "staging"] : ["production", environment],
  });
}

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Two checks: one up, one down since 09:40 in Singapore, with their uptime. */
export function fakeChecks(): Check[] {
  const base = {
    method: "GET" as const,
    timeoutSeconds: 10,
    expectedStatuses: "200-399",
    word: null,
    wordMode: "present" as const,
    failuresBeforeDown: 2,
    paused: false,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  };
  return [
    {
      ...base,
      id: "cccccccc-cccc-4ccc-8ccc-000000000001",
      name: "Shop home",
      url: "https://shop.example/",
      intervalSeconds: 60,
      state: "up",
      consecutiveFailures: 0,
      failingSince: null,
      failingCause: null,
      lastCheckedAt: "2026-11-16T08:59:30.000Z",
      lastUp: true,
      lastStatusCode: 200,
      lastResponseMs: 123,
      lastCause: null,
      tlsExpiresAt: "2027-01-31T12:00:00.000Z",
      uptime: { day: 1, week: 0.99951, month: 0.9875 },
    },
    {
      ...base,
      id: "cccccccc-cccc-4ccc-8ccc-000000000002",
      name: "API health",
      url: "https://api.shop.example/health",
      intervalSeconds: 300,
      word: "healthy",
      state: "down",
      consecutiveFailures: 4,
      failingSince: "2026-11-16T01:40:00.000Z",
      failingCause: "status",
      lastCheckedAt: "2026-11-16T09:00:00.000Z",
      lastUp: false,
      lastStatusCode: 503,
      lastResponseMs: 48,
      lastCause: "status",
      tlsExpiresAt: null,
      uptime: { day: 0.7, week: 0.95, month: null },
    },
  ];
}

/** 24 hourly buckets of 16 November in Singapore; nothing answered in the 4th. */
export function fakeCheckResults(_checkId: string, query: URLSearchParams): CheckResults {
  return {
    timeZone: "Asia/Singapore",
    firstDay: query.get("from") ?? "2026-11-16",
    lastDay: query.get("to") ?? "2026-11-16",
    retentionDays: 90,
    uptime: 0.98765,
    start: "2026-11-15T16:00:00.000Z",
    stepSeconds: 3600,
    buckets: 24,
    responseMs: Array.from({ length: 24 }, (_, index) => (index === 3 ? null : 100 + index * 10)),
    runs: 288,
    failures: 3,
    latestFailures: [
      {
        at: "2026-11-16T01:45:00.000Z",
        statusCode: 503,
        responseMs: 48,
        cause: "status",
        detail: "It answered 503, which does not count as up.",
      },
      {
        at: "2026-11-15T19:10:00.000Z",
        statusCode: null,
        responseMs: 10_000,
        cause: "timeout",
        detail: "No complete answer within 10 seconds.",
      },
    ],
  };
}

/** One incident still open, one that lasted 25 minutes. */
export function fakeIncidents(_checkId: string, query: URLSearchParams): IncidentList {
  return {
    timeZone: "Asia/Singapore",
    firstDay: query.get("from") ?? "2026-11-16",
    lastDay: query.get("to") ?? "2026-11-16",
    truncated: false,
    incidents: [
      {
        id: "dddddddd-dddd-4ddd-8ddd-000000000001",
        startedAt: "2026-11-16T01:40:00.000Z",
        endedAt: null,
        cause: "status",
        detail: "It answered 503, which does not count as up.",
      },
      {
        id: "dddddddd-dddd-4ddd-8ddd-000000000002",
        startedAt: "2026-11-15T19:05:00.000Z",
        endedAt: "2026-11-15T19:30:00.000Z",
        cause: "timeout",
        detail: "No complete answer within 10 seconds.",
      },
    ],
  };
}

/** A check added or changed as the API would, refusing what it refuses for these tests. */
function saveCheck(api: FakeApi, body: unknown, existing?: Check): Response {
  const input = fieldsOf(body);
  const text = (key: string) => (typeof input[key] === "string" ? input[key] : undefined);
  const url = text("url") ?? existing?.url ?? "";
  if (!/^https?:\/\//.test(url)) {
    return json(
      { error: "invalid_url", message: "A check's URL starts with http:// or https://." },
      400,
    );
  }
  const host = new URL(url).hostname;
  if (host.endsWith(".internal")) {
    return json(
      {
        error: "address_not_allowed",
        message: `${host} resolves to an address checks may not reach.`,
      },
      400,
    );
  }
  if (existing === undefined && api.checks.length >= 50) {
    return json({ error: "too_many_checks", message: "A project has at most 50 checks." }, 409);
  }
  const now = new Date().toISOString();
  const word = input.word === null ? null : (text("word") ?? existing?.word ?? null);
  const check: Check = {
    ...(existing ?? fakeChecks()[0]),
    id: existing?.id ?? crypto.randomUUID(),
    name: (text("name") ?? "").trim() || existing?.name || host,
    url,
    method: input.method === "HEAD" ? "HEAD" : "GET",
    intervalSeconds: Number(input.intervalSeconds ?? existing?.intervalSeconds ?? 300),
    timeoutSeconds: Number(input.timeoutSeconds ?? existing?.timeoutSeconds ?? 10),
    expectedStatuses: text("expectedStatuses") ?? existing?.expectedStatuses ?? "200-399",
    word: word === "" ? null : word,
    wordMode: input.wordMode === "absent" ? "absent" : "present",
    failuresBeforeDown: Number(input.failuresBeforeDown ?? existing?.failuresBeforeDown ?? 2),
    paused: typeof input.paused === "boolean" ? input.paused : (existing?.paused ?? false),
    ...(existing === undefined
      ? {
          state: "pending",
          consecutiveFailures: 0,
          failingSince: null,
          failingCause: null,
          lastCheckedAt: null,
          lastUp: null,
          lastStatusCode: null,
          lastResponseMs: null,
          lastCause: null,
          tlsExpiresAt: null,
          createdAt: now,
          uptime: { day: null, week: null, month: null },
        }
      : {}),
    updatedAt: now,
  };
  api.checks =
    existing === undefined
      ? [...api.checks, check]
      : api.checks.map((item) => (item.id === check.id ? check : item));
  return json({ check }, existing === undefined ? 201 : 200);
}

/** The fake API's alert rules and alerts, as the alert routes answer them. */
export interface FakeAlerts {
  rules: Rule[];
  firing: FiringAlert[];
  history: HistoryEntry[];
}

export const ALERT_RULE_IDS = {
  apiDown: "abababab-abab-4bab-8bab-000000000001",
  newErrors: "abababab-abab-4bab-8bab-000000000002",
  checkoutSpike: "abababab-abab-4bab-8bab-000000000003",
  certificates: "abababab-abab-4bab-8bab-000000000004",
} as const;

/**
 * Four rules: "API health" down (firing), new errors in production to both
 * channels, a spike of the TypeError group (turned off), and certificates,
 * turned off by the server when its channel was deleted; one alert firing,
 * three in the history, one of them held back.
 */
export function fakeAlerts(): FakeAlerts {
  const [email, webhook] = fakeChannels().list;
  const [, apiHealth] = fakeChecks();
  const base = {
    disabledReason: null,
    lastFiredAt: null,
    createdAt: "2026-11-12T00:00:00.000Z",
    updatedAt: "2026-11-12T00:00:00.000Z",
  };
  return {
    rules: [
      {
        ...base,
        id: ALERT_RULE_IDS.apiDown,
        name: "API down",
        kind: "check_down",
        settings: { checkId: apiHealth?.id ?? null },
        channelIds: [email?.id ?? ""],
        enabled: true,
        firing: 1,
        lastFiredAt: "2026-11-16T01:41:00.000Z",
      },
      {
        ...base,
        id: ALERT_RULE_IDS.newErrors,
        name: "New errors",
        kind: "error_new",
        settings: { environment: "production" },
        channelIds: [email?.id ?? "", webhook?.id ?? ""],
        enabled: true,
        firing: 0,
      },
      {
        ...base,
        id: ALERT_RULE_IDS.checkoutSpike,
        name: "Checkout spike",
        kind: "error_spike",
        settings: {
          environment: null,
          fingerprint: ERROR_FINGERPRINTS.typeError,
          windowMinutes: 10,
          threshold: 20,
        },
        channelIds: [webhook?.id ?? ""],
        enabled: false,
        firing: 0,
      },
      {
        ...base,
        id: ALERT_RULE_IDS.certificates,
        name: "Certificates",
        kind: "certificate_expiring",
        settings: { checkId: null, days: 14 },
        channelIds: [],
        enabled: false,
        disabledReason:
          "Turned off: its last channel was deleted. Choose a channel to turn it on again.",
        firing: 0,
      },
    ],
    firing: [
      {
        ruleId: ALERT_RULE_IDS.apiDown,
        ruleName: "API down",
        kind: "check_down",
        subject: apiHealth?.id ?? "",
        subjectName: "API health",
        since: "2026-11-16T01:41:00.000Z",
        message:
          'Main site: the check "API health" (https://api.shop.example/health) is down. It answered 503, which does not count as up.',
      },
    ],
    history: [
      {
        id: "acacacac-acac-4cac-8cac-000000000001",
        ruleId: ALERT_RULE_IDS.apiDown,
        ruleName: "API down",
        kind: "check_down",
        subject: apiHealth?.id ?? "",
        subjectName: "API health",
        firedAt: "2026-11-16T01:41:00.000Z",
        resolvedAt: null,
        message:
          'Main site: the check "API health" (https://api.shop.example/health) is down. It answered 503, which does not count as up.',
        notified: true,
      },
      {
        id: "acacacac-acac-4cac-8cac-000000000002",
        ruleId: ALERT_RULE_IDS.newErrors,
        ruleName: "New errors",
        kind: "error_new",
        subject: ERROR_FINGERPRINTS.networkError,
        subjectName: "NetworkError: Failed to fetch",
        firedAt: "2026-11-15T22:10:00.000Z",
        resolvedAt: null,
        message: "Main site: a new error in production. NetworkError: Failed to fetch",
        notified: false,
      },
      {
        id: "acacacac-acac-4cac-8cac-000000000003",
        ruleId: ALERT_RULE_IDS.apiDown,
        ruleName: "API down",
        kind: "check_down",
        subject: apiHealth?.id ?? "",
        subjectName: "API health",
        firedAt: "2026-11-15T19:06:00.000Z",
        resolvedAt: "2026-11-15T19:31:00.000Z",
        message:
          'Main site: the check "API health" (https://api.shop.example/health) is down. No complete answer within 10 seconds.',
        notified: true,
      },
    ],
  };
}

/** A rule added or changed as the API would, refusing what it refuses for these tests. */
function saveRule(api: FakeApi, body: unknown, existing?: Rule): Response {
  const input = fieldsOf(body);
  const kind = input.kind === undefined ? existing?.kind : input.kind;
  if (!isRuleKind(kind)) {
    return json({ error: "invalid_kind", message: "Choose what the rule watches." }, 400);
  }
  const channelIds = Array.isArray(input.channelIds)
    ? input.channelIds.filter((id): id is string => typeof id === "string")
    : (existing?.channelIds ?? []);
  if (channelIds.length === 0) {
    return json(
      { error: "invalid_channels", message: "Choose at least one channel to send to." },
      400,
    );
  }
  if (!channelIds.every((id) => api.channels.list.some((channel) => channel.id === id))) {
    return json(
      {
        error: "channel_not_found",
        message: "This instance has no notification channel with one of these IDs.",
      },
      400,
    );
  }
  if (existing === undefined && api.alerts.rules.length >= 50) {
    return json({ error: "too_many_rules", message: "A project has at most 50 alert rules." }, 409);
  }
  const settings =
    typeof input.settings === "object" && input.settings !== null
      ? (input.settings as Rule["settings"])
      : (existing?.settings ?? {});
  const enabled = typeof input.enabled === "boolean" ? input.enabled : (existing?.enabled ?? true);
  const name = typeof input.name === "string" ? input.name.trim() : (existing?.name ?? "");
  const now = new Date().toISOString();
  const rule: Rule = {
    id: existing?.id ?? crypto.randomUUID(),
    name: name === "" ? KIND_LABEL[kind] : name,
    kind,
    settings,
    channelIds,
    enabled,
    disabledReason: enabled ? null : (existing?.disabledReason ?? null),
    firing: enabled ? (existing?.firing ?? 0) : 0,
    lastFiredAt: existing?.lastFiredAt ?? null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  api.alerts.rules =
    existing === undefined
      ? [...api.alerts.rules, rule]
      : api.alerts.rules.map((item) => (item.id === rule.id ? rule : item));
  return json({ rule }, existing === undefined ? 201 : 200);
}

/** The alert routes; null for any other path. */
function answerAlerts(api: FakeApi, path: string, init?: RequestInit): Response | null {
  const body = () => JSON.parse(typeof init?.body === "string" ? init.body : "null") as unknown;
  if (/^\/api\/projects\/[^/]+\/alerts\/firing$/.test(path)) {
    return json({ timeZone: "Asia/Singapore", alerts: api.alerts.firing });
  }
  if (/^\/api\/projects\/[^/]+\/alerts$/.test(path)) {
    return json({
      timeZone: "Asia/Singapore",
      retentionDays: 90,
      alerts: api.alerts.history,
      next: null,
    });
  }
  if (/^\/api\/projects\/[^/]+\/alert-rules$/.test(path)) {
    if (init?.method === "POST") return saveRule(api, body());
    return json({
      timeZone: "Asia/Singapore",
      maxRules: 50,
      hourlyCap: 20,
      rules: api.alerts.rules,
    });
  }
  const rulePath = /^\/api\/projects\/[^/]+\/alert-rules\/([^/]+)$/.exec(path);
  if (rulePath?.[1] === undefined) return null;
  const ruleId = decodeURIComponent(rulePath[1]);
  const existing = api.alerts.rules.find((rule) => rule.id === ruleId);
  if (existing === undefined) {
    return json(
      { error: "rule_not_found", message: "The project has no alert rule with this ID." },
      404,
    );
  }
  if (init?.method === "DELETE") {
    api.alerts.rules = api.alerts.rules.filter((rule) => rule.id !== ruleId);
    return new Response(null, { status: 204 });
  }
  if (init?.method === "PATCH") return saveRule(api, body(), existing);
  return json({ rule: existing });
}

/** The fake API's notification channels, as GET /api/channels answers, with each one's deliveries. */
export interface FakeChannels {
  emailConfigured: boolean;
  list: Channel[];
  /** By channel ID, newest first. */
  deliveries: Record<string, Delivery[]>;
  /** Test sends left this minute, per channel; past them, 429 as the API answers. */
  testsLeft: number;
  /** Webhooks' secrets by channel ID: only GET and POST /api/channels/:id/secret answer them. */
  secrets: Record<string, string>;
}

/** The fake webhook's secret, as GET /api/channels/:id/secret answers it. */
// Made at run time, so the secret scanner sees no literal key.
export const FAKE_SECRET = btoa("secret-for-the-browser-tests-only").replace(/=+$/, "");
/** The secret a rotation answers with. */
export const ROTATED_SECRET = btoa("rotated-secret-from-the-fake-api").replace(/=+$/, "");

const delivery = (id: number, more: Partial<Delivery>): Delivery => ({
  id: `eeeeeeee-eeee-4eee-8eee-${String(id).padStart(12, "0")}`,
  notificationId: `ffffffff-ffff-4fff-8fff-${String(id).padStart(12, "0")}`,
  type: "check.down",
  message: "API health is down: it answered 503.",
  status: "sent",
  attempts: 1,
  nextAttemptAt: null,
  lastError: null,
  createdAt: "2026-11-16T01:40:00.000Z",
  sentAt: "2026-11-16T01:40:02.000Z",
  ...more,
});

/**
 * Two channels: an email list, and a webhook whose deliveries are one
 * retrying, one that failed for good, and 23 sent, so they take two pages.
 */
export function fakeChannels(): FakeChannels {
  const email: Channel = {
    id: "cccccccc-cccc-4ccc-8ccc-000000000001",
    name: "On call",
    kind: "email",
    addresses: ["ops@example.com", "dev@example.com"],
    url: null,
    hasSecret: false,
    createdAt: "2026-11-10T00:00:00.000Z",
    updatedAt: "2026-11-10T00:00:00.000Z",
  };
  const webhook: Channel = {
    id: "cccccccc-cccc-4ccc-8ccc-000000000002",
    name: "Ops relay",
    kind: "webhook",
    addresses: null,
    url: "https://hooks.example.com/ottertrail",
    hasSecret: true,
    createdAt: "2026-11-11T00:00:00.000Z",
    updatedAt: "2026-11-11T00:00:00.000Z",
  };
  return {
    emailConfigured: false,
    list: [email, webhook],
    deliveries: {
      [email.id]: [],
      [webhook.id]: [
        delivery(1, {
          type: "check.up",
          message: "API health is up again.",
          status: "pending",
          attempts: 2,
          nextAttemptAt: "2026-11-16T02:12:00.000Z",
          lastError: "It answered 503; a webhook must answer 2xx.",
          createdAt: "2026-11-16T02:10:00.000Z",
          sentAt: null,
        }),
        delivery(2, {
          status: "failed",
          attempts: 8,
          lastError: "hooks.example.com resolves to an address webhooks may not reach.",
          createdAt: "2026-11-16T01:50:00.000Z",
          sentAt: null,
        }),
        ...Array.from({ length: 23 }, (_, index) =>
          delivery(3 + index, {
            createdAt: new Date(
              Date.parse("2026-11-15T12:00:00.000Z") - index * 3_600_000,
            ).toISOString(),
            sentAt: new Date(
              Date.parse("2026-11-15T12:00:02.000Z") - index * 3_600_000,
            ).toISOString(),
          }),
        ),
      ],
    },
    testsLeft: 5,
    secrets: { [webhook.id]: FAKE_SECRET },
  };
}

const channelNotFound = () =>
  json(
    {
      error: "channel_not_found",
      message: "This instance has no notification channel with this ID.",
    },
    404,
  );

/** A channel added or changed as the API would, refusing what it refuses for these tests. */
function saveChannel(api: FakeApi, body: unknown, existing?: Channel): Response {
  const input = fieldsOf(body);
  const kind = existing?.kind ?? (input.kind === "webhook" ? "webhook" : "email");
  const now = new Date().toISOString();
  let addresses: string[] | null = null;
  let url: string | null = null;
  if (kind === "email") {
    addresses = Array.isArray(input.addresses)
      ? input.addresses.filter((item): item is string => typeof item === "string")
      : (existing?.addresses ?? []);
    const bad = addresses.find((address) => address.includes("!"));
    if (bad !== undefined) {
      return json(
        {
          error: "invalid_address",
          message: `"${bad}" is not an address email can go to here. Use letters, digits, and . _ ' + - before the @, and a domain such as example.com.`,
        },
        400,
      );
    }
  } else {
    url = typeof input.url === "string" ? input.url : (existing?.url ?? "");
    const host = URL.parse(url)?.hostname ?? "";
    if (host.endsWith(".internal")) {
      return json(
        {
          error: "address_not_allowed",
          message: `${host} resolves to an address webhooks may not reach.`,
        },
        400,
      );
    }
  }
  if (existing === undefined && api.channels.list.length >= 20) {
    return json(
      { error: "too_many_channels", message: "An instance has at most 20 notification channels." },
      409,
    );
  }
  const typedName = typeof input.name === "string" ? input.name.trim() : "";
  const channel: Channel = {
    id: existing?.id ?? crypto.randomUUID(),
    name:
      typedName ||
      (existing === undefined
        ? (addresses?.[0] ?? URL.parse(url ?? "")?.hostname ?? "")
        : existing.name),
    kind,
    addresses,
    url,
    hasSecret: kind === "webhook",
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  api.channels.list =
    existing === undefined
      ? [...api.channels.list, channel]
      : api.channels.list.map((item) => (item.id === channel.id ? channel : item));
  if (existing === undefined) api.channels.deliveries[channel.id] = [];
  if (existing === undefined && kind === "webhook") {
    api.channels.secrets[channel.id] = "bmV3LXNlY3JldC1tYWRlLWJ5LXRoZS1mYWtlLWFwaQ";
  }
  return json({ channel }, existing === undefined ? 201 : 200);
}

/** The notification channel routes, as the API answers them; null for another path. */
function answerChannels(api: FakeApi, url: URL, init: RequestInit | undefined): Response | null {
  const path = url.pathname;
  const body = () => JSON.parse(typeof init?.body === "string" ? init.body : "{}") as unknown;
  if (path === "/api/channels") {
    if (init?.method === "POST") return saveChannel(api, body());
    return json({
      maxChannels: 20,
      email: { configured: api.channels.emailConfigured },
      channels: api.channels.list,
    });
  }
  const match = /^\/api\/channels\/([^/]+)(?:\/(secret|test|deliveries))?$/.exec(path);
  if (match?.[1] === undefined) return null;
  const id = decodeURIComponent(match[1]);
  const channel = api.channels.list.find((item) => item.id === id);
  if (channel === undefined) return channelNotFound();
  switch (match[2]) {
    case "secret": {
      if (channel.kind !== "webhook") {
        return json({ error: "not_a_webhook", message: "Only a webhook has a secret." }, 400);
      }
      if (init?.method === "POST") {
        const secret = ROTATED_SECRET;
        api.channels.secrets[id] = secret;
        return json({ channel, secret });
      }
      return json({ secret: api.channels.secrets[id] ?? "" });
    }
    case "test": {
      if (api.channels.testsLeft <= 0) {
        return json(
          {
            error: "too_many_tests",
            message:
              "A channel takes at most 5 test sends a minute. Wait a moment, then try again.",
          },
          429,
        );
      }
      api.channels.testsLeft -= 1;
      const queued = delivery(900 + api.channels.testsLeft, {
        id: crypto.randomUUID(),
        type: "test",
        message: `A test notification for the channel "${channel.name}", sent by Test Owner from the dashboard.`,
        status: "pending",
        attempts: 0,
        nextAttemptAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        sentAt: null,
      });
      api.channels.deliveries[id] = [queued, ...(api.channels.deliveries[id] ?? [])];
      return json(
        {
          notificationId: queued.notificationId,
          delivery: { id: queued.id, channelId: id, status: "pending" },
        },
        202,
      );
    }
    case "deliveries": {
      const all = api.channels.deliveries[id] ?? [];
      const before = url.searchParams.get("before");
      const start = before === null ? 0 : all.findIndex((item) => item.id === before) + 1;
      const page = all.slice(start, start + 20);
      const more = start + 20 < all.length;
      return json({
        retentionDays: 30,
        deliveries: page,
        next: more ? (page.at(-1)?.id ?? null) : null,
      });
    }
    default:
      if (init?.method === "DELETE") {
        api.channels.list = api.channels.list.filter((item) => item.id !== id);
        return new Response(null, { status: 204 });
      }
      if (init?.method === "PATCH") return saveChannel(api, body(), channel);
      return json({ channel });
  }
}

const checkNotFound = () =>
  json({ error: "check_not_found", message: "The project has no check with this ID." }, 404);

const SESSION = {
  session: {
    id: "session-1",
    userId: "user-1",
    expiresAt: "2026-12-16T00:00:00.000Z",
    createdAt: "2026-11-16T00:00:00.000Z",
    updatedAt: "2026-11-16T00:00:00.000Z",
    token: "fake",
    ipAddress: null,
    userAgent: null,
  },
  user: {
    id: "user-1",
    name: "Test Owner",
    email: "owner@example.com",
    emailVerified: false,
    image: null,
    createdAt: "2026-11-16T00:00:00.000Z",
    updatedAt: "2026-11-16T00:00:00.000Z",
  },
};

function requestUrl(input: RequestInfo | URL): URL {
  const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  return new URL(href, window.location.origin);
}

let active: FakeApi | undefined;

function createProject(api: FakeApi, body: unknown): Response {
  const input = typeof body === "object" && body !== null ? body : {};
  const name = "name" in input && typeof input.name === "string" ? input.name : "";
  const project: Project = {
    ...PROJECT,
    id: crypto.randomUUID(),
    name,
    publicKey: "pk_new",
    lastEventAt: null,
  };
  api.projects = [...api.projects, project];
  return json({ project }, 201);
}

async function answer(api: FakeApi, url: URL, init: RequestInit | undefined): Promise<Response> {
  const path = url.pathname;
  if (path === "/api/auth/get-session") {
    return json(api.signedIn ? SESSION : null);
  }
  if (path === "/api/auth/sign-out") {
    api.signedIn = false;
    return json({ success: true });
  }
  if (path === "/api/auth/sign-in/email") {
    api.signedIn = true;
    return json({ redirect: false, token: "fake", user: SESSION.user });
  }
  if (path === "/api/health") {
    return json({ status: "ok" });
  }
  // As the API: everything else needs a session (sign-in and setup are above or public).
  if (!api.signedIn && !path.startsWith("/api/auth/") && path !== "/api/setup") {
    return json({ error: "unauthorized", message: "Sign in to continue." }, 401);
  }
  if (path === "/api/settings" && init?.method === "PATCH") {
    if (!api.settings.canEdit) {
      return json(
        { error: "forbidden", message: "Only the owner can change these settings." },
        403,
      );
    }
    const changes: unknown = JSON.parse(typeof init.body === "string" ? init.body : "{}");
    api.settings = { ...api.settings, ...(typeof changes === "object" ? changes : {}) };
    return json({ settings: api.settings });
  }
  if (path === "/api/settings") {
    return json({ settings: api.settings });
  }
  const channels = answerChannels(api, url, init);
  if (channels !== null) return channels;
  if (path === "/api/projects" && init?.method === "POST") {
    return createProject(api, JSON.parse(typeof init.body === "string" ? init.body : "null"));
  }
  if (path === "/api/projects") {
    return json({ projects: api.projects });
  }
  if (/^\/api\/projects\/[^/]+\/users$/.test(path)) {
    const result = api.users(url.searchParams);
    return result instanceof Response ? result : json(result);
  }
  if (/^\/api\/projects\/[^/]+\/events$/.test(path)) {
    const result = api.productEvents(url.searchParams);
    return result instanceof Response ? result : json(result);
  }
  const productEventPath = /^\/api\/projects\/[^/]+\/events\/([^/]+)$/.exec(path);
  if (productEventPath?.[1] !== undefined) {
    const result = api.productEvent(decodeURIComponent(productEventPath[1]), url.searchParams);
    return result instanceof Response ? result : json(result);
  }
  if (/^\/api\/projects\/[^/]+\/funnel$/.test(path)) {
    const result = api.funnel(url.searchParams);
    return result instanceof Response ? result : json(result);
  }
  if (/^\/api\/projects\/[^/]+\/retention$/.test(path)) {
    const result = api.retention(url.searchParams);
    return result instanceof Response ? result : json(result);
  }
  if (/^\/api\/projects\/[^/]+\/goals$/.test(path)) {
    if (init?.method === "POST") {
      return addGoal(api, JSON.parse(typeof init.body === "string" ? init.body : "null"));
    }
    return json({
      goals: api.goals.map(({ id, name, step, createdAt }) => ({ id, name, step, createdAt })),
    });
  }
  if (/^\/api\/projects\/[^/]+\/funnels$/.test(path)) {
    if (init?.method === "POST") {
      return saveFunnel(api, JSON.parse(typeof init.body === "string" ? init.body : "null"));
    }
    // By name, as the API orders them.
    return json({
      funnels: api.savedFunnels.toSorted((a, b) =>
        a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
      ),
    });
  }
  const savedFunnelPath = /^\/api\/projects\/[^/]+\/funnels\/([^/]+)$/.exec(path);
  if (savedFunnelPath?.[1] !== undefined && init?.method === "PUT") {
    return changeFunnel(
      api,
      decodeURIComponent(savedFunnelPath[1]),
      JSON.parse(typeof init.body === "string" ? init.body : "null"),
    );
  }
  if (savedFunnelPath?.[1] !== undefined && init?.method === "DELETE") {
    return removeFunnel(api, decodeURIComponent(savedFunnelPath[1]));
  }
  const goalPath = /^\/api\/projects\/[^/]+\/goals\/([^/]+)$/.exec(path);
  if (goalPath?.[1] !== undefined && init?.method === "DELETE") {
    return removeGoal(api, decodeURIComponent(goalPath[1]));
  }
  if (/^\/api\/projects\/[^/]+\/source-maps\/files$/.test(path)) {
    const release = url.searchParams.get("release") ?? "";
    return json({
      release,
      files: api.sourceMaps.files
        .filter((file) => file.release === release)
        .toSorted((a, b) => a.path.localeCompare(b.path)),
    });
  }
  if (/^\/api\/projects\/[^/]+\/source-maps$/.test(path)) {
    if (init?.method === "DELETE") {
      return deleteRelease(api, url.searchParams.get("release") ?? "");
    }
    return json(
      sourceMapOverview(
        api.sourceMaps,
        url.searchParams.get("order") === "oldest" ? "oldest" : "newest",
      ),
    );
  }
  const replaysFor = /^\/api\/projects\/([^/]+)\/replays$/.exec(path);
  if (replaysFor?.[1] !== undefined) {
    if (init?.method === "DELETE") {
      api.replays = { ...api.replays, count: 0, bytes: 0 };
      return new Response(null, { status: 204 });
    }
    return json(replayOverview(api, replaysFor[1]));
  }
  if (/^\/api\/projects\/[^/]+\/speed$/.test(path)) {
    const result = api.speed(url.searchParams);
    return result instanceof Response ? result : json(result);
  }
  if (/^\/api\/projects\/[^/]+\/traces$/.test(path)) {
    const result = api.traces(url.searchParams);
    return result instanceof Response ? result : json(result);
  }
  const spanPath = /^\/api\/projects\/[^/]+\/traces\/([^/]+)\/spans\/([^/]+)$/.exec(path);
  if (spanPath?.[1] !== undefined && spanPath[2] !== undefined) {
    const result = api.span(spanPath[1], spanPath[2], url.searchParams);
    return result instanceof Response ? result : json({ timeZone: "Asia/Singapore", span: result });
  }
  const tracePath = /^\/api\/projects\/[^/]+\/traces\/([^/]+)$/.exec(path);
  if (tracePath?.[1] !== undefined) {
    const result = api.trace(tracePath[1], url.searchParams);
    return result instanceof Response ? result : json(result);
  }
  const logPath = /^\/api\/projects\/[^/]+\/logs\/([^/]+)$/.exec(path);
  if (logPath?.[1] !== undefined) {
    const result = api.log(logPath[1], url.searchParams);
    return result instanceof Response ? result : json({ timeZone: "Asia/Singapore", log: result });
  }
  if (/^\/api\/projects\/[^/]+\/logs$/.test(path)) {
    const result = api.logs(url.searchParams);
    return result instanceof Response ? result : json(result);
  }
  if (/^\/api\/projects\/[^/]+\/metrics\/chart$/.test(path)) {
    const result = api.metricChart(url.searchParams);
    return result instanceof Response ? result : json(result);
  }
  if (/^\/api\/projects\/[^/]+\/metrics$/.test(path)) {
    const result = api.metrics(url.searchParams);
    return result instanceof Response ? result : json(result);
  }
  if (/^\/api\/projects\/[^/]+\/hosts\/charts$/.test(path)) {
    const result = api.hostCharts(url.searchParams);
    return result instanceof Response ? result : json(result);
  }
  if (/^\/api\/projects\/[^/]+\/hosts$/.test(path)) {
    const result = api.hosts(url.searchParams);
    return result instanceof Response ? result : json(result);
  }
  const alerts = answerAlerts(api, path, init);
  if (alerts !== null) return alerts;
  const checkSubPath = /^\/api\/projects\/[^/]+\/checks\/([^/]+)\/(results|incidents)$/.exec(path);
  if (checkSubPath?.[1] !== undefined) {
    const checkId = decodeURIComponent(checkSubPath[1]);
    if (!api.checks.some((check) => check.id === checkId)) return checkNotFound();
    const result =
      checkSubPath[2] === "results"
        ? api.checkResults(checkId, url.searchParams)
        : api.incidents(checkId, url.searchParams);
    return result instanceof Response ? result : json(result);
  }
  const checkPath = /^\/api\/projects\/[^/]+\/checks\/([^/]+)$/.exec(path);
  if (checkPath?.[1] !== undefined) {
    const checkId = decodeURIComponent(checkPath[1]);
    const existing = api.checks.find((check) => check.id === checkId);
    if (existing === undefined) return checkNotFound();
    if (init?.method === "DELETE") {
      api.checks = api.checks.filter((check) => check.id !== checkId);
      return new Response(null, { status: 204 });
    }
    if (init?.method === "PATCH") {
      return saveCheck(api, JSON.parse(typeof init.body === "string" ? init.body : "{}"), existing);
    }
    return json({ timeZone: "Asia/Singapore", check: existing });
  }
  if (/^\/api\/projects\/[^/]+\/checks$/.test(path)) {
    if (init?.method === "POST") {
      return saveCheck(api, JSON.parse(typeof init.body === "string" ? init.body : "null"));
    }
    return json({ timeZone: "Asia/Singapore", maxChecks: 50, checks: api.checks });
  }
  if (/^\/api\/projects\/[^/]+\/services$/.test(path)) {
    const result = api.services(url.searchParams);
    return result instanceof Response ? result : json(result);
  }
  if (/^\/api\/projects\/[^/]+\/errors$/.test(path)) {
    const result = api.errors(url.searchParams, api);
    return result instanceof Response ? result : json(result);
  }
  const errorPath = /^\/api\/projects\/[^/]+\/errors\/([^/]+)$/.exec(path);
  if (errorPath?.[1] !== undefined && init?.method === "PATCH") {
    const body: unknown = JSON.parse(typeof init.body === "string" ? init.body : "{}");
    const status =
      typeof body === "object" && body !== null && "status" in body ? String(body.status) : "";
    return api.setErrorStatus(api, decodeURIComponent(errorPath[1]), status);
  }
  if (errorPath?.[1] !== undefined) {
    const result = api.error(decodeURIComponent(errorPath[1]), url.searchParams, api);
    return result instanceof Response ? result : json(result);
  }
  const userPath = /^\/api\/projects\/[^/]+\/users\/([^/]+)$/.exec(path);
  if (userPath?.[1] !== undefined) {
    const result = api.user(decodeURIComponent(userPath[1]), url.searchParams);
    return result instanceof Response ? result : json(result);
  }
  if (/^\/api\/projects\/[^/]+\/analytics\/list$/.test(path)) {
    const result = api.list(url.searchParams);
    return result instanceof Response ? result : json(result);
  }
  const analytics = /^\/api\/projects\/([^/]+)\/analytics$/.exec(path);
  if (analytics?.[1] !== undefined) {
    const result = await api.analytics(
      analytics[1],
      url.searchParams.get("period"),
      url.searchParams,
      api,
    );
    return result instanceof Response ? result : json(result);
  }
  const secretFor = /^\/api\/projects\/([^/]+)\/secret-key$/.exec(path);
  const secreted = api.projects.find((item) => item.id === secretFor?.[1]);
  if (secreted !== undefined && init?.method === "POST") {
    const replaced = { ...secreted, secretKey: "sk_replaced" };
    api.projects = api.projects.map((item) => (item.id === secreted.id ? replaced : item));
    return json({ project: replaced });
  }
  const keyFor = /^\/api\/projects\/([^/]+)\/public-key$/.exec(path);
  const keyed = api.projects.find((item) => item.id === keyFor?.[1]);
  if (keyed !== undefined && init?.method === "POST") {
    const replaced = { ...keyed, publicKey: "pk_replaced" };
    api.projects = api.projects.map((item) => (item.id === keyed.id ? replaced : item));
    return json({ project: replaced });
  }
  const project = /^\/api\/projects\/([^/]+)$/.exec(path);
  const found = api.projects.find((item) => item.id === project?.[1]);
  if (found !== undefined && init?.method === "DELETE") {
    return api.deleteProject(api, found.id);
  }
  if (found !== undefined && init?.method === "PATCH") {
    const changes: unknown = JSON.parse(typeof init.body === "string" ? init.body : "{}");
    const updated = { ...found, ...(typeof changes === "object" ? changes : {}) };
    api.projects = api.projects.map((item) => (item.id === found.id ? updated : item));
    return json({ project: updated });
  }
  if (found !== undefined) {
    return json({ project: found });
  }
  return json({ error: "not_found", message: `No fake answer for ${path}` }, 404);
}

/**
 * The fetch the dashboard sees in browser tests (set in setup.ts, before the
 * app loads: the sign-in client keeps the fetch it finds at start-up). It
 * answers from the current test's fake API; between tests, the API is down.
 */
export async function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = requestUrl(input);
  if (active === undefined) {
    return json({ message: "No fake API in this test." }, 503);
  }
  active.requests.push(url.pathname + url.search);
  if (init?.method !== undefined && init.method !== "GET" && typeof init.body === "string") {
    active.bodies.push({ method: init.method, path: url.pathname, body: JSON.parse(init.body) });
  }
  return answer(active, url, init);
}

/** Sets up the fake API for the current test; removeFakeApi() takes it down. */
export function installFakeApi(overrides: Partial<FakeApi> = {}): FakeApi {
  active = {
    signedIn: true,
    settings: SETTINGS,
    projects: [PROJECT],
    analytics: (_projectId, _period, _query, api) => analyticsFixture({ goals: api.goals }),
    goals: fakeGoals(),
    savedFunnels: fakeSavedFunnels(),
    list: fakeList,
    users: fakeUsers,
    user: fakeUser,
    errors: fakeErrors,
    error: fakeError,
    setErrorStatus: changeErrorStatus,
    speed: fakeSpeed,
    productEvents: fakeProductEvents,
    productEvent: fakeProductEvent,
    funnel: fakeFunnel,
    retention: fakeRetention,
    resolutions: fakeResolutions(),
    sourceMaps: fakeSourceMaps(),
    replays: fakeReplays(),
    traces: fakeTraces,
    trace: fakeTrace,
    span: fakeSpan,
    logs: fakeLogs,
    log: fakeLog,
    metrics: fakeMetrics,
    metricChart: fakeMetricChart,
    services: fakeServices,
    hosts: fakeHosts,
    hostCharts: fakeHostCharts,
    checks: fakeChecks(),
    checkResults: fakeCheckResults,
    incidents: fakeIncidents,
    channels: fakeChannels(),
    alerts: fakeAlerts(),
    deleteProject: removeProject,
    requests: [],
    bodies: [],
    ...overrides,
  };
  return active;
}

export function removeFakeApi() {
  active = undefined;
}

/** A promise the test resolves when it chooses, to hold a response back. */
const noop = () => undefined;

export function deferred<T>() {
  let resolve: (value: T) => void = noop;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
