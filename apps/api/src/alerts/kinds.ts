import { Buffer } from "node:buffer";

import type { Area } from "../access/areas.ts";
import { DEFAULT_ENVIRONMENT, ENVIRONMENT_PATTERN } from "../collection/environment.ts";
import { EVENT_NAME_SCHEMA } from "../collection/routes.ts";
import { FINGERPRINT_PATTERN } from "../errors/fingerprint.ts";
import type { EventType } from "../notifications/events.ts";
import type { Problem } from "../outbound/url.ts";
import { SERVICE_PATTERN } from "../telemetry/dashboard-query.ts";
import { METRIC_KINDS, type MetricKind } from "../telemetry/metrics.ts";
import { MAX_KEY_CHARS, MAX_NAME_BYTES } from "../telemetry/normalize.ts";

/**
 * Shared rule definitions for API validation and dashboard labels (docs/uptime-alerts.md,
 * "Alerts").
 */
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
] as const;

export type RuleKind = (typeof RULE_KINDS)[number];

export const isRuleKind = (value: unknown): value is RuleKind =>
  RULE_KINDS.some((kind) => kind === value);

export const KIND_INFO: Record<
  RuleKind,
  {
    label: string;
    /**
     * Where it is evaluated: from the checker (checks), from the error
     * list's data each minute (errors), or from spans and metrics each
     * minute, a few rules at a time (telemetry).
     */
    source: "checks" | "errors" | "telemetry";
    fires: EventType;
    /** null: the kind fires once per subject and never resolves. */
    resolves: EventType | null;
  }
> = {
  check_down: { label: "Check down", source: "checks", fires: "check.down", resolves: "check.up" },
  certificate_expiring: {
    label: "Certificate expiring",
    source: "checks",
    fires: "certificate.expiring",
    resolves: "certificate.renewed",
  },
  error_new: { label: "New error", source: "errors", fires: "error.new", resolves: null },
  error_regressed: {
    label: "Regressed error",
    source: "errors",
    fires: "error.regressed",
    resolves: null,
  },
  error_spike: {
    label: "Error spike",
    source: "errors",
    fires: "error.spike",
    resolves: "error.spike_resolved",
  },
  route_latency: {
    label: "Route latency",
    source: "telemetry",
    fires: "route.latency",
    resolves: "route.latency_resolved",
  },
  route_failures: {
    label: "Route failures",
    source: "telemetry",
    fires: "route.failures",
    resolves: "route.failures_resolved",
  },
  metric_threshold: {
    label: "Metric",
    source: "telemetry",
    fires: "metric.threshold",
    resolves: "metric.threshold_resolved",
  },
  ai_cost: {
    label: "AI cost",
    source: "telemetry",
    fires: "ai.cost",
    resolves: "ai.cost_resolved",
  },
  ai_failures: {
    label: "AI failures",
    source: "telemetry",
    fires: "ai.failures",
    resolves: "ai.failures_resolved",
  },
  ai_latency: {
    label: "AI latency",
    source: "telemetry",
    fires: "ai.latency",
    resolves: "ai.latency_resolved",
  },
  // Two kinds, one name: events and telemetry need different areas (sourceAreasOf).
  events_stopped: {
    label: "Data stops arriving",
    source: "telemetry",
    fires: "data.stopped",
    resolves: "data.stopped_resolved",
  },
  telemetry_stopped: {
    label: "Data stops arriving",
    source: "telemetry",
    fires: "data.stopped",
    resolves: "data.stopped_resolved",
  },
};

/** The kinds the worker evaluates from spans and metrics (alerts/telemetry-rules.ts). */
export const TELEMETRY_KINDS = RULE_KINDS.filter((kind) => KIND_INFO[kind].source === "telemetry");

export const MAX_RULES = 50;
export const MAX_RULE_NAME = 100;
/** Channels a rule sends to at most: as many as an instance may have. */
export const MAX_RULE_CHANNELS = 20;
export const DEFAULT_CERTIFICATE_DAYS = 14;
export const MAX_CERTIFICATE_DAYS = 90;
export const MIN_WINDOW_MINUTES = 5;
export const MAX_WINDOW_MINUTES = 60;
export const DEFAULT_WINDOW_MINUTES = 10;
export const DEFAULT_THRESHOLD = 10;
export const MAX_THRESHOLD = 1_000_000;
/** Requests a route rule's window needs before it judges (default), and at most. */
export const DEFAULT_MIN_REQUESTS = 20;
export const MAX_MIN_REQUESTS = 1_000_000;
/** The highest latency threshold: an hour, in milliseconds. */
export const MAX_THRESHOLD_MS = 3_600_000;
/**
 * Cap route windows until per-minute rollups exist: each query reads all project spans in the
 * window. See docs/uptime-alerts.md, step 4.
 */
