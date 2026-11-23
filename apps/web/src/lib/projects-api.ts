import { queryOptions } from "@tanstack/react-query";

import { apiRequest, expectShape } from "./api";

/**
 * GET /api/projects and GET /api/projects/:id omit keys and settings unless the user
 * manages projects (docs/access.md). See Project.
 */
export interface ProjectSummary {
  id: string;
  name: string;
  createdAt: string;
  /** When the most recent event happened, or null before the first one. */
  lastEventAt: string | null;
  /** Its uploaded icon, else its site's favicon; null for its initial. */
  avatarUrl: string | null;
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
  /** Heatmaps: the tracker sends clicks and scroll depth (with data-heatmaps="on"); off by default. */
  heatmaps: boolean;
  /** The goal the overview's business figures start with; null for none. */
  mainGoalId: string | null;
  /** IP addresses and CIDR ranges whose browser events are ignored. */
  blockedAddresses: string[];
  /** Referrer domains whose visits are ignored, with their subdomains. */
  blockedReferrers: string[];
  /** The uploaded icon alone; null without one. */
  iconUrl: string | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isStringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

function isProjectSummary(value: unknown): value is ProjectSummary {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.createdAt === "string" &&
    (value.lastEventAt === null || typeof value.lastEventAt === "string") &&
    (value.avatarUrl === null || typeof value.avatarUrl === "string")
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
    (value.replayMode === "off" || value.replayMode === "errors") &&
    "heatmaps" in value &&
    typeof value.heatmaps === "boolean" &&
    "mainGoalId" in value &&
    (value.mainGoalId === null || typeof value.mainGoalId === "string") &&
    "blockedAddresses" in value &&
    isStringList(value.blockedAddresses) &&
    "blockedReferrers" in value &&
    isStringList(value.blockedReferrers) &&
    "iconUrl" in value &&
    (value.iconUrl === null || typeof value.iconUrl === "string")
  );
}

const isProject = (value: unknown): value is ProjectSummary | Project =>
  isFullProject(value) || (isProjectSummary(value) && Object.keys(value).length === 5);

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
    heatmaps?: boolean;
    mainGoalId?: string | null;
    blockedAddresses?: string[];
    blockedReferrers?: string[];
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

/** The requester's own address as the API sees it, and for IPv6 its /64, for "Add my address". */
export interface ClientAddress {
  address: string;
  network: string | null;
}

const isClientAddress = (value: unknown): value is ClientAddress =>
  isRecord(value) &&
  typeof value.address === "string" &&
  (value.network === null || typeof value.network === "string");

export async function clientAddress(): Promise<ClientAddress> {
  return expectShape(await apiRequest("/api/client-address"), isClientAddress);
}

/** What picks the visits "Delete spam" deletes: a period of days, and optional filters. */
export interface SpamFilters {
  /** "YYYY-MM-DD", in the instance's timezone. */
  from: string;
  to: string;
  referrer?: string;
  path?: string;
  country?: string;
}

export interface SpamCounts {
  visits: number;
  events: number;
  pageviews: number;
  customEvents: number;
  errors: number;
  other: number;
  replays: number;
}

const COUNT_FIELDS = [
  "visits",
  "events",
  "pageviews",
  "customEvents",
  "errors",
  "other",
  "replays",
] as const;

const isSpamCounts = (value: unknown): value is SpamCounts =>
  isRecord(value) && COUNT_FIELDS.every((field) => typeof value[field] === "number");

const isPreview = (value: unknown): value is SpamCounts & { limit: number } =>
  isSpamCounts(value) && "limit" in value && typeof value.limit === "number";

export async function previewSpamVisits(projectId: string, filters: SpamFilters) {
  const body = await apiRequest(
    `/api/projects/${encodeURIComponent(projectId)}/spam-visits/preview`,
    { method: "POST", body: filters },
  );
  return expectShape(body, isPreview);
}

/** Deletes those visits, whole; the API wants the number of visits repeated. */
export async function deleteSpamVisits(
  projectId: string,
  filters: SpamFilters,
  confirmVisits: number,
) {
  const body = await apiRequest(
    `/api/projects/${encodeURIComponent(projectId)}/spam-visits/delete`,
    { method: "POST", body: { ...filters, confirmVisits } },
  );
  return expectShape(body, isSpamCounts);
}
