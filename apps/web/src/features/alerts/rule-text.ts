import type { Aggregate, ChannelName, Rule } from "@/lib/alerts-api";
import type { Check } from "@/lib/uptime-api";

const minutes = (count: number) => (count === 1 ? "1 minute" : `${count} minutes`);
const number = (value: number) => value.toLocaleString("en", { maximumFractionDigits: 6 });

/** A metric rule's measure, as a sentence starts it. */
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

/** What a rule watches, in a sentence, with its check's name when it names one. */
export function watchesText(rule: Rule, checks: readonly Pick<Check, "id" | "name">[]): string {
  const { settings } = rule;
  const checkId = settings.checkId ?? null;
  const check =
    checkId === null
      ? null
      : (checks.find((item) => item.id === checkId)?.name ?? "a check that was deleted");
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
    return "An error group resolved in the dashboard happens again";
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

/** The channels' names, in the rule's order; a channel the instance no longer has says so. */
export function channelsText(rule: Rule, channels: readonly ChannelName[]): string {
  if (rule.channelIds.length === 0) return "No channel";
  return rule.channelIds
    .map((id) => channels.find((channel) => channel.id === id)?.name ?? "A deleted channel")
    .join(", ");
}