export const MAX_ROUTE_WINDOW_MINUTES = 30;
/** Limit values used in notification links, which allow at most 2,048 characters. */
export const MAX_FILTER_CHARS = 1000;
export const MAX_METRIC_VALUE = 1e15;
export const PERCENTILES = ["p95", "p99"] as const;
export type Percentile = (typeof PERCENTILES)[number];
export const DIRECTIONS = ["above", "below"] as const;
export type Direction = (typeof DIRECTIONS)[number];
/** What a metric rule reads of each kind of metric, as its chart shows it; the first is the default. */
export const AGGREGATES = {
  gauge: ["avg", "min", "max"],
  counter: ["rate"],
  updown: ["sum"],
  histogram: ["p95", "p50", "p99"],
} as const satisfies Record<MetricKind, readonly string[]>;
export type Aggregate = (typeof AGGREGATES)[MetricKind][number];
const ALL_AGGREGATES = [...new Set(Object.values(AGGREGATES).flat())];

export const COST_WINDOWS = ["1h", "1d", "month"] as const;
export type CostWindow = (typeof COST_WINDOWS)[number];
export const MAX_COST_USD = 1_000_000_000;
/** Calls an AI failures or latency rule's window needs before it judges (default), and at most. */
export const DEFAULT_MIN_CALLS = 20;
export const MAX_MIN_CALLS = 1_000_000;
/** How long an AI cost rule's cost stays at or below its value before the alert resolves. */
export const COST_CLEAR_MINUTES = 60;
/** The longest model or feature an AI rule names: what ai_calls holds (ai/calls.ts). */
export const MAX_AI_FILTER_CHARS = 100;

/** What a "data stops arriving" rule counts: events for events_stopped, the rest for telemetry_stopped. */
export const DATA_SOURCES = ["events", "traces", "logs", "metrics"] as const;
export type DataSource = (typeof DATA_SOURCES)[number];
export const TELEMETRY_SOURCES = ["traces", "logs", "metrics"] as const;
/** The windows a "data stops arriving" rule offers, in minutes: 5 minutes to 24 hours. */
export const STOPPED_WINDOWS = [5, 10, 15, 30, 60, 120, 240, 360, 720, 1440] as const;
export const DEFAULT_STOPPED_WINDOW = 60;
export const MAX_STOPPED_WINDOW = 1440;
/** Fires below this many records in the window; 1 is "nothing arrived". */
export const DEFAULT_MIN_COUNT = 1;
export const MAX_MIN_COUNT = 1_000_000;
/** The longest event name collection takes (collection/routes.ts, EVENT_NAME_SCHEMA). */
export const MAX_EVENT_NAME = 200;

/** Each kind's settings, as stored and answered. null: all (checks, environments, groups). */
export interface CheckDownSettings {
  checkId: string | null;
}
export interface CertificateSettings {
  checkId: string | null;
  days: number;
}
export interface NewErrorSettings {
  environment: string | null;
}
export type RegressedErrorSettings = Record<string, never>;
export interface SpikeSettings {
  environment: string | null;
  fingerprint: string | null;
  windowMinutes: number;
  threshold: number;
}

/** A route rule's requests: one service's, in one environment, of one route or all (null). */
interface RouteScope {
  environment: string;
  service: string;
  route: string | null;
  windowMinutes: number;
  /** Fewer requests in the window: the rule does not judge it (as no data). */
  minRequests: number;
}
export interface LatencySettings extends RouteScope {
  percentile: Percentile;
  thresholdMs: number;
}
export interface FailureSettings extends RouteScope {
  thresholdPercent: number;
}
export interface MetricSettings {
  environment: string;
  metric: string;
  metricKind: MetricKind;
  aggregate: Aggregate;
  direction: Direction;
  value: number;
  windowMinutes: number;
  /** One host's series only: its resource's host.name. */
  host: string | null;
  /** One attribute value's points only: both, or neither. */
  attributeKey: string | null;
  attributeValue: string | null;
}

/**
 * An AI rule's calls: one environment's, of one feature and one model, or
 * all (null). A feature of "" is the calls that name none ("Unlabeled").
 */
