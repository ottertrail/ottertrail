import { queryOptions } from "@tanstack/react-query";

import { apiRequest, expectShape } from "./api";

/** A project, as GET /api/projects returns it. */
export interface Project {
  id: string;
  /** The organization that owns it. */
  organizationId: string;
  name: string;
  publicKey: string;
  allowedHostnames: string[];
  createdAt: string;
  /** When the most recent event happened, or null before the first one. */
  lastEventAt: string | null;
  /** Days of events kept; null keeps them forever. */
  retentionDays: number | null;
  /** For the site's own server only: sends server-side events and signs user IDs. */
  secretKey: string;
  /** A browser's user ID counts only with a valid signature from the site's server. */
  requireSignedUserIds: boolean;
  /** Events from cloud and hosting providers' addresses are ignored, as bots. */
  ignoreDataCenters: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

function isProject(value: unknown): value is Project {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.organizationId === "string" &&
    typeof value.name === "string" &&
    typeof value.publicKey === "string" &&
    Array.isArray(value.allowedHostnames) &&
    value.allowedHostnames.every((hostname) => typeof hostname === "string") &&
    typeof value.createdAt === "string" &&
    (value.lastEventAt === null || typeof value.lastEventAt === "string") &&
    (value.retentionDays === null || typeof value.retentionDays === "number") &&
    typeof value.secretKey === "string" &&
    typeof value.requireSignedUserIds === "boolean" &&
    typeof value.ignoreDataCenters === "boolean"
  );
}

const isProjectList = (value: unknown): value is { projects: Project[] } =>
  isRecord(value) && Array.isArray(value.projects) && value.projects.every(isProject);

const isOneProject = (value: unknown): value is { project: Project } =>
  isRecord(value) && isProject(value.project);

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
  return expectShape(
    await apiRequest("/api/projects", { method: "POST", body: input }),
    isOneProject,
  ).project;
}

export async function updateProject(
  id: string,
  changes: {
    name?: string;
    allowedHostnames?: string[];
    retentionDays?: number | null;
    requireSignedUserIds?: boolean;
    ignoreDataCenters?: boolean;
  },
) {
  const body = await apiRequest(`/api/projects/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: changes,
  });
  return expectShape(body, isOneProject).project;
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
  return expectShape(body, isOneProject).project;
}

/** Gives a project a new secret key; servers with the old one stop sending events. */
export async function replaceSecretKey(id: string) {
  const body = await apiRequest(`/api/projects/${encodeURIComponent(id)}/secret-key`, {
    method: "POST",
  });
  return expectShape(body, isOneProject).project;
}
