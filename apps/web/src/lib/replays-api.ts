import { infiniteQueryOptions, keepPreviousData, queryOptions } from "@tanstack/react-query";

import { DEFAULT_ENVIRONMENT, type PageRange, rangeParams } from "./analytics-api";
import { apiRequest, expectShape } from "./api";
import { type Project, updateProject } from "./projects-api";

/** Error-triggered session replays (docs/session-replay.md). The API serves the player in a frame. */

export type ReplayMode = Project["replayMode"];

/** GET /api/projects/:id/replays */
export interface ReplayOverview {
  /** false: the install has no object store, so replays are off. */
  configured: boolean;
  mode: ReplayMode;
  /** Bytes are compressed storage size. */
  replays: { count: number; bytes: number };
  /**
   * What all projects' replays take together, and the instance's limit:
   * only for those who manage projects (docs/access.md).
   */
  instance?: { storedBytes: number; limitBytes: number };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isNumber = (value: unknown): value is number => typeof value === "number";

export const isReplayMode = (value: unknown): value is ReplayMode =>
  value === "off" || value === "errors";

const isOverview = (value: unknown): value is ReplayOverview =>
  isRecord(value) &&
  typeof value.configured === "boolean" &&
  isReplayMode(value.mode) &&
  isRecord(value.replays) &&
  isNumber(value.replays.count) &&
  isNumber(value.replays.bytes) &&
  (value.instance === undefined ||
    (isRecord(value.instance) &&
      isNumber(value.instance.storedBytes) &&
      isNumber(value.instance.limitBytes)));

const replaysPath = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}/replays`;

export const replaysKey = (projectId: string) => ["replays", projectId] as const;

export const replaysQuery = (projectId: string) =>
  queryOptions({
    queryKey: replaysKey(projectId),
    queryFn: async ({ signal }) =>
      expectShape(await apiRequest(replaysPath(projectId), { signal }), isOverview),
  });

/** Turns recording on (around errors) or off; the project as saved. */
export const setReplayMode = (projectId: string, replayMode: ReplayMode) =>
  updateProject(projectId, { replayMode });

/** DELETE /api/projects/:id/replays: every replay of the project, for good. */
export async function deleteReplays(projectId: string): Promise<void> {
  await apiRequest(replaysPath(projectId), { method: "DELETE" });
}

/**
 * The player page for one replay, started around the error: the API serves
 * it with its own Content Security Policy, for a frame of the dashboard.
 */
export function playerUrl(projectId: string, replayId: string, errorAt: string): string {
  const time = Date.parse(errorAt);
  const query = Number.isFinite(time) ? `?errorAt=${String(time)}` : "";
  return `${replaysPath(projectId)}/${encodeURIComponent(replayId)}/player${query}`;
}

/** The error a replay shows: its page's first error, and its group on the Errors page. */
export interface ReplayError {
  fingerprint: string;
  type: string;
  message: string;
  occurredAt: string;
}

/** A replay as the list shows it (docs/session-replay.md, "Finding replays"). */
export interface ReplaySummary {
  id: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  /** Stopped at its size limit, or its end never came. */
  cut: boolean;
  /** Paths visited, in the order first seen. */
  pages: string[];
  clicks: number;
  pageChanges: number;
  /** null while its error is looked for (`linked` false), or when it was not found. */
  error: ReplayError | null;
  linked: boolean;
  userId: string | null;
  environment: string | null;
  browser: string | null;
  os: string | null;
  deviceType: string | null;
}

export interface ReplayErrorGroup {
  fingerprint: string;
  type: string;
  message: string;
  replays: number;
}

/** One page of GET /api/projects/:id/replays/list, newest first. */
export interface ReplayList {
  configured: boolean;
  timeZone: string;
  environment: string;
  environments: string[];
  /** The period's error groups with replays: the error filter's choices (first page only). */
  errorGroups: ReplayErrorGroup[];
  firstDay: string;
  lastDay: string;
  replays: ReplaySummary[];
  /** The cursor to the next, older page; null on the last. */
  next: string | null;
}

/** What a click or input was on: a button, link, or field, as the recording knows it. */
export type ElementRole =
  | "button"
  | "link"
  | "checkbox"
  | "radio"
  | "switch"
  | "tab"
  | "menuitem"
  | "option"
  | "textbox"
  | "searchbox"
  | "combobox"
  | "listbox"
  | "slider"
  | "spinbutton";

const ROLES: readonly string[] = [
  "button",
  "link",
  "checkbox",
  "radio",
  "switch",
  "tab",
  "menuitem",
  "option",
  "textbox",
  "searchbox",
  "combobox",
  "listbox",
  "slider",
  "spinbutton",
];

/** One moment of a replay's timeline, `at` ms after the recording's start. */
export type TimelineItem =
  | { at: number; kind: "page"; path: string }
  | { at: number; kind: "click"; tag: string; role: ElementRole | null; x: number; y: number }
  | { at: number; kind: "input"; tag: string; role: ElementRole | null }
  | { at: number; kind: "scroll"; y: number }
  | { at: number; kind: "error" };

/**
 * Why a timeline left items out past its 500: some early scrolls
 * ("scrolls"), or every scroll and the earliest other items ("earliest").
 */
export type Truncation = false | "scrolls" | "earliest";

/** GET /api/projects/:id/replays/:replayId/timeline */
export interface ReplayTimeline {
  timeZone: string;
  replay: ReplaySummary;
  timeline: { items: TimelineItem[]; truncated: Truncation };
  /** Where the error is, in ms from the recording's start; null when not known. */
  errorOffsetMs: number | null;
  /** The recording's start on its own clock, as the player counts. */
  recordingStartMs: number;
}

export interface ReplayFilters {
  /** A path visited contains this. */
  path?: string | undefined;
  userId?: string | undefined;
  fingerprint?: string | undefined;
  /** In milliseconds. */
  minDuration?: number | undefined;
}

/** Minimum durations the list offers, in milliseconds. */
export const MIN_REPLAY_DURATIONS = [10_000, 30_000, 60_000] as const;

const isText = (value: unknown): value is string => typeof value === "string";
const isTextOrNull = (value: unknown) => value === null || isText(value);
const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const isListOf = <T>(value: unknown, isItem: (item: unknown) => item is T): value is T[] =>
  Array.isArray(value) && value.every(isItem);

const isReplayError = (value: unknown): value is ReplayError =>
  isRecord(value) &&
  isText(value.fingerprint) &&
  isText(value.type) &&
  isText(value.message) &&
  isText(value.occurredAt);

export const isReplaySummary = (value: unknown): value is ReplaySummary =>
  isRecord(value) &&
  isText(value.id) &&
  isText(value.startedAt) &&
  isText(value.endedAt) &&
  isFiniteNumber(value.durationMs) &&
  typeof value.cut === "boolean" &&
  isListOf(value.pages, isText) &&
  isFiniteNumber(value.clicks) &&
  isFiniteNumber(value.pageChanges) &&
  (value.error === null || isReplayError(value.error)) &&
  typeof value.linked === "boolean" &&
  isTextOrNull(value.userId) &&
  isTextOrNull(value.environment) &&
  isTextOrNull(value.browser) &&
  isTextOrNull(value.os) &&
  isTextOrNull(value.deviceType);

const isErrorGroup = (value: unknown): value is ReplayErrorGroup =>
  isRecord(value) &&
  isText(value.fingerprint) &&
  isText(value.type) &&
  isText(value.message) &&
  isFiniteNumber(value.replays);

const isReplayList = (value: unknown): value is ReplayList =>
  isRecord(value) &&
  typeof value.configured === "boolean" &&
  isText(value.timeZone) &&
  isText(value.environment) &&
  isListOf(value.environments, isText) &&
  isListOf(value.errorGroups, isErrorGroup) &&
  isText(value.firstDay) &&
  isText(value.lastDay) &&
  isListOf(value.replays, isReplaySummary) &&
  isTextOrNull(value.next);

const isRole = (value: unknown): value is ElementRole | null =>
  value === null || (isText(value) && ROLES.includes(value));

/** A timeline item in exactly a known shape: the recording it comes from is untrusted. */
export function isTimelineItem(value: unknown): value is TimelineItem {
  if (!isRecord(value) || !isFiniteNumber(value.at)) return false;
  switch (value.kind) {
    case "page":
      return isText(value.path);
    case "click":
      return (
        isText(value.tag) &&
        isRole(value.role) &&
        isFiniteNumber(value.x) &&
        isFiniteNumber(value.y)
      );
    case "input":
      return isText(value.tag) && isRole(value.role);
    case "scroll":
      return isFiniteNumber(value.y);
    case "error":
      return true;
    default:
      return false;
  }
}

const isReplayTimeline = (value: unknown): value is ReplayTimeline =>
  isRecord(value) &&
  isText(value.timeZone) &&
  isReplaySummary(value.replay) &&
  isRecord(value.timeline) &&
  isListOf(value.timeline.items, isTimelineItem) &&
  (value.timeline.truncated === false ||
    value.timeline.truncated === "scrolls" ||
    value.timeline.truncated === "earliest") &&
  (value.errorOffsetMs === null || isFiniteNumber(value.errorOffsetMs)) &&
  isFiniteNumber(value.recordingStartMs);

/** The project's replays, newest first, 50 at a time ("Load older"). */
export const replayListQuery = (
  projectId: string,
  range: PageRange,
  environment: string,
  filters: ReplayFilters,
) =>
  infiniteQueryOptions({
    // Each filter by name, so a filter left undefined and one left out are the same query.
    queryKey: [
      "replay-list",
      projectId,
      range,
      environment,
      filters.path ?? null,
      filters.userId ?? null,
      filters.fingerprint ?? null,
      filters.minDuration ?? null,
    ],
    queryFn: async ({ pageParam, signal }) => {
      const query = new URLSearchParams({
        ...rangeParams(range),
        ...(environment === DEFAULT_ENVIRONMENT ? {} : { environment }),
        ...(filters.path === undefined ? {} : { path: filters.path }),
        ...(filters.userId === undefined ? {} : { userId: filters.userId }),
        ...(filters.fingerprint === undefined ? {} : { fingerprint: filters.fingerprint }),
        ...(filters.minDuration === undefined ? {} : { minDuration: String(filters.minDuration) }),
        ...(pageParam === null ? {} : { before: pageParam }),
      });
      return expectShape(
        await apiRequest(`${replaysPath(projectId)}/list?${query.toString()}`, { signal }),
        isReplayList,
      );
    },
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next ?? undefined,
    // While other filters load, keep showing these (dimmed).
    placeholderData: keepPreviousData,
  });

export const replayTimelineQuery = (projectId: string, replayId: string) =>
  queryOptions({
    queryKey: ["replay-timeline", projectId, replayId],
    queryFn: async ({ signal }) =>
      expectShape(
        await apiRequest(`${replaysPath(projectId)}/${encodeURIComponent(replayId)}/timeline`, {
          signal,
        }),
        isReplayTimeline,
      ),
    // Its error may still be looked for: a minute, then fresh.
    staleTime: 60_000,
  });

/** The player page for a replay, its error marked at `errorAt` (ms, the recording's clock). */
export function playerUrlAt(projectId: string, replayId: string, errorAt: number | null): string {
  const query =
    errorAt === null || !Number.isSafeInteger(Math.round(errorAt)) || errorAt < 0
      ? ""
      : `?errorAt=${String(Math.round(errorAt))}`;
  return `${replaysPath(projectId)}/${encodeURIComponent(replayId)}/player${query}`;
}