interface AiScope {
  environment: string;
  feature: string | null;
  model: string | null;
}
export interface AiCostSettings extends AiScope {
  costWindow: CostWindow;
  /** Fires when the window's estimated cost is above this, in US dollars. */
  thresholdUsd: number;
}
export interface AiFailureSettings extends AiScope {
  windowMinutes: number;
  /** Fires when the failed share is above this, 0 to 100. */
  thresholdPercent: number;
  /** Fewer calls in the window: the rule does not judge it (as no data). */
  minCalls: number;
}
export interface AiLatencySettings extends AiScope {
  windowMinutes: number;
  /** Fires when the calls' 95th-percentile duration is above this many milliseconds. */
  thresholdMs: number;
  /** Fewer calls in the window: the rule does not judge it (as no data). */
  minCalls: number;
}

/**
 * A "data stops arriving" rule: one source in one environment, optionally narrowed to an event
 * name, a service (traces, logs), or a metric (required) and its host. Other sources' fields
 * are null.
 */
export interface StoppedSettings {
  source: DataSource;
  environment: string;
  eventName: string | null;
  service: string | null;
  metric: string | null;
  host: string | null;
  windowMinutes: number;
  /** Fires when fewer records than this arrived in the window. */
  minCount: number;
}

export type RuleSettings =
  | CheckDownSettings
  | CertificateSettings
  | NewErrorSettings
  | RegressedErrorSettings
  | SpikeSettings
  | LatencySettings
  | FailureSettings
  | MetricSettings
  | AiCostSettings
  | AiFailureSettings
  | AiLatencySettings
  | StoppedSettings;

/** What the API takes as settings: every kind's fields, each optional. */
export interface SettingsInput {
  checkId?: string | null | undefined;
  days?: number | undefined;
  environment?: string | null | undefined;
  fingerprint?: string | null | undefined;
  windowMinutes?: number | undefined;
  threshold?: number | undefined;
  service?: string | null | undefined;
  route?: string | null | undefined;
  minRequests?: number | undefined;
  percentile?: string | undefined;
  thresholdMs?: number | undefined;
  thresholdPercent?: number | undefined;
  metric?: string | null | undefined;
  metricKind?: string | undefined;
  aggregate?: string | undefined;
  direction?: string | undefined;
  value?: number | undefined;
  host?: string | null | undefined;
  attributeKey?: string | null | undefined;
  attributeValue?: string | null | undefined;
  costWindow?: string | undefined;
  thresholdUsd?: number | undefined;
  feature?: string | null | undefined;
  model?: string | null | undefined;
  minCalls?: number | undefined;
  source?: string | undefined;
  eventName?: string | null | undefined;
  minCount?: number | undefined;
}

/** The fields Fastify's schema takes in `settings`, for every kind; settingsOf checks each kind's. */
export const SETTINGS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    checkId: {
      type: ["string", "null"],
      pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
    },
    days: { type: "integer", minimum: 1, maximum: MAX_CERTIFICATE_DAYS },
    environment: { type: ["string", "null"], pattern: ENVIRONMENT_PATTERN },
    fingerprint: { type: ["string", "null"], pattern: FINGERPRINT_PATTERN },
    // Up to a day for "data stops arriving"; settingsOf narrows it for the other kinds.
    windowMinutes: { type: "integer", minimum: MIN_WINDOW_MINUTES, maximum: MAX_STOPPED_WINDOW },
    threshold: { type: "integer", minimum: 1, maximum: MAX_THRESHOLD },
    service: { type: ["string", "null"], pattern: SERVICE_PATTERN },
    // A route is an attribute's value or a span's name, as stored: at most 4 KB.
    route: { type: ["string", "null"], minLength: 1, maxLength: MAX_FILTER_CHARS },
    minRequests: { type: "integer", minimum: 1, maximum: MAX_MIN_REQUESTS },
    percentile: { type: "string", enum: [...PERCENTILES] },
    thresholdMs: { type: "number", exclusiveMinimum: 0, maximum: MAX_THRESHOLD_MS },
    thresholdPercent: { type: "number", minimum: 0, maximum: 100 },
    metric: { type: "string", minLength: 1, maxLength: MAX_NAME_BYTES },
    metricKind: { type: "string", enum: [...METRIC_KINDS] },
    aggregate: { type: "string", enum: ALL_AGGREGATES },
    direction: { type: "string", enum: [...DIRECTIONS] },
    value: { type: "number", minimum: -MAX_METRIC_VALUE, maximum: MAX_METRIC_VALUE },
    host: { type: ["string", "null"], maxLength: MAX_FILTER_CHARS },
    attributeKey: { type: ["string", "null"], maxLength: MAX_KEY_CHARS },
    attributeValue: { type: ["string", "null"], maxLength: MAX_FILTER_CHARS },
    costWindow: { type: "string", enum: [...COST_WINDOWS] },
    thresholdUsd: { type: "number", exclusiveMinimum: 0, maximum: MAX_COST_USD },
    feature: { type: ["string", "null"], maxLength: MAX_AI_FILTER_CHARS },
    model: { type: ["string", "null"], maxLength: MAX_AI_FILTER_CHARS },
    minCalls: { type: "integer", minimum: 1, maximum: MAX_MIN_CALLS },
    source: { type: "string", enum: [...DATA_SOURCES] },
    eventName: { ...EVENT_NAME_SCHEMA, type: ["string", "null"] },
    minCount: { type: "integer", minimum: 1, maximum: MAX_MIN_COUNT },
  },
} as const;

