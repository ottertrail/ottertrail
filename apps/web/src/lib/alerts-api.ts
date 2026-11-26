import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";

import type { Area } from "./access";
import { apiRequest, expectShape } from "./api";
import type { Severity } from "./logs-api";
import { isMetricKind, type MetricKind } from "./metrics-api";
import { isListOf, isNumber, isRecord, isText, isTextOrNull } from "./telemetry-shapes";

/** Project alert rules (docs/uptime-alerts.md, "Alerts"; apps/api/src/alerts). */

/** The kinds of rule, in the order the form offers them. */
export const RULE_KINDS = [
  "check_down",
  "certificate_expiring",
  "error_new",
  "error_regressed",
  "error_spike",
  "route_latency",
  "route_failures",
  "metric_threshold",
  "ai_cost",
  "ai_failures",
  "ai_latency",
  "events_stopped",
  "telemetry_stopped",
  "log_lines",
] as const;
export type RuleKind = (typeof RULE_KINDS)[number];

export const isRuleKind = (value: unknown): value is RuleKind =>
  RULE_KINDS.some((kind) => kind === value);

export const KIND_LABEL: Record<RuleKind, string> = {
  check_down: "Check down",
  certificate_expiring: "Certificate expiring",
  error_new: "New error",
  error_regressed: "Regressed error",
  error_spike: "Error spike",
  route_latency: "Route latency",
  route_failures: "Route failures",
  metric_threshold: "Metric",
  ai_cost: "AI cost",
  ai_failures: "AI failures",
  ai_latency: "AI latency",
  events_stopped: "Data stops arriving",
  telemetry_stopped: "Data stops arriving",
  log_lines: "Log lines match",
};

export const TELEMETRY_KINDS: readonly RuleKind[] = [
  "route_latency",
  "route_failures",
  "metric_threshold",
  "ai_cost",
  "ai_failures",
  "ai_latency",
  "events_stopped",
  "telemetry_stopped",
  "log_lines",
];

/** The kinds that watch AI calls (docs/ai-usage.md, "Alerts"). */
export const isAiKind = (kind: RuleKind) =>
  kind === "ai_cost" || kind === "ai_failures" || kind === "ai_latency";

/**
 * "Data stops arriving": one kind in the form, two in the API, since events and telemetry
 * need different areas.
 */
export const isStoppedKind = (kind: RuleKind) =>
  kind === "events_stopped" || kind === "telemetry_stopped";

/**
 * The areas a kind watches, besides uptime and alerts (docs/access.md): a user sees and adds
 * such rules only with one of them. Check rules need none (empty).
 */
export function kindAreas(kind: RuleKind): readonly Area[] {
  if (kind === "error_new" || kind === "error_regressed" || kind === "error_spike") {
    return ["errors"];
  }
  if (isAiKind(kind)) return ["ai"];
  if (kind === "events_stopped") return ["web_analytics", "product_analytics"];
  return TELEMETRY_KINDS.includes(kind) ? ["monitoring"] : [];
}

/** What a "data stops arriving" rule counts. */
export const DATA_SOURCES = ["events", "traces", "logs", "metrics"] as const;
export type DataSource = (typeof DATA_SOURCES)[number];
export const kindOfSource = (source: DataSource): RuleKind =>
  source === "events" ? "events_stopped" : "telemetry_stopped";
/** Its windows, in minutes: 5 minutes to 24 hours. */
export const STOPPED_WINDOWS = [5, 10, 15, 30, 60, 120, 240, 360, 720, 1440] as const;
export const DEFAULT_STOPPED_WINDOW = 60;
export const DEFAULT_MIN_COUNT = 1;
export const MAX_MIN_COUNT = 1_000_000;
export const MAX_EVENT_NAME = 200;

/** A log lines rule: 5 minutes by default, more than 0 lines, of Error or above. */
export const DEFAULT_LOG_WINDOW = 5;
export const DEFAULT_MAX_COUNT = 0;
export const DEFAULT_LOG_SEVERITY: Severity = "error";

export const MAX_RULE_NAME = 100;
export const DEFAULT_CERTIFICATE_DAYS = 14;
export const MAX_CERTIFICATE_DAYS = 90;
export const MIN_WINDOW_MINUTES = 5;
export const MAX_WINDOW_MINUTES = 60;
export const DEFAULT_WINDOW_MINUTES = 10;
export const DEFAULT_THRESHOLD = 10;
export const MAX_THRESHOLD = 1_000_000;
export const DEFAULT_MIN_REQUESTS = 20;
export const MAX_MIN_REQUESTS = 1_000_000;
export const MAX_THRESHOLD_MS = 3_600_000;
/** A route rule's longest window, until the API keeps a per-minute rollup of requests. */
export const MAX_ROUTE_WINDOW_MINUTES = 30;
/** The longest route, host, or attribute value a rule names. */
export const MAX_FILTER_CHARS = 1000;
export const MAX_METRIC_VALUE = 1e15;
export const PERCENTILES = ["p95", "p99"] as const;
export type Percentile = (typeof PERCENTILES)[number];
export const DIRECTIONS = ["above", "below"] as const;
export type Direction = (typeof DIRECTIONS)[number];

