import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { LoaderCircleIcon, OctagonAlertIcon } from "lucide-react";
import * as React from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAccess } from "@/lib/access";
import { aiReportQuery } from "@/lib/ai-api";
import {
  type ChannelName,
  kindAreas,
  type Aggregate,
  AGGREGATES,
  createRule,
  DEFAULT_CERTIFICATE_DAYS,
  DEFAULT_COST_WINDOW,
  DEFAULT_MIN_CALLS,
  type CostWindow,
  isAiKind,
  MAX_AI_FILTER_CHARS,
  MAX_COST_USD,
  MAX_MIN_CALLS,
  DEFAULT_MIN_REQUESTS,
  DEFAULT_THRESHOLD,
  DEFAULT_WINDOW_MINUTES,
  type Direction,
  KIND_LABEL,
  MAX_CERTIFICATE_DAYS,
  MAX_FILTER_CHARS,
  MAX_METRIC_VALUE,
  MAX_MIN_REQUESTS,
  MAX_ROUTE_WINDOW_MINUTES,
  MAX_RULE_NAME,
  MAX_THRESHOLD,
  MAX_THRESHOLD_MS,
  MAX_WINDOW_MINUTES,
  MIN_WINDOW_MINUTES,
  type Percentile,
  type Rule,
  type RuleFields,
  type RuleKind,
  RULE_KINDS,
  type RuleSettings,
  type SavedRule,
  type SaveWarning,
  TELEMETRY_KINDS,
  updateRule,
  type DataSource,
  DATA_SOURCES,
  DEFAULT_MIN_COUNT,
  DEFAULT_STOPPED_WINDOW,
  isStoppedKind,
  kindOfSource,
  MAX_EVENT_NAME,
  MAX_MIN_COUNT,
  STOPPED_WINDOWS,
} from "@/lib/alerts-api";
import { DEFAULT_ENVIRONMENT, type PageRange } from "@/lib/analytics-api";
import { ApiError } from "@/lib/api";
import { hostsQuery } from "@/lib/hosts-api";
import { metricChartQuery, type MetricKind, METRIC_KINDS, metricsQuery } from "@/lib/metrics-api";
import { productEventsQuery } from "@/lib/product-api";
import { recentRoutesQuery } from "@/lib/services-api";
import type { Check } from "@/lib/uptime-api";

import { KIND_LABELS } from "../telemetry/metric-format";

export interface RulePrefill {
  add?: RuleKind | undefined;
  check?: string | undefined;
  fingerprint?: string | undefined;
  env?: string | undefined;
  service?: string | undefined;
  route?: string | undefined;
  metric?: string | undefined;
  metricKind?: MetricKind | undefined;
  host?: string | undefined;
  attr?: string | undefined;
  attrValue?: string | undefined;
  model?: string | undefined;
  feature?: string | undefined;
}

interface Draft {
  kind: RuleKind;
  name: string;
  /** "" for all the project's checks. */
  checkId: string;
  days: string;
  environment: string;
  fingerprint: string;
  windowMinutes: string;
  threshold: string;
  service: string;
  /** "" for all the service's requests. */
  route: string;
  percentile: Percentile;
  thresholdMs: string;
  thresholdPercent: string;
  minRequests: string;
  metric: string;
  metricKind: MetricKind | "";
  aggregate: Aggregate;
  direction: Direction;
  value: string;
  host: string;
  attributeKey: string;
  attributeValue: string;
  costWindow: CostWindow;
  thresholdUsd: string;
  /** "" for all models or features. */
  model: string;
  feature: string;
  minCalls: string;
  /** "Data stops arriving": its source picks the kind (kindOfSource). */
  source: DataSource;
  /** "" for all events. */
  eventName: string;
  minCount: string;
  channelIds: string[];
}

type TextFieldName =
  | "name"
  | "days"
  | "environment"
  | "fingerprint"
  | "windowMinutes"
  | "threshold"
  | "service"
  | "route"
  | "thresholdMs"
  | "thresholdPercent"
  | "minRequests"
  | "metric"
  | "value"
  | "host"
  | "attributeKey"
  | "attributeValue"
  | "thresholdUsd"
  | "model"
  | "feature"
  | "minCalls"
  | "eventName"
  | "minCount";

type FieldName =
  | TextFieldName
  | "source"
  | "channels"
  | "checkId"
  | "metricKind"
  | "aggregate"
  | "percentile"
  | "direction"
  | "costWindow";

const ALL_CHECKS = "";
const ENVIRONMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const FINGERPRINT = /^[0-9]{1,3}-[0-9a-f]{20}$/;
// eslint-disable-next-line no-control-regex -- control characters are what it refuses
const SERVICE = /^[^\u0000-\u001F\u007F]{1,256}$/u;
const MAX_KEY_CHARS = 256;
const MAX_METRIC_NAME = 1024;
/** What the metric pickers suggest from: the project's last 7 days. */
const PICKER_RANGE: PageRange = { period: "7d" };
const chars = MAX_FILTER_CHARS.toLocaleString("en");

const isTelemetry = (kind: RuleKind) => TELEMETRY_KINDS.includes(kind);
const isRoute = (kind: RuleKind) => kind === "route_latency" || kind === "route_failures";

const text = (value: number | undefined | null) => (value == null ? "" : String(value));