const environmentOf = (value: string | null | undefined) =>
  value === undefined || value === null || value === "" ? null : value.toLowerCase();

/**
 * A kind's settings from what was sent over `base` (the rule's current
 * ones, when it keeps its kind), with defaults; or the first problem.
 * Fields of other kinds are ignored. Fastify's schema has checked types
 * and bounds; this words what it cannot.
 */
export function settingsOf(
  kind: RuleKind,
  input: SettingsInput,
  base: Partial<SettingsInput> = {},
): RuleSettings | Problem {
  const pick = <K extends keyof SettingsInput>(key: K): SettingsInput[K] =>
    input[key] === undefined ? base[key] : input[key];
  const checkId = pick("checkId")?.toLowerCase() ?? null;
  if (kind === "check_down") return { checkId };
  if (kind === "certificate_expiring") {
    const days = pick("days") ?? DEFAULT_CERTIFICATE_DAYS;
    if (!Number.isInteger(days) || days < 1 || days > MAX_CERTIFICATE_DAYS) {
      return {
        error: "invalid_days",
        message: `Warn 1 to ${MAX_CERTIFICATE_DAYS} days before a certificate expires.`,
      };
    }
    return { checkId, days };
  }
  if (kind === "error_new") return { environment: environmentOf(pick("environment")) };
  if (kind === "error_regressed") return {};
  if (kind === "ai_cost") return aiCostSettingsOf(pick);
  if (kind === "events_stopped" || kind === "telemetry_stopped") {
    return stoppedSettingsOf(kind, pick);
  }
  const windowMinutes = windowOf(pick("windowMinutes"));
  if (typeof windowMinutes !== "number") return windowMinutes;
  if (kind === "route_latency" || kind === "route_failures") {
    return routeSettingsOf(kind, pick, windowMinutes);
  }
  if (kind === "metric_threshold") return metricSettingsOf(pick, windowMinutes);
  if (kind === "ai_failures") return aiFailureSettingsOf(pick, windowMinutes);
  if (kind === "ai_latency") return aiLatencySettingsOf(pick, windowMinutes);
  const threshold = pick("threshold") ?? DEFAULT_THRESHOLD;
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > MAX_THRESHOLD) {
    return {
      error: "invalid_threshold",
      message: `The threshold is a whole number of errors from 1 to ${MAX_THRESHOLD.toLocaleString("en")}.`,
    };
  }
  return {
    environment: environmentOf(pick("environment")),
    fingerprint: pick("fingerprint") ?? null,
    windowMinutes,
    threshold,
  };
}

type Picker = <K extends keyof SettingsInput>(key: K) => SettingsInput[K];

/** A window from what was sent, 10 minutes by default; or the problem. */
function windowOf(sent: number | undefined): number | Problem {
  const windowMinutes = sent ?? DEFAULT_WINDOW_MINUTES;
  if (
    !Number.isInteger(windowMinutes) ||
    windowMinutes < MIN_WINDOW_MINUTES ||
    windowMinutes > MAX_WINDOW_MINUTES
  ) {
    return {
      error: "invalid_window",
      message: `The window is ${MIN_WINDOW_MINUTES} to ${MAX_WINDOW_MINUTES} minutes.`,
    };
  }
  return windowMinutes;
}

/** A telemetry rule's environment: one, production when none was sent; as stored, lower case. */
const telemetryEnvironmentOf = (value: string | null | undefined) =>
  environmentOf(value) ?? DEFAULT_ENVIRONMENT;

const fits = (text: string, bytes: number) => Buffer.byteLength(text) <= bytes;

/** Text sent for an optional filter: null when empty. */
const optionalText = (value: string | null | undefined) =>
  value === undefined || value === null || value === "" ? null : value;

