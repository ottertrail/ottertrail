import { queryOptions } from "@tanstack/react-query";

import { type PageRange, rangeParams } from "./analytics-api";
import { apiRequest, expectShape } from "./api";
import {
  isListOf,
  isNumber,
  isRecord,
  isText,
  isTextOrNull,
  telemetryRetry,
} from "./telemetry-shapes";

/**
 * A project's uptime checks (docs/uptime-alerts.md; apps/api/src/uptime):
 * HTTP(S) requests the instance's worker makes on a schedule, each up,
 * down, or pending, with its uptime and incidents.
 */

export const CHECK_CAUSES = [
  "timeout",
  "refused",
  "connection",
  "dns",
  "tls",
  "status",
  "word",
  "redirects",
  "address",
] as const;
export type CheckCause = (typeof CHECK_CAUSES)[number];

export type CheckState = "pending" | "up" | "down";

/** How often a check may run, in seconds, as the API allows. */
export const INTERVALS = [60, 120, 300, 600, 900, 1800, 3600] as const;
export const DEFAULT_INTERVAL = 300;
export const DEFAULT_TIMEOUT = 10;
export const MAX_TIMEOUT = 30;
export const DEFAULT_FAILURES_BEFORE_DOWN = 2;
export const MAX_FAILURES_BEFORE_DOWN = 5;
export const DEFAULT_STATUSES = "200-399";
export const MAX_CHECK_NAME = 100;
export const MAX_WORD = 200;

export interface Check {
  id: string;
  name: string;
  url: string;
  method: "GET" | "HEAD";
  intervalSeconds: number;
  timeoutSeconds: number;
  expectedStatuses: string;
  word: string | null;
  wordMode: "present" | "absent";
  failuresBeforeDown: number;
  paused: boolean;
  state: CheckState;
  consecutiveFailures: number;
  failingSince: string | null;
  failingCause: CheckCause | null;
  lastCheckedAt: string | null;
  lastUp: boolean | null;
  lastStatusCode: number | null;
  lastResponseMs: number | null;
  lastCause: CheckCause | null;
  tlsExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Shares from 0 to 1 of the last 24 hours, 7 days, and 30 days; null before the check existed. */
  uptime: { day: number | null; week: number | null; month: number | null };
}

/** GET /api/projects/:id/checks */
export interface CheckList {
  timeZone: string;
  maxChecks: number;
  checks: Check[];
}

/** A failed run, newest first on a check's page. */
export interface CheckFailure {
  at: string;
  statusCode: number | null;
  responseMs: number;
  cause: CheckCause;
  detail: string;
}

/** GET /api/projects/:id/checks/:checkId/results */
export interface CheckResults {
  timeZone: string;
  firstDay: string;
  lastDay: string;
  retentionDays: number;
  /** The share of the period not inside an incident; null when the check did not exist in it. */
  uptime: number | null;
  start: string;
  stepSeconds: number;
  buckets: number;
  /** Average response time per bucket, of the runs that got an answer; null where none did. */
  responseMs: (number | null)[];
  runs: number;
  failures: number;
  latestFailures: CheckFailure[];
}

export interface Incident {
  id: string;
  startedAt: string;
  /** null while it is still down. */
  endedAt: string | null;
  cause: CheckCause;
  detail: string;
}

/** GET /api/projects/:id/checks/:checkId/incidents */
export interface IncidentList {
  timeZone: string;
  firstDay: string;
  lastDay: string;
  incidents: Incident[];
  truncated: boolean;
}

/** What the form sends: every field of a check a member sets. */
export interface CheckFields {
  name: string;
  url: string;
  method: "GET" | "HEAD";
  intervalSeconds: number;
  timeoutSeconds: number;
  expectedStatuses: string;
  word: string | null;
  wordMode: "present" | "absent";
  failuresBeforeDown: number;
}

const isCause = (value: unknown): value is CheckCause =>
  CHECK_CAUSES.some((cause) => cause === value);
const isCauseOrNull = (value: unknown): value is CheckCause | null =>
  value === null || isCause(value);
const isNumberOrNull = (value: unknown): value is number | null =>
  value === null || isNumber(value);
const isState = (value: unknown): value is CheckState =>
  value === "pending" || value === "up" || value === "down";

export const isCheck = (value: unknown): value is Check =>
  isRecord(value) &&
  isText(value.id) &&
  isText(value.name) &&
  isText(value.url) &&
  (value.method === "GET" || value.method === "HEAD") &&
  isNumber(value.intervalSeconds) &&
  isNumber(value.timeoutSeconds) &&
  isText(value.expectedStatuses) &&
  isTextOrNull(value.word) &&
  (value.wordMode === "present" || value.wordMode === "absent") &&
  isNumber(value.failuresBeforeDown) &&
  typeof value.paused === "boolean" &&
  isState(value.state) &&
  isNumber(value.consecutiveFailures) &&
  isTextOrNull(value.failingSince) &&
  isCauseOrNull(value.failingCause) &&
  isTextOrNull(value.lastCheckedAt) &&
  (value.lastUp === null || typeof value.lastUp === "boolean") &&
  isNumberOrNull(value.lastStatusCode) &&
  isNumberOrNull(value.lastResponseMs) &&
  isCauseOrNull(value.lastCause) &&
  isTextOrNull(value.tlsExpiresAt) &&
  isText(value.createdAt) &&
  isRecord(value.uptime) &&
  isNumberOrNull(value.uptime.day) &&
  isNumberOrNull(value.uptime.week) &&
  isNumberOrNull(value.uptime.month);

const isCheckList = (value: unknown): value is CheckList =>
  isRecord(value) &&
  isText(value.timeZone) &&
  isNumber(value.maxChecks) &&
  isListOf(value.checks, isCheck);