function draftOf(
  rule: Rule | undefined,
  prefill: RulePrefill,
  channels: readonly ChannelName[],
): Draft {
  const settings: RuleSettings = rule?.settings ?? {};
  const metricKind = settings.metricKind ?? prefill.metricKind ?? "";
  const kind = rule?.kind ?? prefill.add ?? "check_down";
  return {
    kind,
    name: rule?.name ?? "",
    checkId: settings.checkId ?? prefill.check ?? ALL_CHECKS,
    days: String(settings.days ?? DEFAULT_CERTIFICATE_DAYS),
    environment: settings.environment ?? prefill.env ?? "",
    fingerprint: settings.fingerprint ?? prefill.fingerprint ?? "",
    windowMinutes: String(
      settings.windowMinutes ??
        (isStoppedKind(kind) ? DEFAULT_STOPPED_WINDOW : DEFAULT_WINDOW_MINUTES),
    ),
    threshold: String(settings.threshold ?? DEFAULT_THRESHOLD),
    service: settings.service ?? prefill.service ?? "",
    route: settings.route ?? prefill.route ?? "",
    percentile: settings.percentile ?? "p95",
    thresholdMs: text(settings.thresholdMs),
    thresholdPercent: text(settings.thresholdPercent),
    minRequests: String(settings.minRequests ?? DEFAULT_MIN_REQUESTS),
    metric: settings.metric ?? prefill.metric ?? "",
    metricKind,
    aggregate: settings.aggregate ?? (metricKind === "" ? "avg" : AGGREGATES[metricKind][0]),
    direction: settings.direction ?? "above",
    value: text(settings.value),
    host: settings.host ?? prefill.host ?? "",
    attributeKey: settings.attributeKey ?? prefill.attr ?? "",
    attributeValue: settings.attributeValue ?? prefill.attrValue ?? "",
    costWindow: settings.costWindow ?? DEFAULT_COST_WINDOW,
    thresholdUsd: text(settings.thresholdUsd),
    model: settings.model ?? prefill.model ?? "",
    feature: settings.feature ?? prefill.feature ?? "",
    minCalls: String(settings.minCalls ?? DEFAULT_MIN_CALLS),
    source: settings.source ?? (kind === "telemetry_stopped" ? "traces" : "events"),
    eventName: settings.eventName ?? "",
    minCount: String(settings.minCount ?? DEFAULT_MIN_COUNT),
    // Drop deleted channels. Default new rules to the sole channel, if present.
    channelIds:
      rule?.channelIds.filter((id) => channels.some((channel) => channel.id === id)) ??
      (channels.length === 1 && channels[0] !== undefined ? [channels[0].id] : []),
  };
}

const wholeIn = (value: string, min: number, max: number) =>
  /^\d+$/.test(value.trim()) && Number(value) >= min && Number(value) <= max;

function numberOf(value: string): number | null {
  const trimmed = value.trim();
  return /^-?\d+(\.\d+)?$/.test(trimmed) ? Number(trimmed) : null;
}