function routeSettingsOf(
  kind: "route_latency" | "route_failures",
  pick: Picker,
  windowMinutes: number,
): LatencySettings | FailureSettings | Problem {
  const service = pick("service");
  if (service === undefined || service === null || service === "") {
    return {
      error: "invalid_service",
      message: "Choose the service whose requests the rule monitors.",
    };
  }
  const route = optionalText(pick("route"));
  if (route !== null && route.length > MAX_FILTER_CHARS) {
    return {
      error: "invalid_route",
      message: `A route has at most ${MAX_FILTER_CHARS.toLocaleString("en")} characters.`,
    };
  }
  if (windowMinutes > MAX_ROUTE_WINDOW_MINUTES) {
    return {
      error: "invalid_window",
      message: `A route rule's window is ${MIN_WINDOW_MINUTES} to ${MAX_ROUTE_WINDOW_MINUTES} minutes.`,
    };
  }
  const minRequests = pick("minRequests") ?? DEFAULT_MIN_REQUESTS;
  if (!Number.isInteger(minRequests) || minRequests < 1 || minRequests > MAX_MIN_REQUESTS) {
    return {
      error: "invalid_min_requests",
      message: `The fewest requests is a whole number from 1 to ${MAX_MIN_REQUESTS.toLocaleString("en")}.`,
    };
  }
  const scope = {
    environment: telemetryEnvironmentOf(pick("environment")),
    service,
    route,
    windowMinutes,
    minRequests,
  };
  if (kind === "route_latency") {
    const percentile = PERCENTILES.find((item) => item === (pick("percentile") ?? "p95"));
    if (percentile === undefined) {
      return { error: "invalid_percentile", message: "Choose the 95th or 99th percentile." };
    }
    const thresholdMs = pick("thresholdMs");
    if (
      thresholdMs === undefined ||
      !Number.isFinite(thresholdMs) ||
      thresholdMs <= 0 ||
      thresholdMs > MAX_THRESHOLD_MS
    ) {
      return {
        error: "invalid_threshold",
        message: `The threshold is a duration above 0 and at most ${MAX_THRESHOLD_MS.toLocaleString("en")} milliseconds.`,
      };
    }
    return { ...scope, percentile, thresholdMs };
  }
  const thresholdPercent = pick("thresholdPercent");
  if (
    thresholdPercent === undefined ||
    !Number.isFinite(thresholdPercent) ||
    thresholdPercent < 0 ||
    thresholdPercent >= 100
  ) {
    return {
      error: "invalid_threshold",
      message: "The threshold is a share of requests from 0 to just under 100 percent.",
    };
  }
  return { ...scope, thresholdPercent };
}

function metricSettingsOf(pick: Picker, windowMinutes: number): MetricSettings | Problem {
  const metric = pick("metric");
  if (metric === undefined || metric === null || metric === "" || !fits(metric, MAX_NAME_BYTES)) {
    return {
      error: "invalid_metric",
      message: `Choose the metric the rule monitors. A name contains at most ${MAX_NAME_BYTES} bytes.`,
    };
  }
  const metricKind = METRIC_KINDS.find((item) => item === pick("metricKind"));
  if (metricKind === undefined) {
    return { error: "invalid_metric_kind", message: "Select the metric kind." };
  }
  const offered: readonly string[] = AGGREGATES[metricKind];
  const aggregate = ALL_AGGREGATES.find((item) => item === (pick("aggregate") ?? offered[0]));
  if (aggregate === undefined || !offered.includes(aggregate)) {
    return {
      error: "invalid_aggregate",
      message: `A ${metricKind} is read as ${offered.join(", ")}.`,
    };
  }
  const direction = DIRECTIONS.find((item) => item === (pick("direction") ?? "above"));
  if (direction === undefined) {
    return { error: "invalid_direction", message: "Choose above or below." };
  }
  const value = pick("value");
  if (value === undefined || !Number.isFinite(value) || Math.abs(value) > MAX_METRIC_VALUE) {
    return {
      error: "invalid_threshold",
      message:
        "Enter the comparison value. Use a number with at most 15 digits. Negative values are allowed.",
    };
  }
  const host = optionalText(pick("host"));
  const attributeKey = optionalText(pick("attributeKey"));
  const attributeValue = attributeKey === null ? null : (pick("attributeValue") ?? null);
  if (attributeKey !== null && attributeValue === null) {
    return { error: "invalid_attribute", message: "Enter the attribute's value too." };
  }
  if (
    (host !== null && host.length > MAX_FILTER_CHARS) ||
    (attributeValue !== null && attributeValue.length > MAX_FILTER_CHARS)
  ) {
    return {
      error: "invalid_attribute",
      message: `A host's name or an attribute's value has at most ${MAX_FILTER_CHARS.toLocaleString("en")} characters.`,
    };
  }
  return {
    environment: telemetryEnvironmentOf(pick("environment")),
    metric,
    metricKind,
    aggregate,
    direction,
    value,
    windowMinutes,
    host,
    attributeKey,
    attributeValue,
  };
}

