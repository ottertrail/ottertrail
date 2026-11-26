import { keepPreviousData, queryOptions } from "@tanstack/react-query";

import { DEFAULT_ENVIRONMENT, type PageRange, rangeParams } from "./analytics-api";
import { ApiError, apiRequest, expectShape } from "./api";

/**
 * - unresolved: nobody marked it resolved.
 * - resolved: marked resolved, and not seen since.
 * - regressed: seen again after it was marked resolved; listed with the unresolved.
 */
export type ErrorStatus = "unresolved" | "resolved" | "regressed";

/** What the list shows; "unresolved", the default, includes regressions. */
export const STATUS_FILTERS = [
  { value: "unresolved", label: "Unresolved" },
  { value: "resolved", label: "Resolved" },
  { value: "all", label: "All" },
] as const;

export type StatusFilter = (typeof STATUS_FILTERS)[number]["value"];

export const DEFAULT_STATUS_FILTER: StatusFilter = "unresolved";

export const isStatusFilter = (value: unknown): value is StatusFilter =>
  STATUS_FILTERS.some((item) => item.value === value);

/** Whose groups the list shows; everyone's when left out. */
export const ASSIGNEE_FILTERS = [
  { value: "everyone", label: "Everyone" },
  { value: "me", label: "Assigned to me" },
  { value: "none", label: "Unassigned" },
] as const;

export type AssigneeFilter = (typeof ASSIGNEE_FILTERS)[number]["value"];

export const DEFAULT_ASSIGNEE_FILTER: AssigneeFilter = "everyone";

export const isAssigneeFilter = (value: unknown): value is AssigneeFilter =>
  ASSIGNEE_FILTERS.some((item) => item.value === value);

/** The dashboard user on an error group (docs/errors.md, "Assignment"). */
export interface Assignee {
  id: string;
  name: string;
  /** Their avatar, or null for their initials. */
  avatarUrl: string | null;
}

/** Occurrences of one error, grouped by its fingerprint. */
export interface ErrorGroup {
  fingerprint: string;
  /** The type and message of its latest occurrence in the range. */
  type: string;
  message: string;
  /** In the range. */
  occurrences: number;
  /** Known users (user IDs) who had it, in the range. */
  users: number;
  /** Visitors who had it, in the range, counted as web analytics counts them. */
  visitors: number;
  /** Over all the time the project keeps. */
  firstSeen: string;
  lastSeen: string;
  status: ErrorStatus;
  resolvedAt: string | null;
  /** The dashboard user who resolved it; null when unknown or not resolved. */
  resolvedBy: string | null;
  /** Who is on it; null for nobody. */
  assignee: Assignee | null;
}

/** GET /api/projects/:id/errors */
export interface ErrorList {
  timeZone: string;
  environment: string;
  environments: string[];
  firstDay: string;
  lastDay: string;
  status: StatusFilter;
  /** More than 1,000 groups: only the latest 1,000 were read. */
  truncated: boolean;
  /** Latest seen first. */
  groups: ErrorGroup[];
  /** Whether the project has any error at all, in any environment: false shows "No errors yet". */
  received: boolean;
}

export interface ErrorDay {
  day: string;
  occurrences: number;
}

export interface ErrorBreakdownRow {
  /** null: not known. */
  value: string | null;
  occurrences: number;
}

/**
 * An occurrence's session replay (docs/session-replay.md):
 * - ready: stored, and can be played.
 * - pending: the error is recent; the page sends its replay about 10 seconds after it.
 * - missing: it never came, or it expired.
 */
export type ReplayStatus = "ready" | "pending" | "missing";

export interface OccurrenceReplay {
  id: string;
  status: ReplayStatus;
}

export interface Occurrence {
  eventId: string;
  occurredAt: string;
  message: string;
  /** Reported by the site with captureError(), not uncaught. */
  handled: boolean;
  path: string;
  userId: string | null;
  browser: string | null;
  browserVersion: string | null;
  os: string | null;
  deviceType: string | null;
  country: string | null;
  release: string | null;
  /** null: the page recorded no replay for it. */
  replay: OccurrenceReplay | null;
  /** A server's exception (received over OTLP): its service. null for a browser's error. */
  service: string | null;
  /**
   * A server's exception: the trace and span it happened in. A browser's
   * error with data-traces: its page load's trace, from Server-Timing.
   */
  traceId: string | null;
  spanId: string | null;
  /** A browser's last requests before the error, oldest first (data-traces). */
  requests: BrowserRequest[];
}