/** "month" means the month so far. */
export const COST_WINDOWS = ["1h", "1d", "month"] as const;
export type CostWindow = (typeof COST_WINDOWS)[number];
export const DEFAULT_COST_WINDOW: CostWindow = "1d";
/** The highest cost an AI cost rule compares with, in US dollars. */
export const MAX_COST_USD = 1_000_000_000;
/** Calls an AI failures or latency rule's window needs before it judges (default), and at most. */
export const DEFAULT_MIN_CALLS = 20;
export const MAX_MIN_CALLS = 1_000_000;
/** The longest model or feature an AI rule names. */
export const MAX_AI_FILTER_CHARS = 100;

/** What a metric rule reads of each kind of metric, as its chart shows it; the first is the default. */
export const AGGREGATES = {
  gauge: ["avg", "min", "max"],
  counter: ["rate"],
  updown: ["sum"],
  histogram: ["p95", "p50", "p99"],
} as const satisfies Record<MetricKind, readonly string[]>;
export type Aggregate = (typeof AGGREGATES)[MetricKind][number];

/** Every kind's settings; each kind uses its own (null: all checks, environments, or groups). */
export interface RuleSettings {
  checkId?: string | null;
  days?: number;
  environment?: string | null;
  fingerprint?: string | null;
  windowMinutes?: number;
  threshold?: number;
  /** Route rules: the service, and its route or all (null). Traces and logs: the service or all. */
  service?: string | null;
  route?: string | null;
  minRequests?: number;
  percentile?: Percentile;
  thresholdMs?: number;
  thresholdPercent?: number;
  metric?: string | null;
  metricKind?: MetricKind;
  aggregate?: Aggregate;
  direction?: Direction;
  value?: number;
  host?: string | null;
  attributeKey?: string | null;
  attributeValue?: string | null;
  /** AI rules: the cost rule's window and threshold in US dollars, both kinds' feature and model (null: all), and the failures rule's fewest calls. */
  costWindow?: CostWindow;
  thresholdUsd?: number;
  feature?: string | null;
  model?: string | null;
  minCalls?: number;
  /** "Data stops arriving": the source, an event name (null: all), and the fewest records. */
  source?: DataSource;
  eventName?: string | null;
  minCount?: number;
  /** "Log lines match": the minimum severity (null: any), the words (null: any), and the most lines without an alert. */
  severity?: Severity | null;
  search?: string | null;
  maxCount?: number;
}

