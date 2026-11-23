import type { CallStats } from "@/lib/databases-api";
import { MISSING } from "@/lib/missing";

import { formatConversion, formatWhole } from "../analytics/format";
import { formatNumber } from "./metric-format";

export const databaseLabel = (system: string, database: string) =>
  database === "" ? system : `${database} on ${system}`;

export function formatPerSecond(perSecond: number | null): string {
  if (perSecond === null) return MISSING;
  if (perSecond > 0 && perSecond < 0.01) return "<0.01/s";
  return `${formatNumber(perSecond)}/s`;
}

export const formatFailed = (stats: Pick<CallStats, "calls" | "failed">) =>
  stats.calls === 0 ? MISSING : formatConversion(stats.failed / stats.calls);

export function servicesText(stats: Pick<CallStats, "services" | "serviceCount">): string {
  const more = stats.serviceCount - stats.services.length;
  return more > 0
    ? `${stats.services.join(", ")} and ${formatWhole(more)} more`
    : stats.services.join(", ");
}