/** A request a page made before an error. */
export interface BrowserRequest {
  method: string;
  path: string;
  /** 0: no answer came. */
  status: number;
  durationMs: number;
  traceId: string;
}

/** Where an occurrence comes from: the tracker in a browser, or a server over OTLP. */
export type ErrorSource = "browser" | "server";

/** The original source around a mapped frame's line. */
export interface SourceContext {
  /** The first line's number: the frame's line is among them. */
  firstLine: number;
  lines: string[];
}

/** Where a minified position came from, as the release's source map says. */
export interface OriginalPosition {
  /** The original file, as the map names it, such as "src/cart.ts". */
  source: string;
  line: number;
  /** From 1, as browsers count. */
  column: number;
  /** The original name at that position, if the map has one. */
  name: string | null;
  context: SourceContext | null;
}

/** One frame of the latest stack, top first. */
export interface ResolvedFrame {
  function: string;
  /** The minified file's URL. */
  file: string;
  line: number | null;
  column: number | null;
  /** null when no source map covers the frame. */
  original: OriginalPosition | null;
}

/**
 * - applied: at least one frame was mapped, with `release`'s maps.
 * - no_release: the occurrence named no release, so no map can be chosen.
 * - no_files: no frame is in a file a map could be for (a web address).
 * - no_maps: no map of `release` covers the stack's files (`paths`).
 * - not_mapped: `release` has maps for the files (`paths`), but none covers
 *   the frames' positions: they may be another build's.
 * - not_configured: the install has no object store, so no maps.
 * - unavailable: the maps could not be read just now.
 */
export type SourceMapStatus =
  | "applied"
  | "no_release"
  | "no_files"
  | "no_maps"
  | "not_mapped"
  | "not_configured"
  | "unavailable";

export interface StackSourceMaps {
  status: SourceMapStatus;
  release: string | null;
  /** The minified files' paths looked up, for "no_maps" and "not_mapped": what to upload. */
  paths: string[];
}

export const ERROR_BREAKDOWNS = ["path", "browser", "os", "release", "service"] as const;
export type ErrorBreakdown = (typeof ERROR_BREAKDOWNS)[number];

