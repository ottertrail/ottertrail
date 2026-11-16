import { queryOptions } from "@tanstack/react-query";

import { apiRequest, expectShape } from "./api";

/** A project, as GET /api/projects returns it. */
export interface Project {
  id: string;
  name: string;
  publicKey: string;
  allowedHostnames: string[];
  createdAt: string;
  /** When the most recent event happened, or null before the first one. */
  lastEventAt: string | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

function isProject(value: unknown): value is Project {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.publicKey === "string" &&
    Array.isArray(value.allowedHostnames) &&
    value.allowedHostnames.every((hostname) => typeof hostname === "string") &&
    typeof value.createdAt === "string" &&
    (value.lastEventAt === null || typeof value.lastEventAt === "string")
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
  changes: { name?: string; allowedHostnames?: string[] },
) {
  const body = await apiRequest(`/api/projects/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: changes,
  });
  return expectShape(body, isOneProject).project;
}
