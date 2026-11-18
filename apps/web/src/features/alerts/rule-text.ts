import type { Rule } from "@/lib/alerts-api";
import type { Channel } from "@/lib/channels-api";
import type { Check } from "@/lib/uptime-api";

const minutes = (count: number) => (count === 1 ? "1 minute" : `${count} minutes`);

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
  const what =
    (settings.fingerprint ?? null) === null
      ? "errors"
      : `occurrences of the group ${settings.fingerprint}`;
  return `${settings.threshold ?? 10} or more ${what} in ${minutes(settings.windowMinutes ?? 10)}, in ${where}`;
}

/** The channels' names, in the rule's order; a channel the instance no longer has says so. */
export function channelsText(rule: Rule, channels: readonly Channel[]): string {
  if (rule.channelIds.length === 0) return "No channel";
  return rule.channelIds
    .map((id) => channels.find((channel) => channel.id === id)?.name ?? "A deleted channel")
    .join(", ");
}