/** GET /api/projects/:id/errors/:fingerprint */
export interface ErrorDetail {
  timeZone: string;
  environment: string;
  firstDay: string;
  lastDay: string;
  group: ErrorGroup;
  /** Every day of the range. */
  days: ErrorDay[];
  /** The top 5 of each. */
  breakdowns: Record<ErrorBreakdown, ErrorBreakdownRow[]>;
  /** The latest 20 in the range, newest first. */
  occurrences: Occurrence[];
  /** Where the latest occurrence comes from. */
  source: ErrorSource;
  /** The latest occurrence's stack, as the browser or server wrote it. */
  stack: string | null;
  /**
   * That stack's frames, mapped where its release's source maps allow;
   * null without a stack, or for a server's, which is never mapped.
   */
  frames: ResolvedFrame[] | null;
  /** How the frames were mapped; null without a stack, or for a server's. */
  sourceMaps: StackSourceMaps | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === "string";
const isTextOrNull = (value: unknown) => value === null || isText(value);
const isNumber = (value: unknown): value is number => typeof value === "number";
const isListOf = <T>(value: unknown, isItem: (item: unknown) => item is T): value is T[] =>
  Array.isArray(value) && value.every(isItem);

const isAssignee = (value: unknown): value is Assignee =>
  isRecord(value) &&
  isText(value.id) &&
  isText(value.name) &&
  (value.avatarUrl === null || typeof value.avatarUrl === "string");

const isErrorStatus = (value: unknown): value is ErrorStatus =>
  value === "unresolved" || value === "resolved" || value === "regressed";

const isErrorGroup = (value: unknown): value is ErrorGroup =>
  isRecord(value) &&
  isText(value.fingerprint) &&
  isText(value.type) &&
  isText(value.message) &&
  isNumber(value.occurrences) &&
  isNumber(value.users) &&
  isNumber(value.visitors) &&
  isText(value.firstSeen) &&
  isText(value.lastSeen) &&
  isErrorStatus(value.status) &&
  isTextOrNull(value.resolvedAt) &&
  isTextOrNull(value.resolvedBy) &&
  (value.assignee === null || isAssignee(value.assignee));

const isErrorList = (value: unknown): value is ErrorList =>
  isRecord(value) &&
  isText(value.timeZone) &&
  isText(value.environment) &&
  isListOf(value.environments, isText) &&
  isText(value.firstDay) &&
  isText(value.lastDay) &&
  isStatusFilter(value.status) &&
  typeof value.truncated === "boolean" &&
  typeof value.received === "boolean" &&
  isListOf(value.groups, isErrorGroup);

const isErrorDay = (value: unknown): value is ErrorDay =>
  isRecord(value) && isText(value.day) && isNumber(value.occurrences);

const isBreakdownRow = (value: unknown): value is ErrorBreakdownRow =>
  isRecord(value) && isTextOrNull(value.value) && isNumber(value.occurrences);

const isReplayStatus = (value: unknown): value is ReplayStatus =>
  value === "ready" || value === "pending" || value === "missing";

export const isOccurrenceReplay = (value: unknown): value is OccurrenceReplay =>
  isRecord(value) && isText(value.id) && isReplayStatus(value.status);

const isBrowserRequest = (value: unknown): value is BrowserRequest =>
  isRecord(value) &&
  isText(value.method) &&
  isText(value.path) &&
  isNumber(value.status) &&
  isNumber(value.durationMs) &&
  isText(value.traceId);

const isOccurrence = (value: unknown): value is Occurrence =>
  isRecord(value) &&
  isText(value.eventId) &&
  isText(value.occurredAt) &&
  isText(value.message) &&
  typeof value.handled === "boolean" &&
  isText(value.path) &&
  isTextOrNull(value.userId) &&
  isTextOrNull(value.browser) &&
  isTextOrNull(value.browserVersion) &&
  isTextOrNull(value.os) &&
  isTextOrNull(value.deviceType) &&
  isTextOrNull(value.country) &&
  isTextOrNull(value.release) &&
  (value.replay === null || isOccurrenceReplay(value.replay)) &&
  isTextOrNull(value.service) &&
  isTextOrNull(value.traceId) &&
  isTextOrNull(value.spanId) &&
  isListOf(value.requests, isBrowserRequest);

const isNumberOrNull = (value: unknown) => value === null || isNumber(value);

const isSourceContext = (value: unknown): value is SourceContext =>
  isRecord(value) && isNumber(value.firstLine) && isListOf(value.lines, isText);

const isOriginalPosition = (value: unknown): value is OriginalPosition =>
  isRecord(value) &&
  isText(value.source) &&
  isNumber(value.line) &&
  isNumber(value.column) &&
  isTextOrNull(value.name) &&
  (value.context === null || isSourceContext(value.context));

const isResolvedFrame = (value: unknown): value is ResolvedFrame =>
  isRecord(value) &&
  isText(value.function) &&
  isText(value.file) &&
  isNumberOrNull(value.line) &&
  isNumberOrNull(value.column) &&
  (value.original === null || isOriginalPosition(value.original));

const isSourceMapStatus = (value: unknown): value is SourceMapStatus =>
  value === "applied" ||
  value === "no_release" ||
  value === "no_files" ||
  value === "no_maps" ||
  value === "not_mapped" ||
  value === "not_configured" ||
  value === "unavailable";

const isStackSourceMaps = (value: unknown): value is StackSourceMaps =>
  isRecord(value) &&
  isSourceMapStatus(value.status) &&
  isTextOrNull(value.release) &&
  isListOf(value.paths, isText);

const isErrorDetail = (value: unknown): value is ErrorDetail =>
  isRecord(value) &&
  isText(value.timeZone) &&
  isText(value.environment) &&
  isText(value.firstDay) &&
  isText(value.lastDay) &&
  isErrorGroup(value.group) &&
  isListOf(value.days, isErrorDay) &&
  isRecord(value.breakdowns) &&
  ERROR_BREAKDOWNS.every((name) =>
    isListOf(isRecord(value.breakdowns) ? value.breakdowns[name] : undefined, isBreakdownRow),
  ) &&
  isListOf(value.occurrences, isOccurrence) &&
  (value.source === "browser" || value.source === "server") &&
  isTextOrNull(value.stack) &&
  (value.frames === null || isListOf(value.frames, isResolvedFrame)) &&
  (value.sourceMaps === null || isStackSourceMaps(value.sourceMaps));

const isResolution = (
  value: unknown,
): value is { fingerprint: string; resolvedAt: string | null } =>
  isRecord(value) && isText(value.fingerprint) && isTextOrNull(value.resolvedAt);

/**
 * Project access failures and errors with no occurrence both return 404.
 * Use the no_occurrences error code to distinguish them.
 */
export const isUnknownProject = (error: unknown) =>
  error instanceof ApiError && error.status === 404 && error.code !== "no_occurrences";

const environmentParams = (environment: string): Record<string, string> =>
  environment === DEFAULT_ENVIRONMENT ? {} : { environment };

const errorsPath = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}/errors`;

/** The project's error groups in a range and an environment, latest seen first. */
export const errorsQuery = (
  projectId: string,
  range: PageRange,
  environment: string,
  status: StatusFilter,
  assignee: AssigneeFilter = DEFAULT_ASSIGNEE_FILTER,
) =>
  queryOptions({
    queryKey: ["errors", projectId, range, environment, status, assignee],
    queryFn: async ({ signal }) => {
      const query = new URLSearchParams({
        ...rangeParams(range),
        ...environmentParams(environment),
        ...(status === DEFAULT_STATUS_FILTER ? {} : { status }),
        ...(assignee === DEFAULT_ASSIGNEE_FILTER ? {} : { assignee }),
      });
      return expectShape(
        await apiRequest(`${errorsPath(projectId)}?${query.toString()}`, { signal }),
        isErrorList,
      );
    },
    // While another period or status loads, keep showing this one (dimmed).
    placeholderData: keepPreviousData,
  });

/** One error group in a range and an environment. */
export const errorQuery = (
  projectId: string,
  fingerprint: string,
  range: PageRange,
  environment: string,
) =>
  queryOptions({
    queryKey: ["error", projectId, fingerprint, range, environment],
    queryFn: async ({ signal }) => {
      const query = new URLSearchParams({
        ...rangeParams(range),
        ...environmentParams(environment),
      });
      return expectShape(
        await apiRequest(
          `${errorsPath(projectId)}/${encodeURIComponent(fingerprint)}?${query.toString()}`,
          { signal },
        ),
        isErrorDetail,
      );
    },
  });

/** Marks a group resolved (from now on) or unresolved again. */
export async function setErrorStatus(
  projectId: string,
  fingerprint: string,
  status: "resolved" | "unresolved",
) {
  return expectShape(
    await apiRequest(`${errorsPath(projectId)}/${encodeURIComponent(fingerprint)}`, {
      method: "PATCH",
      body: { status },
    }),
    isResolution,
  );
}

const isAssigneeAnswer = (
  value: unknown,
): value is { fingerprint: string; assignee: Assignee | null } =>
  isRecord(value) &&
  isText(value.fingerprint) &&
  (value.assignee === null || isAssignee(value.assignee));

/** Assigns a group to a dashboard user, or to nobody (null). */
export async function setErrorAssignee(
  projectId: string,
  fingerprint: string,
  assignee: string | null,
) {
  return expectShape(
    await apiRequest(`${errorsPath(projectId)}/${encodeURIComponent(fingerprint)}/assignee`, {
      method: "PUT",
      body: { assignee },
    }),
    isAssigneeAnswer,
  );
}

const isAssigneeList = (value: unknown): value is { users: Assignee[] } =>
  isRecord(value) && isListOf(value.users, isAssignee);

/** The people an error of the project can be assigned to: those who see its errors. */
export const errorAssigneesQuery = (projectId: string) =>
  queryOptions({
    queryKey: ["error-assignees", projectId],
    queryFn: async ({ signal }) =>
      expectShape(
        await apiRequest(`/api/projects/${encodeURIComponent(projectId)}/error-assignees`, {
          signal,
        }),
        isAssigneeList,
      ).users,
  });
