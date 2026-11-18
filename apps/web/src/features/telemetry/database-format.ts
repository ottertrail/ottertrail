import type { CallStats } from "@/lib/databases-api";

import { formatConversion, formatWhole } from "../analytics/format";
import { formatNumber } from "./metric-format";

/** How the Databases pages write their numbers and names. */

/** "postgresql · shop", or "redis" alone when the calls name no database. */
export const databaseLabel = (system: string, database: string) =>
  database === "" ? system : `${system} · ${database}`;

/** Calls per second: "0.25/s", "<0.01/s" for a few calls over a long period. */
export function formatPerSecond(perSecond: number | null): string {
  if (perSecond === null) return "–";
  if (perSecond > 0 && perSecond < 0.01) return "<0.01/s";
  return `${formatNumber(perSecond)}/s`;
}

/** The failed share: "–" without a call. */
export const formatFailed = (stats: Pick<CallStats, "calls" | "failed">) =>
  stats.calls === 0 ? "–" : formatConversion(stats.failed / stats.calls);

/** The services that made the calls: up to 10 by name, and how many more. */
export function servicesText(stats: Pick<CallStats, "services" | "serviceCount">): string {
  const more = stats.serviceCount - stats.services.length;
  return more > 0
    ? `${stats.services.join(", ")} and ${formatWhole(more)} more`
    : stats.services.join(", ");
}
