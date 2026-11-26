import type { Aggregate, ChannelName, CostWindow, Rule } from "@/lib/alerts-api";
import { SEVERITIES } from "@/lib/logs-api";
import type { Check } from "@/lib/uptime-api";

const minutes = (count: number) => (count === 1 ? "1 minute" : `${count} minutes`);
const number = (value: number) => value.toLocaleString("en", { maximumFractionDigits: 6 });

const AGGREGATE_TEXT: Record<Aggregate, string> = {
  avg: "The average",
  min: "The minimum",
  max: "The maximum",
  rate: "The rate per second",
  sum: "The total",
  p50: "The median",
  p95: "The 95th percentile",
  p99: "The 99th percentile",
};

const COST_WINDOW_TEXT: Record<CostWindow, string> = {
  "1h": "the last hour",
  "1d": "the last 24 hours",
  month: "the month to date",
};

function aiScopeText(settings: Rule["settings"]): string {
  const model = settings.model ?? null;
  const feature = settings.feature ?? null;
  return `${model === null ? "" : ` of the model ${model}`}${feature === null ? "" : ` in the feature ${feature}`}`;
}

/** A "data stops arriving" window: "30 minutes", "1 hour", "24 hours". */
const windowText = (count: number) => {
  const hours = count / 60;
  if (!Number.isInteger(hours)) return minutes(count);
  return hours === 1 ? "1 hour" : `${hours} hours`;
};

/** What a "data stops arriving" rule counts: "events named signup", "spans of the service api". */
function stoppedWhat(settings: Rule["settings"]): string {
  const service = settings.service ?? null;
  const source = settings.source ?? "events";
  if (source === "events") {
    const name = settings.eventName ?? null;
    return name === null ? "events" : `events named ${name}`;
  }
  if (source === "traces") return service === null ? "spans" : `spans of the service ${service}`;
  if (source === "logs") {
    return service === null ? "log records" : `log records of the service ${service}`;
  }
  const host = settings.host ?? null;
  return `points of the metric ${settings.metric ?? ""}${host === null ? "" : ` on the host ${host}`}`;
}

/** What a log lines rule counts: "log lines of Error or above from api with the words "timeout"". */
function logLinesWhat(settings: Rule["settings"]): string {
  const severity = SEVERITIES.find((item) => item.value === settings.severity);
  const service = settings.service ?? null;
  const search = settings.search ?? null;
  return [
    "log lines",
    ...(severity === undefined
      ? []
      : [severity.value === "fatal" ? "of Fatal" : `of ${severity.label} or above`]),
    ...(service === null ? [] : [`from ${service}`]),
    ...(search === null ? [] : [`with the words "${search}"`]),
  ].join(" ");
}

const usd = (value: number) =>
  value.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 6 });

export function watchesText(rule: Rule, checks: readonly Pick<Check, "id" | "name">[]): string {
  const { settings } = rule;
  const checkId = settings.checkId ?? null;
  const check =
    checkId === null
      ? null
      : (checks.find((item) => item.id === checkId)?.name ?? "a deleted check");
  const where =
    (settings.environment ?? null) === null ? "any environment" : `${settings.environment}`;
  if (rule.kind === "check_down") {
    return check === null ? "Any of the project's checks goes down" : `${check} goes down`;
  }
  if (rule.kind === "certificate_expiring") {
    const days = settings.days ?? 14;
    const within = `expires within ${days === 1 ? "1 day" : `${days} days`}`;
    return check === null
      ? `The certificate of any of the project's checks ${within}`
      : `The certificate of ${check} ${within}`;
  }
  if (rule.kind === "error_new") return `An error group is seen for the first time, in ${where}`;
  if (rule.kind === "error_regressed") {
    return "An error group resolved in the dashboard occurs again";
  }
  const window = minutes(settings.windowMinutes ?? 10);
  const environment = settings.environment ?? "production";
  if (rule.kind === "route_latency" || rule.kind === "route_failures") {
    const what =
      (settings.route ?? null) === null
        ? `requests of ${settings.service ?? ""}`
        : `${settings.route ?? ""} in ${settings.service ?? ""}`;
    const fewest = `at least ${(settings.minRequests ?? 20).toLocaleString("en")} requests`;
    if (rule.kind === "route_latency") {
      const p = settings.percentile === "p99" ? "99th" : "95th";
      return `The ${p} percentile duration of ${what} is above ${number(settings.thresholdMs ?? 0)} ms over ${window}, with ${fewest}, in ${environment}`;
    }
    return `More than ${number(settings.thresholdPercent ?? 0)}% of ${what} fail over ${window}, with ${fewest}, in ${environment}`;
  }
  if (rule.kind === "ai_cost") {
    const over = COST_WINDOW_TEXT[settings.costWindow ?? "1d"];
    return `The estimated cost of AI calls${aiScopeText(settings)} is above ${usd(settings.thresholdUsd ?? 0)} over ${over}, in ${environment}`;
  }
  if (rule.kind === "ai_failures") {
    const fewest = `at least ${(settings.minCalls ?? 20).toLocaleString("en")} calls`;
    return `More than ${number(settings.thresholdPercent ?? 0)}% of AI calls${aiScopeText(settings)} fail over ${window}, with ${fewest}, in ${environment}`;
  }
  if (rule.kind === "ai_latency") {
    const fewest = `at least ${(settings.minCalls ?? 20).toLocaleString("en")} calls`;
    return `The 95th percentile duration of AI calls${aiScopeText(settings)} is above ${number(settings.thresholdMs ?? 0)} ms over ${window}, with ${fewest}, in ${environment}`;
  }
  if (rule.kind === "events_stopped" || rule.kind === "telemetry_stopped") {
    const minCount = settings.minCount ?? 1;
    const over = windowText(settings.windowMinutes ?? 60);
    const what = stoppedWhat(settings);
    return minCount === 1
      ? `No ${what} arrive in ${over}, in ${environment}`
      : `Fewer than ${minCount.toLocaleString("en")} ${what} arrive in ${over}, in ${environment}`;
  }
  if (rule.kind === "log_lines") {
    const most = settings.maxCount ?? 0;
    const over = minutes(settings.windowMinutes ?? 5);
    return `More than ${most.toLocaleString("en")} ${logLinesWhat(settings)} arrive in ${over}, in ${environment}`;
  }
  if (rule.kind === "metric_threshold") {
    const filters = [
      ...((settings.host ?? null) === null ? [] : [` on host ${settings.host ?? ""}`]),
      ...((settings.attributeKey ?? null) === null
        ? []
        : [` where ${settings.attributeKey ?? ""} is ${settings.attributeValue ?? ""}`]),
    ].join("");
    const measure = AGGREGATE_TEXT[settings.aggregate ?? "avg"];
    return `${measure} of ${settings.metric ?? ""}${filters} is ${settings.direction ?? "above"} ${number(settings.value ?? 0)} over ${window}, in ${environment}`;
  }
  const what =
    (settings.fingerprint ?? null) === null
      ? "errors"
      : `occurrences of the group ${settings.fingerprint}`;
  return `${settings.threshold ?? 10} or more ${what} in ${minutes(settings.windowMinutes ?? 10)}, in ${where}`;
}

export function channelsText(rule: Rule, channels: readonly ChannelName[]): string {
  if (rule.channelIds.length === 0) return "No channel";
  return rule.channelIds
    .map((id) => channels.find((channel) => channel.id === id)?.name ?? "A deleted channel")
    .join(", ");
}
