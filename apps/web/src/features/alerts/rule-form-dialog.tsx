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
  DialogDescription,
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
import {
  type ChannelName,
  kindArea,
  type Aggregate,
  AGGREGATES,
  createRule,
  DEFAULT_CERTIFICATE_DAYS,
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
} from "@/lib/alerts-api";
import { DEFAULT_ENVIRONMENT, type PageRange } from "@/lib/analytics-api";
import { ApiError } from "@/lib/api";
import { hostsQuery } from "@/lib/hosts-api";
import { metricChartQuery, type MetricKind, METRIC_KINDS, metricsQuery } from "@/lib/metrics-api";
import { recentRoutesQuery } from "@/lib/services-api";
import type { Check } from "@/lib/uptime-api";

import { KIND_LABELS } from "../telemetry/metric-format";

/** What a new rule starts with: a kind, and what the page it came from knows. */
export interface RulePrefill {
  add?: RuleKind | undefined;
  check?: string | undefined;
  fingerprint?: string | undefined;
  env?: string | undefined;
  /** From the Services page: a service, and one of its routes. */
  service?: string | undefined;
  route?: string | undefined;
  /** From a metric's page: the metric, its kind, and its filters. */
  metric?: string | undefined;
  metricKind?: MetricKind | undefined;
  host?: string | undefined;
  attr?: string | undefined;
  attrValue?: string | undefined;
}

/** The form's fields, as typed. */
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
  /** "" until chosen. */
  metricKind: MetricKind | "";
  aggregate: Aggregate;
  direction: Direction;
  value: string;
  host: string;
  attributeKey: string;
  attributeValue: string;
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
  | "attributeValue";

type FieldName =
  | TextFieldName
  | "channels"
  | "checkId"
  | "metricKind"
  | "aggregate"
  | "percentile"
  | "direction";

const ALL_CHECKS = "";
const ENVIRONMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const FINGERPRINT = /^[0-9]{1,3}-[0-9a-f]{20}$/;
// eslint-disable-next-line no-control-regex -- control characters are what it refuses
const SERVICE = /^[^\u0000-\u001F\u007F]{1,256}$/u;
const MAX_KEY_CHARS = 256;
const MAX_METRIC_NAME = 1024;
/** What the metric pickers suggest from: the project's last 7 days. */
const PICKER_RANGE: PageRange = { period: "7d" };
/** Characters, as the form counts them: the API's limit. */
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
  return {
    kind: rule?.kind ?? prefill.add ?? "check_down",
    name: rule?.name ?? "",
    checkId: settings.checkId ?? prefill.check ?? ALL_CHECKS,
    days: String(settings.days ?? DEFAULT_CERTIFICATE_DAYS),
    environment: settings.environment ?? prefill.env ?? "",
    fingerprint: settings.fingerprint ?? prefill.fingerprint ?? "",
    windowMinutes: String(settings.windowMinutes ?? DEFAULT_WINDOW_MINUTES),
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
    // A channel deleted meanwhile is dropped, so the rule can be saved; a
    // new rule sends to the only channel there is, if there is one.
    channelIds:
      rule?.channelIds.filter((id) => channels.some((channel) => channel.id === id)) ??
      (channels.length === 1 && channels[0] !== undefined ? [channels[0].id] : []),
  };
}

const wholeIn = (value: string, min: number, max: number) =>
  /^\d+$/.test(value.trim()) && Number(value) >= min && Number(value) <= max;

/** A decimal number, such as 250, 0.5, or -3; null when it is not one. */
function numberOf(value: string): number | null {
  const trimmed = value.trim();
  return /^-?\d+(\.\d+)?$/.test(trimmed) ? Number(trimmed) : null;
}