const isFailure = (value: unknown): value is CheckFailure =>
  isRecord(value) &&
  isText(value.at) &&
  isNumberOrNull(value.statusCode) &&
  isNumber(value.responseMs) &&
  isCause(value.cause) &&
  isText(value.detail);

const isCheckResults = (value: unknown): value is CheckResults =>
  isRecord(value) &&
  isText(value.timeZone) &&
  isText(value.firstDay) &&
  isText(value.lastDay) &&
  isNumber(value.retentionDays) &&
  isNumberOrNull(value.uptime) &&
  isText(value.start) &&
  isNumber(value.stepSeconds) &&
  isNumber(value.buckets) &&
  isListOf(value.responseMs, isNumberOrNull) &&
  value.responseMs.length === value.buckets &&
  isNumber(value.runs) &&
  isNumber(value.failures) &&
  isListOf(value.latestFailures, isFailure);

const isIncident = (value: unknown): value is Incident =>
  isRecord(value) &&
  isText(value.id) &&
  isText(value.startedAt) &&
  isTextOrNull(value.endedAt) &&
  isCause(value.cause) &&
  isText(value.detail);

const isIncidentList = (value: unknown): value is IncidentList =>
  isRecord(value) &&
  isText(value.timeZone) &&
  isText(value.firstDay) &&
  isText(value.lastDay) &&
  isListOf(value.incidents, isIncident) &&
  typeof value.truncated === "boolean";

const checksPath = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}/checks`;
const checkPath = (projectId: string, checkId: string) =>
  `${checksPath(projectId)}/${encodeURIComponent(checkId)}`;

/**
 * The project's checks. They change while the page is open (the worker
 * runs them), so the list is read again every 30 seconds.
 */
export const checksQuery = (projectId: string) =>
  queryOptions({
    queryKey: ["checks", projectId],
    queryFn: async ({ signal }) =>
      expectShape(await apiRequest(checksPath(projectId), { signal }), isCheckList),
    refetchInterval: 30_000,
  });

export const checkQuery = (projectId: string, checkId: string) =>
  queryOptions({
    queryKey: ["checks", projectId, checkId],
    queryFn: async ({ signal }) =>
      expectShape(
        await apiRequest(checkPath(projectId, checkId), { signal }),
        (value): value is { timeZone: string; check: Check } =>
          isRecord(value) && isText(value.timeZone) && isCheck(value.check),
      ),
    refetchInterval: 30_000,
  });

export const checkResultsQuery = (projectId: string, checkId: string, range: PageRange) =>
  queryOptions({
    queryKey: ["checks", projectId, checkId, "results", range],
    retry: telemetryRetry,
    queryFn: async ({ signal }) => {
      const query = new URLSearchParams(rangeParams(range));
      return expectShape(
        await apiRequest(`${checkPath(projectId, checkId)}/results?${query.toString()}`, {
          signal,
        }),
        isCheckResults,
      );
    },
    // Another period's chart never stands in for this one's while it loads.
    placeholderData: (previous) => previous,
  });

export const incidentsQuery = (projectId: string, checkId: string, range: PageRange) =>
  queryOptions({
    queryKey: ["checks", projectId, checkId, "incidents", range],
    queryFn: async ({ signal }) => {
      const query = new URLSearchParams(rangeParams(range));
      return expectShape(
        await apiRequest(`${checkPath(projectId, checkId)}/incidents?${query.toString()}`, {
          signal,
        }),
        isIncidentList,
      );
    },
  });

const checkBody = (value: unknown): value is { check: Check } =>
  isRecord(value) && isCheck(value.check);

/** POST /api/projects/:id/checks: the new check, or an ApiError naming the problem. */
export async function createCheck(projectId: string, fields: CheckFields): Promise<Check> {
  return expectShape(
    await apiRequest(checksPath(projectId), { method: "POST", body: fields }),
    checkBody,
  ).check;
}

/** PATCH /api/projects/:id/checks/:checkId: any fields, or paused. */
export async function updateCheck(
  projectId: string,
  checkId: string,
  changes: Partial<CheckFields> & { paused?: boolean },
): Promise<Check> {
  return expectShape(
    await apiRequest(checkPath(projectId, checkId), { method: "PATCH", body: changes }),
    checkBody,
  ).check;
}

/** DELETE /api/projects/:id/checks/:checkId */
export async function deleteCheck(projectId: string, checkId: string): Promise<void> {
  await apiRequest(checkPath(projectId, checkId), { method: "DELETE" });
}

/** Why a URL would be refused before the API sees it; null when it looks right. */
export function urlProblem(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed === "") return "Enter the URL to check.";
  const url = URL.parse(trimmed);
  if (url === null || !/^https?:\/\//i.test(trimmed)) {
    return "Enter a full URL that starts with http:// or https://, such as https://example.com/health.";
  }
  if (url.username !== "" || url.password !== "") {
    return "A check's URL must not contain a user name or password. They would be stored as plain text.";
  }
  return null;
}

/** Why a list of status codes would be refused; null when it is one, as the API reads it. */
export function statusesProblem(text: string): string | null {
  const parts = text.split(",").map((part) => part.trim());
  const valid =
    parts.length <= 10 &&
    parts.every((part) => {
      const match = /^(\d{3})(?:\s*-\s*(\d{3}))?$/.exec(part);
      if (match === null) return false;
      const from = Number(match[1]);
      const to = match[2] === undefined ? from : Number(match[2]);
      return from >= 100 && to <= 599 && from <= to;
    });
  return valid
    ? null
    : "Enter codes from 100 to 599 and ranges, separated by commas, such as 200-399 or 200, 204.";
}
