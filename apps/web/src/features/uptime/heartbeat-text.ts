import { periodText, spanText } from "@/lib/heartbeat-api";
import type { Check } from "@/lib/uptime-api";

import { formatMoment } from "./format";

/** "Heartbeat, every day, 2 hours of grace" */
export function heartbeatSettings(check: Check): string {
  return `Heartbeat, ${periodText(check.intervalSeconds).toLowerCase()}, ${spanText(check.graceSeconds ?? 0)} of grace`;
}

/** The row's line under the name: what it expects, its last ping, and when the next is due. */
export function heartbeatLine(check: Check, timeZone: string): string {
  const last =
    check.lastCheckedAt === null
      ? "no ping yet"
      : `last ping ${formatMoment(check.lastCheckedAt, timeZone)}`;
  const next =
    check.expectedAt === null || check.state === "down"
      ? ""
      : `; next expected ${formatMoment(check.expectedAt, timeZone)}`;
  return `Heartbeat, ${periodText(check.intervalSeconds).toLowerCase()}; ${last}${next}`;
}