function problemsOf(draft: Draft): Partial<Record<FieldName, string>> {
  const problems: Partial<Record<FieldName, string>> = {};
  if (draft.name.trim().length > MAX_RULE_NAME) {
    problems.name = `A rule's name has at most ${MAX_RULE_NAME} characters.`;
  }
  if (draft.channelIds.length === 0) problems.channels = "Choose at least one channel.";
  if (draft.kind === "certificate_expiring" && !wholeIn(draft.days, 1, MAX_CERTIFICATE_DAYS)) {
    problems.days = `Enter a whole number of days from 1 to ${MAX_CERTIFICATE_DAYS}.`;
  }
  if (draft.kind === "error_new" || draft.kind === "error_spike" || isTelemetry(draft.kind)) {
    const environment = draft.environment.trim();
    if (environment !== "" && !ENVIRONMENT.test(environment)) {
      problems.environment =
        "An environment has 1 to 64 letters, digits, dots, dashes, or underscores, such as production.";
    }
  }
  if (draft.kind === "error_spike") {
    const group = draft.fingerprint.trim();
    if (group !== "" && !FINGERPRINT.test(group)) {
      problems.fingerprint = "Paste the group's ID from its page, such as 1-0123456789abcdef0123.";
    }
    if (!wholeIn(draft.threshold, 1, MAX_THRESHOLD)) {
      problems.threshold = `Enter a whole number of errors from 1 to ${MAX_THRESHOLD.toLocaleString("en")}.`;
    }
  }
  if (
    draft.kind === "error_spike" ||
    (isTelemetry(draft.kind) && draft.kind !== "ai_cost" && !isStoppedKind(draft.kind))
  ) {
    const most = isRoute(draft.kind) ? MAX_ROUTE_WINDOW_MINUTES : MAX_WINDOW_MINUTES;
    if (!wholeIn(draft.windowMinutes, MIN_WINDOW_MINUTES, most)) {
      problems.windowMinutes = `Enter a whole number of minutes from ${MIN_WINDOW_MINUTES} to ${most}.`;
    }
  }
  if (isRoute(draft.kind)) {
    if (!SERVICE.test(draft.service.trim())) {
      problems.service = "Choose or enter the service name from its spans (service.name).";
    }
    if (draft.route.trim().length > MAX_FILTER_CHARS) {
      problems.route = `A route has at most ${chars} characters.`;
    }
    if (!wholeIn(draft.minRequests, 1, MAX_MIN_REQUESTS)) {
      problems.minRequests = `Enter a whole number of requests from 1 to ${MAX_MIN_REQUESTS.toLocaleString("en")}.`;
    }
  }
  if (draft.kind === "route_latency" || draft.kind === "ai_latency") {
    const ms = numberOf(draft.thresholdMs);
    if (ms === null || ms <= 0 || ms > MAX_THRESHOLD_MS) {
      problems.thresholdMs = `Enter a duration above 0 and at most ${MAX_THRESHOLD_MS.toLocaleString("en")} milliseconds.`;
    }
  }
  if (draft.kind === "route_failures") {
    const percent = numberOf(draft.thresholdPercent);
    if (percent === null || percent < 0 || percent >= 100) {
      problems.thresholdPercent = "Enter a share from 0 to just under 100 percent.";
    }
  }
  if (draft.kind === "ai_cost") {
    const usd = numberOf(draft.thresholdUsd);
    if (usd === null || usd <= 0 || usd > MAX_COST_USD) {
      problems.thresholdUsd = `Enter an amount in US dollars above 0 and at most ${MAX_COST_USD.toLocaleString("en")}, such as 50 or 2.5.`;
    }
  }
  if (draft.kind === "ai_failures") {
    const percent = numberOf(draft.thresholdPercent);
    if (percent === null || percent < 0 || percent >= 100) {
      problems.thresholdPercent = "Enter a share from 0 to just under 100 percent.";
    }
  }
  if (draft.kind === "ai_failures" || draft.kind === "ai_latency") {
    if (!wholeIn(draft.minCalls, 1, MAX_MIN_CALLS)) {
      problems.minCalls = `Enter a whole number of calls from 1 to ${MAX_MIN_CALLS.toLocaleString("en")}.`;
    }
  }
  if (isAiKind(draft.kind)) {
    if (draft.model.trim().length > MAX_AI_FILTER_CHARS) {
      problems.model = `A model has at most ${MAX_AI_FILTER_CHARS} characters.`;
    }
    if (draft.feature.trim().length > MAX_AI_FILTER_CHARS) {
      problems.feature = `A feature has at most ${MAX_AI_FILTER_CHARS} characters.`;
    }
  }
  if (isStoppedKind(draft.kind)) {
    if (!wholeIn(draft.minCount, 1, MAX_MIN_COUNT)) {
      problems.minCount = `Enter a whole number of records from 1 to ${MAX_MIN_COUNT.toLocaleString("en")}.`;
    }
    const eventName = draft.eventName.trim();
    if (
      draft.source === "events" &&
      eventName !== "" &&
      (eventName.length > MAX_EVENT_NAME || !SERVICE.test(eventName))
    ) {
      problems.eventName = `An event name has at most ${MAX_EVENT_NAME} characters, and no control characters.`;
    }
    const service = draft.service.trim();
    if ((draft.source === "traces" || draft.source === "logs") && service !== "") {
      if (!SERVICE.test(service)) {
        problems.service = "Enter the service name from its records (service.name).";
      }
    }
    if (draft.source === "metrics") {
      const metric = draft.metric.trim();
      if (metric === "" || metric.length > MAX_METRIC_NAME) {
        problems.metric = "Choose or enter the metric's name.";
      }
      if (draft.host.trim().length > MAX_FILTER_CHARS) {
        problems.host = `A host's name has at most ${chars} characters.`;
      }
    }
  }
  if (draft.kind === "metric_threshold") {
    const metric = draft.metric.trim();
    if (metric === "" || metric.length > MAX_METRIC_NAME) {
      problems.metric = "Choose or enter the metric's name.";
    }
    if (draft.metricKind === "") problems.metricKind = "Select the metric kind.";
    const value = numberOf(draft.value);
    if (value === null || Math.abs(value) > MAX_METRIC_VALUE) {
      problems.value = "Enter a number to compare with, such as 100 or 0.5.";
    }
    if (draft.host.trim().length > MAX_FILTER_CHARS) {
      problems.host = `A host's name has at most ${chars} characters.`;
    }
    if (draft.attributeKey.trim().length > MAX_KEY_CHARS) {
      problems.attributeKey = `An attribute's key has at most ${MAX_KEY_CHARS} characters.`;
    }
    if (draft.attributeKey.trim() !== "" && draft.attributeValue === "") {
      problems.attributeValue = "Enter the attribute's value too.";
    }
    if (draft.attributeValue.length > MAX_FILTER_CHARS) {
      problems.attributeValue = `An attribute's value has at most ${chars} characters.`;
    }
  }
  return problems;
}

function fieldOfError(code: string, kind: RuleKind): FieldName | undefined {
  if (code === "invalid_threshold") {
    if (kind === "route_latency") return "thresholdMs";
    if (kind === "route_failures") return "thresholdPercent";
    if (kind === "metric_threshold") return "value";
    if (kind === "ai_cost") return "thresholdUsd";
    if (kind === "ai_failures") return "thresholdPercent";
    if (kind === "ai_latency") return "thresholdMs";
    return "threshold";
  }
  if (code === "invalid_window" && kind === "ai_cost") return "costWindow";
  if (code === "invalid_attribute" && isStoppedKind(kind)) return "host";
  const fields: Record<string, FieldName> = {
    invalid_source: "source",
    invalid_min_count: "minCount",
    invalid_name: "name",
    invalid_days: "days",
    invalid_window: "windowMinutes",
    invalid_channels: "channels",
    channel_not_found: "channels",
    check_not_found: "checkId",
    invalid_service: "service",
    invalid_route: "route",
    invalid_min_requests: "minRequests",
    invalid_percentile: "percentile",
    invalid_metric: "metric",
    invalid_metric_kind: "metricKind",
    invalid_aggregate: "aggregate",
    invalid_direction: "direction",
    invalid_attribute: "attributeValue",
    invalid_min_calls: "minCalls",
    invalid_filter: "feature",
  };
  return fields[code];
}