const sourcesOf = (kind: "events_stopped" | "telemetry_stopped"): readonly DataSource[] =>
  kind === "events_stopped" ? ["events"] : TELEMETRY_SOURCES;

function stoppedSettingsOf(
  kind: "events_stopped" | "telemetry_stopped",
  pick: Picker,
): StoppedSettings | Problem {
  const offered = sourcesOf(kind);
  const source = offered.find((item) => item === (pick("source") ?? offered[0]));
  if (source === undefined) {
    return {
      error: "invalid_source",
      message:
        kind === "events_stopped"
          ? "An events rule counts events."
          : "Choose traces, logs, or metrics.",
    };
  }
  const windowMinutes = pick("windowMinutes") ?? DEFAULT_STOPPED_WINDOW;
  if (!STOPPED_WINDOWS.some((item) => item === windowMinutes)) {
    return {
      error: "invalid_window",
      message: `Choose a window of ${STOPPED_WINDOWS.join(", ")} minutes.`,
    };
  }
  const minCount = pick("minCount") ?? DEFAULT_MIN_COUNT;
  if (!Number.isInteger(minCount) || minCount < 1 || minCount > MAX_MIN_COUNT) {
    return {
      error: "invalid_min_count",
      message: `The fewest records is a whole number from 1 to ${MAX_MIN_COUNT.toLocaleString("en")}.`,
    };
  }
  const settings: StoppedSettings = {
    source,
    environment: telemetryEnvironmentOf(pick("environment")),
    eventName: null,
    service: null,
    metric: null,
    host: null,
    windowMinutes,
    minCount,
  };
  if (source === "events") return { ...settings, eventName: optionalText(pick("eventName")) };
  if (source !== "metrics") return { ...settings, service: optionalText(pick("service")) };
  const metric = pick("metric");
  if (metric === undefined || metric === null || metric === "" || !fits(metric, MAX_NAME_BYTES)) {
    return {
      error: "invalid_metric",
      message: `Choose the metric the rule monitors. A name contains at most ${MAX_NAME_BYTES} bytes.`,
    };
  }
  const host = optionalText(pick("host"));
  if (host !== null && host.length > MAX_FILTER_CHARS) {
    return {
      error: "invalid_attribute",
      message: `A host's name has at most ${MAX_FILTER_CHARS.toLocaleString("en")} characters.`,
    };
  }
  return { ...settings, metric, host };
}

/** An AI rule's environment, feature, and model; or the problem. */
function aiScopeOf(pick: Picker): AiScope | Problem {
  // "" is the calls that name no feature, as the AI page's feature= is; null is all.
  const feature = pick("feature") ?? null;
  const model = optionalText(pick("model"));
  if (
    (feature !== null && feature.length > MAX_AI_FILTER_CHARS) ||
    (model !== null && model.length > MAX_AI_FILTER_CHARS)
  ) {
    return {
      error: "invalid_filter",
      message: `A feature or a model has at most ${MAX_AI_FILTER_CHARS} characters.`,
    };
  }
  return { environment: telemetryEnvironmentOf(pick("environment")), feature, model };
}

function aiCostSettingsOf(pick: Picker): AiCostSettings | Problem {
  const scope = aiScopeOf(pick);
  if ("error" in scope) return scope;
  const costWindow = COST_WINDOWS.find((item) => item === (pick("costWindow") ?? "1d"));
  if (costWindow === undefined) {
    return {
      error: "invalid_window",
      message: "Choose the last hour, the last 24 hours, or the month so far.",
    };
  }
  const thresholdUsd = pick("thresholdUsd");
  if (
    thresholdUsd === undefined ||
    !Number.isFinite(thresholdUsd) ||
    thresholdUsd <= 0 ||
    thresholdUsd > MAX_COST_USD
  ) {
    return {
      error: "invalid_threshold",
      message: `The threshold is an amount in US dollars above 0 and at most ${MAX_COST_USD.toLocaleString("en")}.`,
    };
  }
  return { ...scope, costWindow, thresholdUsd };
}

