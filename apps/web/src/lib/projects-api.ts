import { queryOptions } from "@tanstack/react-query";

import { apiRequest, expectShape } from "./api";

/**
 * A project as every user with access to it sees it: GET /api/projects
 * and GET /api/projects/:id. Its keys and settings come only to those who
 * manage projects (docs/access.md): see Project.
 */
export interface ProjectSummary {
  id: string;
  name: string;
  createdAt: string;
  /** When the most recent event happened, or null before the first one. */
  lastEventAt: string | null;
}

/** A project with its keys and settings, as the owner and admins get it. */
export interface Project extends ProjectSummary {
  publicKey: string;
  allowedHostnames: string[];
  /** Days of events kept; null keeps them forever. */
  retentionDays: number | null;
  /** For the site's own server only: sends server-side events and signs user IDs. */
  secretKey: string;
  /** A browser's user ID counts only with a valid signature from the site's server. */
  requireSignedUserIds: boolean;
  /** Events from cloud and hosting providers' addresses are ignored, as bots. */
  ignoreDataCenters: boolean;
  /** Session replays: off, or recorded around errors (docs/session-replay.md). */
  replayMode: "off" | "errors";
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

function isProjectSummary(value: unknown): value is ProjectSummary {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.createdAt === "string" &&
    (value.lastEventAt === null || typeof value.lastEventAt === "string")
  );
}

/** Whether the project came with its keys and settings: the API sends them in full or not at all. */
export function isFullProject(value: unknown): value is Project {
  return (
    isProjectSummary(value) &&
    "publicKey" in value &&
    typeof value.publicKey === "string" &&
    "allowedHostnames" in value &&
    Array.isArray(value.allowedHostnames) &&
    value.allowedHostnames.every((hostname) => typeof hostname === "string") &&
    "retentionDays" in value &&
    (value.retentionDays === null || typeof value.retentionDays === "number") &&
    "secretKey" in value &&
    typeof value.secretKey === "string" &&
    "requireSignedUserIds" in value &&
    typeof value.requireSignedUserIds === "boolean" &&
    "ignoreDataCenters" in value &&
    typeof value.ignoreDataCenters === "boolean" &&
    "replayMode" in value &&
    (value.replayMode === "off" || value.replayMode === "errors")
  );
}

/** A project in full, or without its keys and settings; never a mix. */
const isProject = (value: unknown): value is ProjectSummary | Project =>
  isFullProject(value) || (isProjectSummary(value) && Object.keys(value).length === 4);

const isProjectList = (value: unknown): value is { projects: (ProjectSummary | Project)[] } =>
  isRecord(value) && Array.isArray(value.projects) && value.projects.every(isProject);

const isOneProject = (value: unknown): value is { project: ProjectSummary | Project } =>
  isRecord(value) && isProject(value.project);

/** The answer of a route only those who manage projects reach: always in full. */
const isFullOne = (value: unknown): value is { project: Project } =>
  isRecord(value) && isFullProject(value.project);

export const projectsQuery = () =>
  queryOptions({
    queryKey: ["projects"],
    queryFn: async ({ signal }) =>
      expectShape(await apiRequest("/api/projects", { signal }), isProjectList).projects,
  });

export const projectQuery = (id: string) =>
  queryOptions({
    queryKey: ["projects", id],
    queryFn: async ({ signal }) =>
      expectShape(
        await apiRequest(`/api/projects/${encodeURIComponent(id)}`, { signal }),
        isOneProject,
      ).project,
  });

export async function createProject(input: { name: string; allowedHostnames: string[] }) {
  return expectShape(await apiRequest("/api/projects", { method: "POST", body: input }), isFullOne)
    .project;
}

export async function updateProject(
  id: string,
  changes: {
    name?: string;
    allowedHostnames?: string[];
    retentionDays?: number | null;
    requireSignedUserIds?: boolean;
    ignoreDataCenters?: boolean;
    replayMode?: "off" | "errors";
  },
) {
  const body = await apiRequest(`/api/projects/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: changes,
  });
  return expectShape(body, isFullOne).project;
}

/** Deletes a project and all its events, for good; the API wants its name repeated. */
export async function deleteProject(id: string, confirmName: string) {
  await apiRequest(`/api/projects/${encodeURIComponent(id)}`, {
    method: "DELETE",
    body: { confirmName },
  });
}

/** Gives a project a new public key; pages with the old snippet stop sending events. */
export async function replacePublicKey(id: string) {
  const body = await apiRequest(`/api/projects/${encodeURIComponent(id)}/public-key`, {
    method: "POST",
  });
  return expectShape(body, isFullOne).project;
}

/** Gives a project a new secret key; servers with the old one stop sending events. */
export async function replaceSecretKey(id: string) {
  const body = await apiRequest(`/api/projects/${encodeURIComponent(id)}/secret-key`, {
    method: "POST",
  });
  return expectShape(body, isFullOne).project;
}