const optional = (value: string) => (value.trim() === "" ? null : value.trim());

function settingsOf(draft: Draft): RuleSettings {
  const environment = optional(draft.environment);
  switch (draft.kind) {
    case "check_down":
      return { checkId: draft.checkId === ALL_CHECKS ? null : draft.checkId };
    case "certificate_expiring":
      return {
        checkId: draft.checkId === ALL_CHECKS ? null : draft.checkId,
        days: Number(draft.days),
      };
    case "error_new":
      return { environment };
    case "error_regressed":
      return {};
    case "error_spike":
      return {
        environment,
        fingerprint: optional(draft.fingerprint),
        windowMinutes: Number(draft.windowMinutes),
        threshold: Number(draft.threshold),
      };
    case "route_latency":
    case "route_failures": {
      const scope = {
        environment,
        service: draft.service.trim(),
        route: optional(draft.route),
        windowMinutes: Number(draft.windowMinutes),
        minRequests: Number(draft.minRequests),
      };
      return draft.kind === "route_latency"
        ? { ...scope, percentile: draft.percentile, thresholdMs: Number(draft.thresholdMs) }
        : { ...scope, thresholdPercent: Number(draft.thresholdPercent) };
    }
    case "metric_threshold": {
      const attributeKey = optional(draft.attributeKey);
      return {
        environment,
        metric: draft.metric.trim(),
        ...(draft.metricKind === "" ? {} : { metricKind: draft.metricKind }),
        aggregate: draft.aggregate,
        direction: draft.direction,
        value: Number(draft.value),
        windowMinutes: Number(draft.windowMinutes),
        host: optional(draft.host),
        attributeKey,
        attributeValue: attributeKey === null ? null : draft.attributeValue,
      };
    }
    case "ai_cost":
      return {
        environment,
        model: optional(draft.model),
        feature: optional(draft.feature),
        costWindow: draft.costWindow,
        thresholdUsd: Number(draft.thresholdUsd),
      };
    case "ai_failures":
      return {
        environment,
        model: optional(draft.model),
        feature: optional(draft.feature),
        windowMinutes: Number(draft.windowMinutes),
        thresholdPercent: Number(draft.thresholdPercent),
        minCalls: Number(draft.minCalls),
      };
    case "ai_latency":
      return {
        environment,
        model: optional(draft.model),
        feature: optional(draft.feature),
        windowMinutes: Number(draft.windowMinutes),
        thresholdMs: Number(draft.thresholdMs),
        minCalls: Number(draft.minCalls),
      };
    case "events_stopped":
    case "telemetry_stopped": {
      const common = {
        source: draft.source,
        environment,
        windowMinutes: Number(draft.windowMinutes),
        minCount: Number(draft.minCount),
      };
      if (draft.source === "events") return { ...common, eventName: optional(draft.eventName) };
      if (draft.source === "metrics") {
        return { ...common, metric: draft.metric.trim(), host: optional(draft.host) };
      }
      return { ...common, service: optional(draft.service) };
    }
    default:
      return {};
  }
}

const fieldsOf = (draft: Draft): RuleFields => ({
  name: draft.name.trim(),
  kind: draft.kind,
  settings: settingsOf(draft),
  channelIds: draft.channelIds,
});

const STOPPED_HELP =
  "Notifies when fewer records than the minimum arrive in the window, then again when enough arrive. Choose a window that the quietest hours fill.";

const KIND_HELP: Record<RuleKind, string> = {
  check_down: "Notifies when a check goes down and when it recovers.",
  certificate_expiring: "Notifies once per expiring certificate, then again when renewed.",
  error_new: "Notifies once per error group first seen after this rule is added.",
  error_regressed: "Notifies whenever a resolved error recurs in any environment.",
  error_spike: "Notifies at the threshold, then again after a full window below it.",
  route_latency:
    "Notifies above the threshold, then again after a full window at or below it. Requests count as on the Services page. Windows below the minimum request count do not trigger or resolve alerts.",
  route_failures:
    "Notifies above the threshold, then again after a full window at or below it. Windows below the minimum request count do not trigger or resolve alerts.",
  metric_threshold:
    "Notifies above or below the chosen value, then again after a full window without that condition. Calculated as on its chart. Empty windows do not trigger or resolve alerts.",
  ai_cost:
    "Notifies when the estimated cost goes above the amount, then again after an hour at or below it. The cost is an estimate from token counts and model prices, as on the AI page.",
  ai_failures:
    "Notifies above the threshold, then again after a full window at or below it. Windows below the minimum call count do not trigger or resolve alerts.",
  ai_latency:
    "Notifies when the 95th percentile duration of AI calls is above the threshold, then again after a full window at or below it. Windows below the minimum call count do not trigger or resolve alerts.",
  events_stopped: STOPPED_HELP,
  telemetry_stopped: STOPPED_HELP,
};

const COST_WINDOW_ITEMS: { value: CostWindow; label: string }[] = [
  { value: "1h", label: "The last hour" },
  { value: "1d", label: "The last 24 hours" },
  { value: "month", label: "The month to date" },
];

const AGGREGATE_LABEL: Record<Aggregate, string> = {
  avg: "Average",
  min: "Minimum",
  max: "Maximum",
  rate: "Per second",
  sum: "Total",
  p50: "Median (p50)",
  p95: "95th percentile (p95)",
  p99: "99th percentile (p99)",
};

