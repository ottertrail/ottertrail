import { queryOptions } from "@tanstack/react-query";

import { apiRequest, expectShape } from "./api";
import { type Project, updateProject } from "./projects-api";

/**
 * A project's session replays (docs/session-replay.md): off, or recorded
 * around errors. The dashboard turns them on and off, shows their use, and
 * deletes them; the player is a page of the API's own, shown in a frame.
 */

export type ReplayMode = Project["replayMode"];

/** GET /api/projects/:id/replays */
export interface ReplayOverview {
  /** false: the install has no object store, so replays are off. */
  configured: boolean;
  mode: ReplayMode;
  /** The project's replays: how many, and their compressed size. */
  replays: { count: number; bytes: number };
  /** What all projects' replays take together, and the instance's limit. */
  instance: { storedBytes: number; limitBytes: number };
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
  isRecord(value.instance) &&
  isNumber(value.instance.storedBytes) &&
  isNumber(value.instance.limitBytes);

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