function aiFailureSettingsOf(pick: Picker, windowMinutes: number): AiFailureSettings | Problem {
  const scope = aiScopeOf(pick);
  if ("error" in scope) return scope;
  const thresholdPercent = pick("thresholdPercent");
  if (
    thresholdPercent === undefined ||
    !Number.isFinite(thresholdPercent) ||
    thresholdPercent < 0 ||
    thresholdPercent >= 100
  ) {
    return {
      error: "invalid_threshold",
      message: "The threshold is a share of calls from 0 to just under 100 percent.",
    };
  }
  const minCalls = minCallsOf(pick);
  if (typeof minCalls !== "number") return minCalls;
  return { ...scope, windowMinutes, thresholdPercent, minCalls };
}

function aiLatencySettingsOf(pick: Picker, windowMinutes: number): AiLatencySettings | Problem {
  const scope = aiScopeOf(pick);
  if ("error" in scope) return scope;
  const thresholdMs = pick("thresholdMs");
  if (
    thresholdMs === undefined ||
    !Number.isFinite(thresholdMs) ||
    thresholdMs <= 0 ||
    thresholdMs > MAX_THRESHOLD_MS
  ) {
    return {
      error: "invalid_threshold",
      message: `The threshold is a duration above 0 and at most ${MAX_THRESHOLD_MS.toLocaleString("en")} milliseconds.`,
    };
  }
  const minCalls = minCallsOf(pick);
  if (typeof minCalls !== "number") return minCalls;
  return { ...scope, windowMinutes, thresholdMs, minCalls };
}