export interface Rule {
  id: string;
  name: string;
  kind: RuleKind;
  settings: RuleSettings;
  channelIds: string[];
  enabled: boolean;
  /** Why the server turned it off, such as its check being deleted. */
  disabledReason: string | null;
  /** A telemetry rule whose evaluations fail: why the last one did, and since when. */
  evaluationError: { message: string; since: string } | null;
  /** Subjects it fires for now. */
  firing: number;
  lastFiredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** GET /api/projects/:id/alert-rules */
export interface RuleList {
  timeZone: string;
  maxRules: number;
  hourlyCap: number;
  rules: Rule[];
}

export interface HistoryEntry {
  id: string;
  ruleId: string;
  ruleName: string;
  kind: string;
  subject: string;
  subjectName: string;
  firedAt: string;
  resolvedAt: string | null;
  message: string;
  /** false when the rule's hourly cap held its notification back. */
  notified: boolean;
}

/** A page of a project's (or a rule's) alerts: `next` asks for the following one. */
export interface HistoryPage {
  timeZone: string;
  retentionDays: number;
  alerts: HistoryEntry[];
  next: string | null;
}

export interface FiringAlert {
  ruleId: string;
  ruleName: string;
  kind: string;
  subject: string;
  subjectName: string;
  since: string;
  message: string;
}

export interface RuleFields {
  name: string;
  kind: RuleKind;
  settings: RuleSettings;
  channelIds: string[];
  enabled?: boolean;
}

const isNullableText = (value: unknown) => value === undefined || isTextOrNull(value);
const isOptionalNumber = (value: unknown) => value === undefined || isNumber(value);

const isOptionalOf =
  (values: readonly string[]) =>
  (value: unknown): boolean =>
    value === undefined || values.some((item) => item === value);
const ALL_AGGREGATES: readonly string[] = Object.values(AGGREGATES).flat();

const isSettings = (value: unknown): value is RuleSettings =>
  isRecord(value) &&
  isNullableText(value.checkId) &&
  isOptionalNumber(value.days) &&
  isNullableText(value.environment) &&
  isNullableText(value.fingerprint) &&
  isOptionalNumber(value.windowMinutes) &&
  isOptionalNumber(value.threshold) &&
  isNullableText(value.service) &&
  isNullableText(value.route) &&
  isOptionalNumber(value.minRequests) &&
  isOptionalOf(PERCENTILES)(value.percentile) &&
  isOptionalNumber(value.thresholdMs) &&
  isOptionalNumber(value.thresholdPercent) &&
  isNullableText(value.metric) &&
  (value.metricKind === undefined || isMetricKind(value.metricKind)) &&
  isOptionalOf(ALL_AGGREGATES)(value.aggregate) &&
  isOptionalOf(DIRECTIONS)(value.direction) &&
  isOptionalNumber(value.value) &&
  isNullableText(value.host) &&
  isNullableText(value.attributeKey) &&
  isNullableText(value.attributeValue) &&
  isOptionalOf(COST_WINDOWS)(value.costWindow) &&
  isOptionalNumber(value.thresholdUsd) &&
  isNullableText(value.feature) &&
  isNullableText(value.model) &&
  isOptionalNumber(value.minCalls) &&
  isOptionalOf(DATA_SOURCES)(value.source) &&
  isNullableText(value.eventName) &&
  isOptionalNumber(value.minCount);

export const isRule = (value: unknown): value is Rule =>
  isRecord(value) &&
  isText(value.id) &&
  isText(value.name) &&
  isRuleKind(value.kind) &&
  isSettings(value.settings) &&
  isListOf(value.channelIds, isText) &&
  typeof value.enabled === "boolean" &&
  isTextOrNull(value.disabledReason) &&
  (value.evaluationError === null ||
    (isRecord(value.evaluationError) &&
      isText(value.evaluationError.message) &&
      isText(value.evaluationError.since))) &&
  isNumber(value.firing) &&
  isTextOrNull(value.lastFiredAt) &&
  isText(value.createdAt) &&
  isText(value.updatedAt);

const isRuleList = (value: unknown): value is RuleList =>
  isRecord(value) &&
  isText(value.timeZone) &&
  isNumber(value.maxRules) &&
  isNumber(value.hourlyCap) &&
  isListOf(value.rules, isRule);

const isHistoryEntry = (value: unknown): value is HistoryEntry =>
  isRecord(value) &&
  isText(value.id) &&
  isText(value.ruleId) &&
  isText(value.ruleName) &&
  isText(value.kind) &&
  isText(value.subject) &&
  isText(value.subjectName) &&
  isText(value.firedAt) &&
  isTextOrNull(value.resolvedAt) &&
  isText(value.message) &&
  typeof value.notified === "boolean";

const isHistoryPage = (value: unknown): value is HistoryPage =>
  isRecord(value) &&
  isText(value.timeZone) &&
  isNumber(value.retentionDays) &&
  isListOf(value.alerts, isHistoryEntry) &&
  isTextOrNull(value.next);

const isFiring = (value: unknown): value is FiringAlert =>
  isRecord(value) &&
  isText(value.ruleId) &&
  isText(value.ruleName) &&
  isText(value.kind) &&
  isText(value.subject) &&
  isText(value.subjectName) &&
  isText(value.since) &&
  isText(value.message);

const projectPath = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}`;
const rulesPath = (projectId: string) => `${projectPath(projectId)}/alert-rules`;
const rulePath = (projectId: string, ruleId: string) =>
  `${rulesPath(projectId)}/${encodeURIComponent(ruleId)}`;

/**
 * Channel names from GET /api/projects/:id/alert-channels. Addresses, URLs, and secrets
 * are restricted to Settings (docs/access.md).
 */
export interface ChannelName {
  id: string;
  name: string;
  kind: "email" | "webhook";
}

const isChannelName = (value: unknown): value is ChannelName =>
  isRecord(value) &&
  isText(value.id) &&
  isText(value.name) &&
  (value.kind === "email" || value.kind === "webhook");

const isChannelNames = (value: unknown): value is { channels: ChannelName[] } =>
  isRecord(value) && isListOf(value.channels, isChannelName);

export const alertChannelsQuery = (projectId: string) =>
  queryOptions({
    queryKey: ["alert-channels", projectId],
    queryFn: async ({ signal }) =>
      expectShape(
        await apiRequest(`/api/projects/${encodeURIComponent(projectId)}/alert-channels`, {
          signal,
        }),
        isChannelNames,
      ),
  });

export const rulesQuery = (projectId: string) =>
  queryOptions({
    queryKey: ["alerts", projectId, "rules"],
    queryFn: async ({ signal }) =>
      expectShape(await apiRequest(rulesPath(projectId), { signal }), isRuleList),
    refetchInterval: 30_000,
  });

export const firingQuery = (projectId: string) =>
  queryOptions({
    queryKey: ["alerts", projectId, "firing"],
    queryFn: async ({ signal }) =>
      expectShape(
        await apiRequest(`${projectPath(projectId)}/alerts/firing`, { signal }),
        (value): value is { timeZone: string; alerts: FiringAlert[] } =>
          isRecord(value) && isText(value.timeZone) && isListOf(value.alerts, isFiring),
      ),
    refetchInterval: 30_000,
  });

/** The project's alerts, newest first, 20 at a time. */
export const historyQuery = (projectId: string) =>
  infiniteQueryOptions({
    queryKey: ["alerts", projectId, "history"],
    initialPageParam: "",
    queryFn: async ({ pageParam, signal }) =>
      expectShape(
        await apiRequest(
          `${projectPath(projectId)}/alerts${pageParam === "" ? "" : `?before=${encodeURIComponent(pageParam)}`}`,
          { signal },
        ),
        isHistoryPage,
      ),
    getNextPageParam: (last) => last.next ?? undefined,
    refetchInterval: 30_000,
  });

/** One rule's alerts, newest first, 20 at a time (GET …/alert-rules/:ruleId/history). */
export const ruleHistoryQuery = (projectId: string, ruleId: string) =>
  infiniteQueryOptions({
    queryKey: ["alerts", projectId, "history", ruleId],
    initialPageParam: "",
    queryFn: async ({ pageParam, signal }) =>
      expectShape(
        await apiRequest(
          `${rulePath(projectId, ruleId)}/history${pageParam === "" ? "" : `?before=${encodeURIComponent(pageParam)}`}`,
          { signal },
        ),
        isHistoryPage,
      ),
    getNextPageParam: (last) => last.next ?? undefined,
    refetchInterval: 30_000,
  });

/**
 * Why a telemetry rule just saved may not fire yet: what it watches has
 * not reported in the last day ("not_seen"), or that could not be checked.
 */
export interface SaveWarning {
  reason: "not_seen" | "not_checked";
  message: string;
}

/** A rule just saved, with its warning (null when there is nothing to say). */
export interface SavedRule {
  rule: Rule;
  warning: SaveWarning | null;
}

const isWarning = (value: unknown): value is SaveWarning =>
  isRecord(value) &&
  (value.reason === "not_seen" || value.reason === "not_checked") &&
  isText(value.message);

const ruleBody = (value: unknown): value is SavedRule =>
  isRecord(value) &&
  isRule(value.rule) &&
  (value.warning === undefined || value.warning === null || isWarning(value.warning));

const savedOf = (value: SavedRule): SavedRule => ({
  rule: value.rule,
  warning: value.warning ?? null,
});

export async function createRule(projectId: string, fields: RuleFields): Promise<SavedRule> {
  return savedOf(
    expectShape(await apiRequest(rulesPath(projectId), { method: "POST", body: fields }), ruleBody),
  );
}

export async function updateRule(
  projectId: string,
  ruleId: string,
  changes: Partial<RuleFields>,
): Promise<SavedRule> {
  return savedOf(
    expectShape(
      await apiRequest(rulePath(projectId, ruleId), { method: "PATCH", body: changes }),
      ruleBody,
    ),
  );
}

export async function deleteRule(projectId: string, ruleId: string): Promise<void> {
  await apiRequest(rulePath(projectId, ruleId), { method: "DELETE" });
}

/** Whether a rule watches this check: it names it, or watches all the project's checks. */
export function watchesCheck(rule: Rule, checkId: string): boolean {
  if (rule.kind !== "check_down" && rule.kind !== "certificate_expiring") return false;
  const watched = rule.settings.checkId ?? null;
  return watched === null || watched === checkId;
}

/**
 * Whether a rule watches this error group in this environment: a
 * regressed-error rule watches every group; a spike rule its group or all,
 * in its environment or all. A new-error rule watches groups not seen yet,
 * so never one that has a page.
 */
export function watchesError(rule: Rule, fingerprint: string, environment: string): boolean {
  if (rule.kind === "error_regressed") return true;
  if (rule.kind !== "error_spike") return false;
  const { fingerprint: group = null, environment: env = null } = rule.settings;
  return (group === null || group === fingerprint) && (env === null || env === environment);
}
