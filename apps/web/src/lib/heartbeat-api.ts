import { queryOptions } from "@tanstack/react-query";

import { apiRequest, expectShape } from "./api";
import { isListOf, isRecord, isText } from "./telemetry-shapes";
import { type Check, isCheck } from "./uptime-api";

/**
 * Heartbeat checks (docs/uptime-alerts.md, "Heartbeat checks"): a job pings
 * the check's URL each time it runs. Kept apart from uptime-api.ts, which
 * the first load carries, so this loads with the Uptime pages only.
 */

/** A heartbeat's period, in seconds, as the API allows. */
export const HEARTBEAT_PERIODS = [
  60, 300, 600, 900, 1800, 3600, 7200, 21_600, 43_200, 86_400, 604_800,
] as const;
export const DEFAULT_PERIOD = 86_400;
/** The time allowed after the period. */
export const HEARTBEAT_GRACES = [
  60, 300, 600, 900, 1800, 3600, 7200, 21_600, 43_200, 86_400,
] as const;

/** As the API picks it: the largest grace at most a fifth of the period, at least 1 minute. */
export function defaultGrace(periodSeconds: number): number {
  return HEARTBEAT_GRACES.findLast((grace) => grace <= periodSeconds / 5) ?? HEARTBEAT_GRACES[0];
}

const unit = (count: number, name: string) => `${count} ${name}${count === 1 ? "" : "s"}`;

/** "5 minutes", "1 hour", "1 day", "1 week". */
export function spanText(seconds: number): string {
  if (seconds % 604_800 === 0) return unit(seconds / 604_800, "week");
  if (seconds % 86_400 === 0) return unit(seconds / 86_400, "day");
  if (seconds % 3600 === 0) return unit(seconds / 3600, "hour");
  return unit(Math.round(seconds / 60), "minute");
}

/** "Every 5 minutes", "Every hour", "Every day", "Every week". */
export function periodText(seconds: number): string {
  const span = spanText(seconds);
  return `Every ${span.startsWith("1 ") ? span.slice(2) : span}`;
}

export interface HeartbeatFields {
  name: string;
  intervalSeconds: number;
  graceSeconds: number;
}

export interface Ping {
  at: string;
  failed: boolean;
}

const checksPath = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}/checks`;
const checkPath = (projectId: string, checkId: string) =>
  `${checksPath(projectId)}/${encodeURIComponent(checkId)}`;

const checkBody = (value: unknown): value is { check: Check } =>
  isRecord(value) && isCheck(value.check);

/** POST /api/projects/:id/checks with kind heartbeat. */
export async function createHeartbeat(projectId: string, fields: HeartbeatFields): Promise<Check> {
  return expectShape(
    await apiRequest(checksPath(projectId), {
      method: "POST",
      body: { kind: "heartbeat", ...fields },
    }),
    checkBody,
  ).check;
}

/** PATCH /api/projects/:id/checks/:checkId with a heartbeat's fields. */
export async function updateHeartbeat(
  projectId: string,
  checkId: string,
  fields: HeartbeatFields,
): Promise<Check> {
  return expectShape(
    await apiRequest(checkPath(projectId, checkId), { method: "PATCH", body: fields }),
    checkBody,
  ).check;
}

const isPing = (value: unknown): value is Ping =>
  isRecord(value) && isText(value.at) && typeof value.failed === "boolean";

/** A heartbeat's latest pings, newest first; read again with the check. */
export const pingsQuery = (projectId: string, checkId: string) =>
  queryOptions({
    queryKey: ["checks", projectId, checkId, "pings"],
    queryFn: async ({ signal }) =>
      expectShape(
        await apiRequest(`${checkPath(projectId, checkId)}/pings`, { signal }),
        (value): value is { timeZone: string; pings: Ping[] } =>
          isRecord(value) && isText(value.timeZone) && isListOf(value.pings, isPing),
      ),
    refetchInterval: 30_000,
  });

const isUrlBody = (value: unknown): value is { url: string } =>
  isRecord(value) && isText(value.url);

/**
 * The ping URL, which holds the heartbeat's secret token: for those who
 * manage checks only, and dropped from the cache when the page closes.
 */
export const pingUrlQuery = (projectId: string, checkId: string) =>
  queryOptions({
    queryKey: ["checks", projectId, checkId, "ping-url"],
    queryFn: async ({ signal }) =>
      expectShape(
        await apiRequest(`${checkPath(projectId, checkId)}/ping-url`, { signal }),
        isUrlBody,
      ).url,
    gcTime: 0,
    staleTime: Infinity,
  });

/** A new token: the old URL stops working at once. */
export async function replacePingUrl(projectId: string, checkId: string): Promise<string> {
  return expectShape(
    await apiRequest(`${checkPath(projectId, checkId)}/ping-url`, { method: "POST" }),
    isUrlBody,
  ).url;
}
