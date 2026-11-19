import { type QueryClient, queryOptions } from "@tanstack/react-query";

import { ApiError, apiRequest, expectShape } from "./api";
import {
  type FunnelCount,
  type FunnelStep,
  type FunnelWindow,
  isFunnelCount,
  isFunnelStep,
  isFunnelWindow,
} from "./product-api";
import { nameProblem } from "./text";

/**
 * A project's saved funnels (docs/product-analytics.md): a name for a
 * funnel's steps, who it counts, and its window. The period and the
 * environment are not part of it: they are chosen when it is shown.
 */

export interface SavedFunnel {
  id: string;
  name: string;
  steps: FunnelStep[];
  count: FunnelCount;
  window: FunnelWindow;
  createdAt: string;
  updatedAt: string;
}

/** What a saved funnel holds besides its name. */
export interface FunnelDefinition {
  steps: FunnelStep[];
  count: FunnelCount;
  window: FunnelWindow;
}

/** Saved funnels a project may have, as the API allows. */
export const MAX_SAVED_FUNNELS = 50;

/** A saved funnel's longest name, after trimming, as the API allows. */
export const MAX_FUNNEL_NAME = 100;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === "string";

export const isSavedFunnel = (value: unknown): value is SavedFunnel =>
  isRecord(value) &&
  isText(value.id) &&
  isText(value.name) &&
  Array.isArray(value.steps) &&
  value.steps.every(isFunnelStep) &&
  isFunnelCount(value.count) &&
  isFunnelWindow(value.window) &&
  isText(value.createdAt) &&
  isText(value.updatedAt);

/** Why a funnel's name would be refused, as the API checks it; null when it would not. */
export const funnelNameProblem = (name: string) => nameProblem(name, "funnel", MAX_FUNNEL_NAME);

const funnelsPath = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}/funnels`;
const funnelPath = (projectId: string, funnelId: string) =>
  `${funnelsPath(projectId)}/${encodeURIComponent(funnelId)}`;

const hasFunnel = (value: unknown): value is { funnel: SavedFunnel } =>
  isRecord(value) && isSavedFunnel(value.funnel);

/** The key every saved-funnel change invalidates. */
export const savedFunnelsKey = (projectId: string) => ["saved-funnels", projectId] as const;

/**
 * Puts a funnel the API just saved into the list already loaded, by name
 * as the API sorts it, so the page shows it saved at once; the list is
 * fetched again all the same.
 */
export function rememberSavedFunnel(
  queryClient: QueryClient,
  projectId: string,
  funnel: SavedFunnel,
): void {
  queryClient.setQueryData<SavedFunnel[]>(savedFunnelsKey(projectId), (list) =>
    list === undefined
      ? undefined
      : [...list.filter((item) => item.id !== funnel.id), funnel].toSorted((a, b) =>
          a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
        ),
  );
  void queryClient.invalidateQueries({ queryKey: savedFunnelsKey(projectId) });
}

/** GET /api/projects/:id/funnels: the project's saved funnels, by name. */
export const savedFunnelsQuery = (projectId: string) =>
  queryOptions({
    queryKey: savedFunnelsKey(projectId),
    queryFn: async ({ signal }) =>
      expectShape(
        await apiRequest(funnelsPath(projectId), { signal }),
        (value): value is { funnels: SavedFunnel[] } =>
          isRecord(value) && Array.isArray(value.funnels) && value.funnels.every(isSavedFunnel),
      ).funnels,
  });

/** POST /api/projects/:id/funnels: the new funnel, or an ApiError (funnel_name_taken …). */
export async function createFunnel(
  projectId: string,
  name: string,
  { steps, count, window }: FunnelDefinition,
): Promise<SavedFunnel> {
  const body = expectShape(
    await apiRequest(funnelsPath(projectId), {
      method: "POST",
      body: { name: name.trim(), steps, count, window },
    }),
    hasFunnel,
  );
  return body.funnel;
}

/**
 * PUT /api/projects/:id/funnels/:funnelId: replaces the name and the
 * definition of the funnel as read. Refused (funnel_changed) when it was
 * changed since, such as in another tab, so that change is not undone.
 */
export async function updateFunnel(
  projectId: string,
  read: Pick<SavedFunnel, "id" | "updatedAt">,
  name: string,
  { steps, count, window }: FunnelDefinition,
): Promise<SavedFunnel> {
  const body = expectShape(
    await apiRequest(funnelPath(projectId, read.id), {
      method: "PUT",
      body: { name: name.trim(), steps, count, window, updatedAt: read.updatedAt },
    }),
    hasFunnel,
  );
  return body.funnel;
}

/** Why a change to a saved funnel failed, for people. */
export const changeFailure = (error: Error): string =>
  error instanceof ApiError && error.code === "funnel_changed"
    ? "The funnel changed elsewhere after this page loaded it, such as in another tab. The saved version is now reloaded. Review it. Then save again."
    : error.message;

/** DELETE /api/projects/:id/funnels/:funnelId */
export async function deleteFunnel(projectId: string, funnelId: string): Promise<void> {
  await apiRequest(funnelPath(projectId, funnelId), { method: "DELETE" });
}
