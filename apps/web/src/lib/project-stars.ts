import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";

import { apiRequest, expectShape } from "./api";

/*
 * Starred projects: each user's own (docs/dashboard.md, "Starred
 * projects"). The API lists only projects the user may still reach.
 */

const STARRED_KEY = ["starred-projects"] as const;

const isStarred = (value: unknown): value is { projectIds: string[] } =>
  typeof value === "object" &&
  value !== null &&
  "projectIds" in value &&
  Array.isArray(value.projectIds) &&
  value.projectIds.every((id) => typeof id === "string");

/** The IDs of the projects the signed-in user starred, oldest star first. */
export const starredProjectsQuery = () =>
  queryOptions({
    queryKey: STARRED_KEY,
    queryFn: async ({ signal }) =>
      expectShape(await apiRequest("/api/starred-projects", { signal }), isStarred).projectIds,
  });

async function setStar(projectId: string, starred: boolean) {
  await apiRequest(`/api/starred-projects/${encodeURIComponent(projectId)}`, {
    method: starred ? "PUT" : "DELETE",
  });
}

/**
 * Stars or unstars a project. The list changes at once, so the sidebar and
 * the Projects page follow the click; a failure puts that one project back
 * as it was and leaves the error on the mutation.
 */
export function useProjectStar() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: STARRED_KEY,
    mutationFn: ({ projectId, starred }: { projectId: string; starred: boolean }) =>
      setStar(projectId, starred),
    onMutate: async ({ projectId, starred }) => {
      await queryClient.cancelQueries({ queryKey: STARRED_KEY });
      queryClient.setQueryData<string[]>(STARRED_KEY, (list = []) => {
        const others = list.filter((id) => id !== projectId);
        return starred ? [...others, projectId] : others;
      });
    },
    onError: (_error, { projectId, starred }) => {
      // Only this project goes back: another star clicked meanwhile keeps its change.
      queryClient.setQueryData<string[]>(STARRED_KEY, (list = []) => {
        const others = list.filter((id) => id !== projectId);
        return starred ? others : [...others, projectId];
      });
    },
    onSettled: async () => {
      // Read the list again once the last change of a quick run is done.
      if (queryClient.isMutating({ mutationKey: STARRED_KEY }) <= 1) {
        await queryClient.invalidateQueries({ queryKey: STARRED_KEY });
      }
    },
  });
}