/** An AI rule's fewest calls, 20 by default; or the problem. */
function minCallsOf(pick: Picker): number | Problem {
  const minCalls = pick("minCalls") ?? DEFAULT_MIN_CALLS;
  if (!Number.isInteger(minCalls) || minCalls < 1 || minCalls > MAX_MIN_CALLS) {
    return {
      error: "invalid_min_calls",
      message: `The fewest calls is a whole number from 1 to ${MAX_MIN_CALLS.toLocaleString("en")}.`,
    };
  }
  return minCalls;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const textOrNull = (value: unknown) => (typeof value === "string" ? value : null);
const numberOr = (value: unknown, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const storedRecord = (value: unknown) => (isRecord(value) ? value : {});

/** A stored "new error" rule's settings (the API wrote them). */
export function newErrorSettingsOf(value: unknown): NewErrorSettings {
  return { environment: textOrNull(storedRecord(value).environment) };
}

/** A stored "error spike" rule's settings (the API wrote them). */
export function spikeSettingsOf(value: unknown): SpikeSettings {
  const stored = storedRecord(value);
  return {
    environment: textOrNull(stored.environment),
    fingerprint: textOrNull(stored.fingerprint),
    windowMinutes: numberOr(stored.windowMinutes, DEFAULT_WINDOW_MINUTES),
    threshold: numberOr(stored.threshold, DEFAULT_THRESHOLD),
  };
}

export function storedSettings(kind: RuleKind, value: unknown): RuleSettings {
  const stored = storedRecord(value);
  if (kind === "check_down") return { checkId: textOrNull(stored.checkId) };
  if (kind === "certificate_expiring") {
    return {
      checkId: textOrNull(stored.checkId),
      days: numberOr(stored.days, DEFAULT_CERTIFICATE_DAYS),
    };
  }
  if (kind === "error_new") return newErrorSettingsOf(value);
  if (kind === "error_regressed") return {};
  if (kind === "route_latency") return latencySettingsOf(value);
  if (kind === "route_failures") return failureSettingsOf(value);
  if (kind === "metric_threshold") return metricSettingsStored(value);
  if (kind === "ai_cost") return aiCostSettingsStored(value);
  if (kind === "ai_failures") return aiFailureSettingsStored(value);
  if (kind === "ai_latency") return aiLatencySettingsStored(value);
  if (kind === "events_stopped" || kind === "telemetry_stopped") {
    return stoppedSettingsStored(kind, value);
  }
  return spikeSettingsOf(value);
}

export function stoppedSettingsStored(
  kind: "events_stopped" | "telemetry_stopped",
  value: unknown,
): StoppedSettings {
  const stored = storedRecord(value);
  const offered = sourcesOf(kind);
  return {
    source: offered.find((item) => item === stored.source) ?? offered[0] ?? "events",
    environment: textOrNull(stored.environment) ?? DEFAULT_ENVIRONMENT,
    eventName: textOrNull(stored.eventName),
    service: textOrNull(stored.service),
    metric: textOrNull(stored.metric),
    host: textOrNull(stored.host),
    windowMinutes: numberOr(stored.windowMinutes, DEFAULT_STOPPED_WINDOW),
    minCount: numberOr(stored.minCount, DEFAULT_MIN_COUNT),
  };
}

const aiScopeStored = (stored: Record<string, unknown>): AiScope => ({
  environment: textOrNull(stored.environment) ?? DEFAULT_ENVIRONMENT,
  feature: textOrNull(stored.feature),
  model: textOrNull(stored.model),
});

export function aiCostSettingsStored(value: unknown): AiCostSettings {
  const stored = storedRecord(value);
  return {
    ...aiScopeStored(stored),
    costWindow: COST_WINDOWS.find((item) => item === stored.costWindow) ?? "1d",
    thresholdUsd: numberOr(stored.thresholdUsd, MAX_COST_USD),
  };
}

export function aiFailureSettingsStored(value: unknown): AiFailureSettings {
  const stored = storedRecord(value);
  return {
    ...aiScopeStored(stored),
    windowMinutes: numberOr(stored.windowMinutes, DEFAULT_WINDOW_MINUTES),
    thresholdPercent: numberOr(stored.thresholdPercent, 100),
    minCalls: numberOr(stored.minCalls, DEFAULT_MIN_CALLS),
  };
}

export function aiLatencySettingsStored(value: unknown): AiLatencySettings {
  const stored = storedRecord(value);
  return {
    ...aiScopeStored(stored),
    windowMinutes: numberOr(stored.windowMinutes, DEFAULT_WINDOW_MINUTES),
    thresholdMs: numberOr(stored.thresholdMs, MAX_THRESHOLD_MS),
    minCalls: numberOr(stored.minCalls, DEFAULT_MIN_CALLS),
  };
}

const routeScopeOf = (stored: Record<string, unknown>): RouteScope => ({
  environment: textOrNull(stored.environment) ?? DEFAULT_ENVIRONMENT,
  service: textOrNull(stored.service) ?? "",
  route: textOrNull(stored.route),
  windowMinutes: numberOr(stored.windowMinutes, DEFAULT_WINDOW_MINUTES),
  minRequests: numberOr(stored.minRequests, DEFAULT_MIN_REQUESTS),
});

export function latencySettingsOf(value: unknown): LatencySettings {
  const stored = storedRecord(value);
  return {
    ...routeScopeOf(stored),
    percentile: PERCENTILES.find((item) => item === stored.percentile) ?? "p95",
    thresholdMs: numberOr(stored.thresholdMs, MAX_THRESHOLD_MS),
  };
}

export function failureSettingsOf(value: unknown): FailureSettings {
  const stored = storedRecord(value);
  return { ...routeScopeOf(stored), thresholdPercent: numberOr(stored.thresholdPercent, 100) };
}

export function metricSettingsStored(value: unknown): MetricSettings {
  const stored = storedRecord(value);
  const metricKind = METRIC_KINDS.find((item) => item === stored.metricKind) ?? "gauge";
  const offered: readonly Aggregate[] = AGGREGATES[metricKind];
  return {
    environment: textOrNull(stored.environment) ?? DEFAULT_ENVIRONMENT,
    metric: textOrNull(stored.metric) ?? "",
    metricKind,
    aggregate: offered.find((item) => item === stored.aggregate) ?? offered[0] ?? "avg",
    direction: DIRECTIONS.find((item) => item === stored.direction) ?? "above",
    value: numberOr(stored.value, 0),
    windowMinutes: numberOr(stored.windowMinutes, DEFAULT_WINDOW_MINUTES),
    host: textOrNull(stored.host),
    attributeKey: textOrNull(stored.attributeKey),
    attributeValue: textOrNull(stored.attributeValue),
  };
}

export function checkIdOf(settings: RuleSettings): string | null {
  return "checkId" in settings ? settings.checkId : null;
}

/** The kinds that watch AI calls (docs/ai-usage.md, "Alerts"). */
export const AI_KINDS: readonly RuleKind[] = ["ai_cost", "ai_failures", "ai_latency"];

/**
 * The areas a kind watches: besides uptime and alerts, a reader needs view access to one of them
 * (docs/access.md). Check rules need none (empty).
 */
export function sourceAreasOf(kind: RuleKind): readonly Area[] {
  if (AI_KINDS.includes(kind)) return ["ai"];
  // Events are web and product analytics' data: either area shows them.
  if (kind === "events_stopped") return ["web_analytics", "product_analytics"];
  const { source } = KIND_INFO[kind];
  return source === "errors" ? ["errors"] : source === "telemetry" ? ["monitoring"] : [];
}