const PERCENTILE_ITEMS = [
  { value: "p95", label: "95th percentile (p95)" },
  { value: "p99", label: "99th percentile (p99)" },
];
const DIRECTION_ITEMS = [
  { value: "above", label: "Above" },
  { value: "below", label: "Below" },
];
const METRIC_KIND_ITEMS = [
  { value: "", label: "Choose a kind" },
  ...METRIC_KINDS.map((kind) => ({ value: kind, label: KIND_LABELS[kind] })),
];

function SelectField({
  label,
  value,
  items,
  onChange,
  description,
  error,
}: {
  label: string;
  value: string;
  items: readonly { value: string; label: string }[];
  onChange: (value: string) => void;
  description?: string | undefined;
  error?: string | null;
}) {
  const id = React.useId();
  return (
    <Field data-invalid={(error ?? null) !== null || undefined}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Select
        items={items}
        value={value}
        onValueChange={(next) => {
          if (typeof next === "string") onChange(next);
        }}
      >
        <SelectTrigger id={id} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {(error ?? null) !== null ? (
        <FieldError>{error}</FieldError>
      ) : (
        description !== undefined && <FieldDescription>{description}</FieldDescription>
      )}
    </Field>
  );
}

/** The form's one item for both "data stops arriving" kinds; the source picks the kind. */
const STOPPED_ITEM = "data_stopped";

const KIND_ITEMS: { value: string; label: string; kinds: readonly RuleKind[] }[] = [
  ...RULE_KINDS.filter((kind) => !isStoppedKind(kind)).map((kind) => ({
    value: kind,
    label: KIND_LABEL[kind],
    kinds: [kind],
  })),
  {
    value: STOPPED_ITEM,
    label: KIND_LABEL.events_stopped,
    kinds: ["events_stopped", "telemetry_stopped"],
  },
];

const SOURCE_LABEL: Record<DataSource, string> = {
  events: "Events",
  traces: "Traces",
  logs: "Logs",
  metrics: "Metrics",
};

const windowLabel = (minutes: number) => {
  const hours = minutes / 60;
  if (Number.isInteger(hours)) return hours === 1 ? "1 hour" : `${hours} hours`;
  return `${minutes} minutes`;
};

const STOPPED_WINDOW_ITEMS = STOPPED_WINDOWS.map((minutes) => ({
  value: String(minutes),
  label: windowLabel(minutes),
}));

const pickerEnvironment = (draft: Draft) => {
  const typed = draft.environment.trim().toLowerCase();
  return ENVIRONMENT.test(typed) ? typed : DEFAULT_ENVIRONMENT;
};

/**
 * Fetch suggestions only for the selected rule kind: up to 200 services from the last day, and
 * metrics, hosts, and product events from the last 7 days.
 */
function useSuggestions(projectId: string, draft: Draft, canReadEvents: boolean) {
  const environment = pickerEnvironment(draft);
  const stopped = isStoppedKind(draft.kind);
  const recent = useQuery({
    ...recentRoutesQuery(projectId, environment),
    enabled:
      isRoute(draft.kind) || (stopped && (draft.source === "traces" || draft.source === "logs")),
  });
  const metricRule = draft.kind === "metric_threshold";
  const metricNames = metricRule || (stopped && draft.source === "metrics");
  const metrics = useQuery({
    ...metricsQuery(projectId, PICKER_RANGE, environment),
    enabled: metricNames,
  });
  const hosts = useQuery({
    ...hostsQuery(projectId, PICKER_RANGE, environment),
    enabled: metricNames,
  });
  const events = useQuery({
    ...productEventsQuery(projectId, PICKER_RANGE, environment),
    enabled: stopped && draft.source === "events" && canReadEvents,
  });
  const metricName = draft.metric.trim();
  const known = (metrics.data?.metrics ?? []).some(
    (metric) => metric.name === metricName && metric.kind === draft.metricKind,
  );
  const kind: MetricKind = draft.metricKind === "" ? "gauge" : draft.metricKind;
  const chart = useQuery({
    ...metricChartQuery(projectId, PICKER_RANGE, environment, {
      name: metricName,
      kind,
      split: undefined,
    }),
    enabled: metricRule && known,
  });
  const keys = known ? (chart.data?.keys ?? []) : [];
  const attributeKey = draft.attributeKey.trim();
  const values = useQuery({
    ...metricChartQuery(projectId, PICKER_RANGE, environment, {
      name: metricName,
      kind,
      split: attributeKey,
    }),
    enabled: metricRule && known && keys.includes(attributeKey),
  });
  const ai = useQuery({
    ...aiReportQuery(projectId, PICKER_RANGE, environment, {}),
    enabled: isAiKind(draft.kind),
  });
  const pairs = recent.data?.routes ?? [];
  const service = draft.service.trim();
  return {
    services: [...new Set(pairs.map((item) => item.service))],
    routes: pairs
      .filter((item) => item.service === service && item.route !== "")
      .map((item) => item.route),
    metrics: metrics.data?.metrics ?? [],
    hosts: (hosts.data?.hosts ?? []).map((item) => item.host),
    keys,
    values: keys.includes(attributeKey)
      ? (values.data?.series ?? []).flatMap((series) =>
          series.other || series.value === null ? [] : [series.value],
        )
      : [],
    aiModels: ai.data?.filterOptions.models ?? [],
    // Rules cannot target calls with no feature.
    aiFeatures: (ai.data?.filterOptions.features ?? []).filter((feature) => feature !== ""),
    // Pageviews are not product events, but every site sends them.
    eventNames: ["pageview", ...(events.data?.events ?? []).map((event) => event.name)],
  };
}