/** The problems the form finds before sending, as the API would. */
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
  if (draft.kind === "error_spike" || isTelemetry(draft.kind)) {
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
  if (draft.kind === "route_latency") {
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

/** Which field an API refusal belongs to, by its code and the rule's kind. */
function fieldOfError(code: string, kind: RuleKind): FieldName | undefined {
  if (code === "invalid_threshold") {
    if (kind === "route_latency") return "thresholdMs";
    if (kind === "route_failures") return "thresholdPercent";
    if (kind === "metric_threshold") return "value";
    return "threshold";
  }
  const fields: Record<string, FieldName> = {
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

/** What each kind does, under its choice. */
const KIND_HELP: Record<RuleKind, string> = {
  check_down: "Sends a notification when a check goes down. Sends another when it is up again.",
  certificate_expiring:
    "Sends one notification per certificate within the specified days before expiry. Sends another when the certificate is renewed.",
  error_new:
    "Sends one notification per error group first seen after the rule is added. Previously seen groups do not count as new.",
  error_regressed:
    "Sends one notification each time an error group resolved in the dashboard occurs again in any environment.",
  error_spike:
    "Sends a notification when the error count in the window reaches the threshold. Sends another after it stays below the threshold for a full window.",
  route_latency:
    "Sends a notification when the requests' 95th or 99th percentile duration exceeds the threshold over the window. Requests count as on the Services page. Sends another after the duration stays at or below the threshold for a full window. Windows with fewer requests than the minimum, including none, neither trigger nor resolve alerts.",
  route_failures:
    "Sends a notification when the failed request share exceeds the threshold over the window. Sends another after the share stays at or below the threshold for a full window. Windows with fewer requests than the minimum, including none, neither trigger nor resolve alerts.",
  metric_threshold:
    "Sends a notification when the metric is above or below the value over the window. The metric is calculated as on its chart. Sends another after the metric stays on the non-alerting side for a full window. Windows without points neither trigger nor resolve alerts.",
};

/** What a metric rule can read of each measure, as the metric's page calls it. */
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

/** A select with its label, as the form's other fields are. */
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

const KIND_ITEMS = RULE_KINDS.map((kind) => ({ value: kind, label: KIND_LABEL[kind] }));

/** The environment the pickers read: the one typed, when it is one, else production. */
const pickerEnvironment = (draft: Draft) => {
  const typed = draft.environment.trim().toLowerCase();
  return ENVIRONMENT.test(typed) ? typed : DEFAULT_ENVIRONMENT;
};

/**
 * What the pickers suggest: services and their routes of the last day (a
 * light list of up to 200, not the Services page's counts); metrics with
 * their kinds and hosts of the last 7 days; and the chosen metric's
 * attribute keys and values (its chart's). Each list is read only while
 * its kind of rule is chosen.
 */
function useSuggestions(projectId: string, draft: Draft) {
  const environment = pickerEnvironment(draft);
  const recent = useQuery({
    ...recentRoutesQuery(projectId, environment),
    enabled: isRoute(draft.kind),
  });
  const metricRule = draft.kind === "metric_threshold";
  const metrics = useQuery({
    ...metricsQuery(projectId, PICKER_RANGE, environment),
    enabled: metricRule,
  });
  const hosts = useQuery({
    ...hostsQuery(projectId, PICKER_RANGE, environment),
    enabled: metricRule,
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
  };
}

/** The form, mounted while the dialog is open, so each opening starts afresh. */
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
  const suggestions = useSuggestions(projectId, draft);
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
      /** Suggestions, offered as the field is typed in. */
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
    // A check the rule names that the project no longer has, so the select still shows it.
    ...(draft.checkId !== ALL_CHECKS && !checks.some((check) => check.id === draft.checkId)
      ? [{ value: draft.checkId, label: "A deleted check" }]
      : []),
  ];
  const channelsError = errorOf("channels");
  const { can, canUse } = useAccess();
  const canAddChannels = can("channels");
  // Only the kinds whose area the user has: the API refuses the others.
  const kindItems = KIND_ITEMS.filter((item) => {
    const area = kindArea(item.value);
    return area === null || canUse(area);
  });
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
        <DialogDescription>
          A rule monitors the project. It notifies its channels when an alert starts and again when
          the alert ends.
        </DialogDescription>
      </DialogHeader>
      <SelectField
        label="When"
        value={draft.kind}
        items={kindItems}
        onChange={(kind) => {
          const found = RULE_KINDS.find((item) => item === kind);
          if (found !== undefined) change({ kind: found });
        }}
        description={KIND_HELP[draft.kind]}
      />
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
            description:
              "Leave empty to count all errors. This field is filled automatically from an error's page.",
          })}
          <div className="grid gap-4 sm:grid-cols-2">
            {textField("threshold", "Errors", {
              numeric: "numeric",
              description: "Sends when the count reaches this.",
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
            description: "The services that sent requests in the last day are suggested.",
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
                  description: "Sends when the duration is above this.",
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
            description: "Include only one host's series. Use its resource's host.name.",
          })}
          <div className="grid gap-4 sm:grid-cols-2">
            {textField("attributeKey", "Attribute (optional)", {
              placeholder: "None",
              options: suggestions.keys,
            })}
            {textField("attributeValue", "Its value", {
              options: suggestions.values,
              description: "Only the points with this value.",
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
                <Link to="/settings" className="text-link hover:underline">
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

/** Adds a rule or edits one, with the API's own messages beside the fields they are about. */
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
  /** The rule to edit; none to add one. */
  rule?: Rule | undefined;
  prefill?: RulePrefill;
  checks: readonly Pick<Check, "id" | "name">[];
  channels: readonly ChannelName[];
  /** Why the rule just saved may not fire yet, for the page to show; null when nothing is wrong. */
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
