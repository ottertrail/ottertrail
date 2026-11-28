import { queryOptions } from "@tanstack/react-query";

import { type Filter, filterParams, type Filters, filtersFrom } from "./analytics-api";
import { ApiError, apiRequest, expectShape } from "./api";
import { nameProblem } from "./text";

/**
 * Saved segments (docs/web-analytics.md, "Segments"): named Web analytics
 * filters, for one person or for the project. The period, the environment,
 * and the goal stay the page's.
 */
export type Visibility = "personal" | "project";

export interface Segment {
  id: string;
  name: string;
  visibility: Visibility;
  /** As the API's query takes them; null when the API would refuse them now. */
  filters: Record<string, string[]> | null;
  createdAt: string;
  updatedAt: string;
}

/** As the API allows. */
export const MAX_PROJECT_SEGMENTS = 50;
export const MAX_PERSONAL_SEGMENTS = 50;
export const MAX_SEGMENT_NAME = 100;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === "string";

const isFilterQuery = (value: unknown): value is Record<string, string[]> =>
  isRecord(value) &&
  Object.values(value).every((values) => Array.isArray(values) && values.every(isText));

export const isSegment = (value: unknown): value is Segment =>
  isRecord(value) &&
  isText(value.id) &&
  isText(value.name) &&
  (value.visibility === "personal" || value.visibility === "project") &&
  (value.filters === null || isFilterQuery(value.filters)) &&
  isText(value.createdAt) &&
  isText(value.updatedAt);

/** Why a segment's name would be refused, as the API checks it; null when it would not. */
export const segmentNameProblem = (name: string) => nameProblem(name, "segment", MAX_SEGMENT_NAME);

/** A filter's values as a set, so two lists of the same values compare equal. */
const keyOf = (filters: Filters) =>
  JSON.stringify(filters.map((filter) => [filter.name, filter.operator, filter.values.toSorted()]));

/**
 * The page's filters for a segment, or null when the page would not take
 * them all as they are, such as a filter it no longer has. Then the
 * segment is shown as invalid instead of applying only part of it.
 */
export function segmentFilters(segment: Segment): Filter[] | null {
  if (segment.filters === null) return null;
  const filters = filtersFrom(segment.filters);
  const kept = new Map(Object.entries(filterParams(filters)));
  const sent = Object.entries(segment.filters);
  const whole =
    filters.length > 0 &&
    sent.length === filters.length &&
    sent.every(
      ([parameter, values]) =>
        JSON.stringify(kept.get(parameter)?.toSorted()) ===
        JSON.stringify([...new Set(values)].toSorted()),
    );
  return whole ? filters : null;
}

/** Whether the page's filters are the segment's, in any order. */
export const matchesSegment = (filters: Filters, segment: Segment): boolean => {
  const own = segmentFilters(segment);
  return own !== null && keyOf(own) === keyOf(filters);
};

const segmentsPath = (projectId: string) =>
  `/api/projects/${encodeURIComponent(projectId)}/segments`;
const segmentPath = (projectId: string, segment: Pick<Segment, "id" | "visibility">) =>
  `${segmentsPath(projectId)}/${segment.visibility}/${encodeURIComponent(segment.id)}`;

const hasSegment = (value: unknown): value is { segment: Segment } =>
  isRecord(value) && isSegment(value.segment);

export const segmentsKey = (projectId: string) => ["segments", projectId] as const;

/** GET /api/projects/:id/segments: the project's segments and the user's own, by name. */
export const segmentsQuery = (projectId: string) =>
  queryOptions({
    queryKey: segmentsKey(projectId),
    queryFn: async ({ signal }) =>
      expectShape(
        await apiRequest(segmentsPath(projectId), { signal }),
        (value): value is { segments: Segment[] } =>
          isRecord(value) && Array.isArray(value.segments) && value.segments.every(isSegment),
      ).segments,
  });

/** POST /api/projects/:id/segments/:visibility: the new segment, or an ApiError. */
export async function createSegment(
  projectId: string,
  visibility: Visibility,
  name: string,
  filters: Filters,
): Promise<Segment> {
  return expectShape(
    await apiRequest(`${segmentsPath(projectId)}/${visibility}`, {
      method: "POST",
      body: { name: name.trim(), filters: filterParams(filters) },
    }),
    hasSegment,
  ).segment;
}

/**
 * PUT /api/projects/:id/segments/:visibility/:segmentId: a new name, new
 * filters, or both. Refused (segment_changed) when it changed since read.
 */
export async function updateSegment(
  projectId: string,
  read: Pick<Segment, "id" | "visibility" | "updatedAt">,
  name: string,
  filters: Filters,
): Promise<Segment> {
  return expectShape(
    await apiRequest(segmentPath(projectId, read), {
      method: "PUT",
      body: { name: name.trim(), filters: filterParams(filters), updatedAt: read.updatedAt },
    }),
    hasSegment,
  ).segment;
}

/** DELETE /api/projects/:id/segments/:visibility/:segmentId; one already gone counts as deleted. */
export async function deleteSegment(
  projectId: string,
  segment: Pick<Segment, "id" | "visibility">,
): Promise<void> {
  try {
    await apiRequest(segmentPath(projectId, segment), { method: "DELETE" });
  } catch (error) {
    if (!(error instanceof ApiError && error.code === "segment_not_found")) throw error;
  }
}

/** Why a change failed, for people. */
export const segmentFailure = (error: Error): string =>
  error instanceof ApiError && error.code === "segment_changed"
    ? "The segment changed elsewhere, and has been reloaded. Try again."
    : error.message;