/** Remount on open to reset the form. */
function RuleForm({
  projectId,
  rule,
  prefill,
  checks,
  channels,
  onSaved,
}: {
  projectId: string;
  rule: Rule | undefined;
  prefill: RulePrefill;
  checks: readonly Pick<Check, "id" | "name">[];
  channels: readonly ChannelName[];
  onSaved: (saved: SavedRule) => void;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = React.useState(() => draftOf(rule, prefill, channels));
  const [checked, setChecked] = React.useState(false);
  const formId = React.useId();
  const { can, canUse } = useAccess();
  // Only offer rule kinds and sources the API permits for this user.
  const mayAdd = (kind: RuleKind) => {
    const areas = kindAreas(kind);
    return areas.length === 0 || areas.some((area) => canUse(area));
  };
  const suggestions = useSuggestions(projectId, draft, canUse("product_analytics"));
  const save = useMutation({
    mutationFn: () =>
      rule === undefined
        ? createRule(projectId, fieldsOf(draft))
        : updateRule(projectId, rule.id, fieldsOf(draft)),
    onSuccess: (saved) => {
      void queryClient.invalidateQueries({ queryKey: ["alerts", projectId] });
      onSaved(saved);
    },
  });
  const problems = problemsOf(draft);
  const valid = Object.keys(problems).length === 0;
  const apiField =
    save.error instanceof ApiError && save.error.code !== undefined
      ? fieldOfError(save.error.code, draft.kind)
      : undefined;
  const errorOf = (field: FieldName): string | null =>
    (checked ? problems[field] : undefined) ??
    (apiField === field ? (save.error?.message ?? null) : null);
  const change = (next: Partial<Draft>) => {
    setDraft((previous) => ({ ...previous, ...next }));
    if (save.isError) save.reset();
  };
  const textField = (
    field: TextFieldName,
    label: string,
    more: {
      placeholder?: string;
      description?: string;
      numeric?: "numeric" | "decimal";
      options?: readonly string[];
      onChange?: (value: string) => void;
    } = {},
  ) => {
    const error = errorOf(field);
    const id = `${formId}-${field}`;
    const options = more.options ?? [];
    return (
      <Field data-invalid={error !== null || undefined}>
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        <Input
          id={id}
          autoComplete="off"
          inputMode={more.numeric}
          aria-invalid={error !== null || undefined}
          aria-describedby={error === null ? undefined : `${id}-error`}
          list={options.length === 0 ? undefined : `${id}-options`}
          value={draft[field]}
          placeholder={more.placeholder}
          onChange={(event) =>
            more.onChange === undefined
              ? change({ [field]: event.target.value })
              : more.onChange(event.target.value)
          }
        />
        {options.length > 0 && (
          <datalist id={`${id}-options`}>
            {options.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </datalist>
        )}
        {error !== null ? (
          <FieldError id={`${id}-error`}>{error}</FieldError>
        ) : (
          more.description !== undefined && <FieldDescription>{more.description}</FieldDescription>
        )}
      </Field>
    );
  };
  const checkItems = [
    { value: ALL_CHECKS, label: "All the project's checks" },
    ...checks.map((check) => ({ value: check.id, label: check.name })),
    // Keep a deleted check visible in the select.
    ...(draft.checkId !== ALL_CHECKS && !checks.some((check) => check.id === draft.checkId)
      ? [{ value: draft.checkId, label: "A deleted check" }]
      : []),
  ];
  const channelsError = errorOf("channels");
  const canAddChannels = can("channels");
  const kindItems = KIND_ITEMS.filter((item) => item.kinds.some(mayAdd));
  const sourceItems = DATA_SOURCES.filter((source) => mayAdd(kindOfSource(source))).map(
    (source) => ({ value: source, label: SOURCE_LABEL[source] }),
  );
  const setSource = (source: DataSource) => change({ source, kind: kindOfSource(source) });
  const setKind = (value: string) => {
    if (value === STOPPED_ITEM) {
      const source = sourceItems.some((item) => item.value === draft.source)
        ? draft.source
        : sourceItems[0]?.value;
      if (source === undefined || isStoppedKind(draft.kind)) return;
      change({
        source,
        kind: kindOfSource(source),
        windowMinutes: String(DEFAULT_STOPPED_WINDOW),
      });
      return;
    }
    const found = RULE_KINDS.find((item) => item === value);
    if (found !== undefined) change({ kind: found });
  };
  const stopped = isStoppedKind(draft.kind);
  const metricKinds = suggestions.metrics.filter((metric) => metric.name === draft.metric.trim());
  const aggregates: readonly Aggregate[] =
    draft.metricKind === "" ? [] : AGGREGATES[draft.metricKind];
  const setMetricKind = (kind: MetricKind | "") => {
    const offered: readonly Aggregate[] = kind === "" ? [] : AGGREGATES[kind];
    change({
      metricKind: kind,
      aggregate: offered.includes(draft.aggregate) ? draft.aggregate : (offered[0] ?? "avg"),
    });
  };
  const windowField = textField("windowMinutes", "In the last (minutes)", {
    numeric: "numeric",
    description: `${MIN_WINDOW_MINUTES} to ${isRoute(draft.kind) ? MAX_ROUTE_WINDOW_MINUTES : MAX_WINDOW_MINUTES} minutes.`,
  });
  const environmentField = textField("environment", "Environment", {
    placeholder: DEFAULT_ENVIRONMENT,
    description: `Leave empty for ${DEFAULT_ENVIRONMENT}.`,
  });

  return (
    <form
      noValidate
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        setChecked(true);
        if (valid && !save.isPending) save.mutate();
      }}
    >
      <DialogHeader>
        <DialogTitle>
          {rule === undefined ? "Add an alert rule" : `Edit “${rule.name}”`}
        </DialogTitle>
      </DialogHeader>
      <SelectField
        label="When"
        value={stopped ? STOPPED_ITEM : draft.kind}
        items={kindItems}
        onChange={setKind}
        description={KIND_HELP[draft.kind]}
      />
      {stopped && (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <SelectField
              label="Data"
              value={draft.source}
              items={sourceItems}
              onChange={(next) => {
                const found = DATA_SOURCES.find((source) => source === next);
                if (found !== undefined) setSource(found);
              }}
              error={errorOf("source")}
            />
            {environmentField}
          </div>
          {draft.source === "events" &&
            textField("eventName", "Event name (optional)", {
              placeholder: "All events",
              options: suggestions.eventNames,
            })}
          {(draft.source === "traces" || draft.source === "logs") &&
            textField("service", "Service (optional)", {
              placeholder: "All services",
              options: suggestions.services,
            })}
          {draft.source === "metrics" && (
            <div className="grid gap-4 sm:grid-cols-2">
              {textField("metric", "Metric", {
                options: [...new Set(suggestions.metrics.map((metric) => metric.name))],
              })}
              {textField("host", "Host (optional)", {
                placeholder: "All hosts",
                options: suggestions.hosts,
              })}
            </div>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            {textField("minCount", "Fewer than (records)", {
              numeric: "numeric",
              description: "1 notifies when nothing arrives.",
            })}
            <SelectField
              label="In the last"
              value={draft.windowMinutes}
              items={STOPPED_WINDOW_ITEMS}
              onChange={(windowMinutes) => change({ windowMinutes })}
              error={errorOf("windowMinutes")}
            />
          </div>
        </>
      )}
      {(draft.kind === "check_down" || draft.kind === "certificate_expiring") && (
        <SelectField
          label="Check"
          value={draft.checkId}
          items={checkItems}
          onChange={(checkId) => change({ checkId })}
          error={errorOf("checkId")}
          description={
            draft.checkId === ALL_CHECKS ? "Checks added later are watched too." : undefined
          }
        />
      )}
      {draft.kind === "certificate_expiring" &&
        textField("days", "Days before it expires", { numeric: "numeric" })}
      {(draft.kind === "error_new" || draft.kind === "error_spike") &&
        textField("environment", "Environment (optional)", {
          placeholder: "All environments",
          description: "Leave empty to watch every environment.",
        })}
      {draft.kind === "error_spike" && (
        <>
          {textField("fingerprint", "Error group (optional)", {
            placeholder: "All errors",
            description: "Leave empty to count all errors.",
          })}
          <div className="grid gap-4 sm:grid-cols-2">
            {textField("threshold", "Errors", {
              numeric: "numeric",
            })}
            {windowField}
          </div>
        </>
      )}
      {isRoute(draft.kind) && (
        <>
          {environmentField}
          {textField("service", "Service", {
            options: suggestions.services,
          })}
          {textField("route", "Route (optional)", {
            placeholder: "All the service's requests",
            options: suggestions.routes,
            description:
              "Use http.route, or the span name if http.route is absent. Leave empty to monitor the whole service.",
          })}
          <div className="grid gap-4 sm:grid-cols-2">
            {draft.kind === "route_latency" ? (
              <>
                <SelectField
                  label="Percentile"
                  value={draft.percentile}
                  items={PERCENTILE_ITEMS}
                  onChange={(next) => change({ percentile: next === "p99" ? "p99" : "p95" })}
                  error={errorOf("percentile")}
                />
                {textField("thresholdMs", "Above (milliseconds)", {
                  numeric: "decimal",
                })}
              </>
            ) : (
              textField("thresholdPercent", "Failed above (percent)", {
                numeric: "decimal",
                description: "Requests whose span status is Error.",
              })
            )}
            {windowField}
            {textField("minRequests", "At least (requests)", {
              numeric: "numeric",
              description: "Windows with fewer requests neither trigger nor resolve alerts.",
            })}
          </div>
        </>
      )}
      {draft.kind === "metric_threshold" && (
        <>
          {environmentField}
          <div className="grid gap-4 sm:grid-cols-2">
            {textField("metric", "Metric", {
              options: [...new Set(suggestions.metrics.map((metric) => metric.name))],
              onChange: (metric) => {
                const kinds = suggestions.metrics.filter((item) => item.name === metric.trim());
                const only = kinds.length === 1 ? kinds[0]?.kind : undefined;
                change({ metric });
                if (only !== undefined && only !== draft.metricKind) setMetricKind(only);
              },
            })}
            <SelectField
              label="Kind"
              value={draft.metricKind}
              items={METRIC_KIND_ITEMS}
              onChange={(next) => setMetricKind(METRIC_KINDS.find((kind) => kind === next) ?? "")}
              error={errorOf("metricKind")}
              description={
                metricKinds.length > 1
                  ? "This metric name has multiple kinds. Select one."
                  : undefined
              }
            />
          </div>
          {aggregates.length > 0 && (
            <div className="grid gap-4 sm:grid-cols-2">
              <SelectField
                label="Read as"
                value={draft.aggregate}
                items={aggregates.map((aggregate) => ({
                  value: aggregate,
                  label: AGGREGATE_LABEL[aggregate],
                }))}
                onChange={(next) => {
                  const found = aggregates.find((aggregate) => aggregate === next);
                  if (found !== undefined) change({ aggregate: found });
                }}
                error={errorOf("aggregate")}
                description="Calculated as on the metric's chart, over the full window."
              />
              <SelectField
                label="Sends when it is"
                value={draft.direction}
                items={DIRECTION_ITEMS}
                onChange={(next) => change({ direction: next === "below" ? "below" : "above" })}
                error={errorOf("direction")}
              />
            </div>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            {textField("value", draft.direction === "below" ? "Below" : "Above", {
              numeric: "decimal",
              description: "In the metric's own unit.",
            })}
            {windowField}
          </div>
          {textField("host", "Host (optional)", {
            placeholder: "All hosts",
            options: suggestions.hosts,
            description: "Use the resource attribute host.name.",
          })}
          <div className="grid gap-4 sm:grid-cols-2">
            {textField("attributeKey", "Attribute (optional)", {
              placeholder: "None",
              options: suggestions.keys,
            })}
            {textField("attributeValue", "Its value", {
              options: suggestions.values,
            })}
          </div>
        </>
      )}
      {isAiKind(draft.kind) && (
        <>
          {environmentField}
          {draft.kind === "ai_cost" ? (
            <div className="grid gap-4 sm:grid-cols-2">
              {textField("thresholdUsd", "Estimated cost above (US dollars)", {
                numeric: "decimal",
              })}
              <SelectField
                label="Over"
                value={draft.costWindow}
                items={COST_WINDOW_ITEMS}
                onChange={(next) => {
                  const found = COST_WINDOW_ITEMS.find((item) => item.value === next);
                  if (found !== undefined) change({ costWindow: found.value });
                }}
                error={errorOf("costWindow")}
                description={
                  draft.costWindow === "month"
                    ? "From midnight on the 1st, in the instance's timezone."
                    : undefined
                }
              />
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              {draft.kind === "ai_latency"
                ? textField("thresholdMs", "95th percentile above (milliseconds)", {
                    numeric: "decimal",
                  })
                : textField("thresholdPercent", "Failed above (percent)", {
                    numeric: "decimal",
                  })}
              {windowField}
              {textField("minCalls", "At least (calls)", {
                numeric: "numeric",
                description: "Windows with fewer calls neither trigger nor resolve alerts.",
              })}
            </div>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            {textField("model", "Model (optional)", {
              placeholder: "All models",
              options: suggestions.aiModels,
            })}
            {textField("feature", "Feature (optional)", {
              placeholder: "All features",
              options: suggestions.aiFeatures,
            })}
          </div>
        </>
      )}
      {textField("name", "Name (optional)", { placeholder: KIND_LABEL[draft.kind] })}
      <FieldSet data-invalid={channelsError !== null || undefined}>
        <FieldLegend variant="label">Send to</FieldLegend>
        {channels.length === 0 ? (
          <p className="text-sm text-ink-subtle">
            This instance has no notification channels.{" "}
            {canAddChannels ? (
              <>
                <Link
                  to="/settings"
                  search={{ tab: "channels" }}
                  className="text-link hover:underline"
                >
                  Add one in Settings
                </Link>
                .
              </>
            ) : (
              "An admin adds them in Settings."
            )}
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {channels.map((channel) => {
              const id = `rule-channel-${channel.id}`;
              const on = draft.channelIds.includes(channel.id);
              return (
                <Field orientation="horizontal" key={channel.id}>
                  <Checkbox
                    id={id}
                    checked={on}
                    onCheckedChange={(next) =>
                      change({
                        channelIds: next
                          ? [...draft.channelIds, channel.id]
                          : draft.channelIds.filter((item) => item !== channel.id),
                      })
                    }
                  />
                  <FieldLabel htmlFor={id} className="font-normal">
                    {channel.name}
                    <span className="text-ink-subtle">
                      {channel.kind === "email" ? " (email)" : " (webhook)"}
                    </span>
                  </FieldLabel>
                </Field>
              );
            })}
          </div>
        )}
        {channelsError !== null && <FieldError>{channelsError}</FieldError>}
      </FieldSet>
      {checked && !valid && (
        <p role="alert" className="text-sm text-destructive">
          The rule is incomplete. Correct the marked fields above.
        </p>
      )}
      {save.error !== null && apiField === undefined && (
        <Alert variant="destructive" role="alert">
          <OctagonAlertIcon />
          <AlertDescription>{save.error.message}</AlertDescription>
        </Alert>
      )}
      <DialogFooter>
        <DialogClose render={<Button variant="outline" type="button" />}>Cancel</DialogClose>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending && (
            <LoaderCircleIcon
              aria-hidden="true"
              className="animate-spin motion-reduce:animate-none"
            />
          )}
          {rule === undefined ? "Add rule" : "Save changes"}
        </Button>
      </DialogFooter>
    </form>
  );
}

export function RuleFormDialog({
  open,
  onOpenChange,
  projectId,
  rule,
  prefill = {},
  checks,
  channels,
  onWarning,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  rule?: Rule | undefined;
  prefill?: RulePrefill;
  checks: readonly Pick<Check, "id" | "name">[];
  channels: readonly ChannelName[];
  /** Report why the saved rule may not fire yet; null means no warning. */
  onWarning?: ((saved: { ruleName: string; warning: SaveWarning | null }) => void) | undefined;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <RuleForm
          projectId={projectId}
          rule={rule}
          prefill={prefill}
          checks={checks}
          channels={channels}
          onSaved={(saved) => {
            onWarning?.({ ruleName: saved.rule.name, warning: saved.warning });
            onOpenChange(false);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
