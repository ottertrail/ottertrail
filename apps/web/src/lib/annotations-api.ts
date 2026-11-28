import { queryOptions } from "@tanstack/react-query";

import { apiRequest, expectShape } from "./api";
import { characters } from "./text";

/*
 * Notes on the Web analytics chart and each release's first appearance
 * (docs/web-analytics.md, "Notes and releases on the chart"). The
 * dashboard's only: a shared link never reads them.
 */

export interface Annotation {
  id: string;
  /** "YYYY-MM-DD" in the instance's timezone. */
  day: string;
  /** "HH:MM" in the instance's timezone, or null for the whole day. */
  time: string | null;
  text: string;
  /** null: every environment. */
  environment: string | null;
  /** Who last wrote it; null once that user is removed. */
  author: { id: string; name: string } | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReleaseMark {
  release: string;
  firstSeen: string;
  /** "YYYY-MM-DDTHH:mm" in the instance's timezone. */
  local: string;
}

export interface AnnotationFields {
  day: string;
  time: string | null;
  text: string;
  environment: string | null;
}

/** A note's longest text, after trimming, as the API allows. */
export const MAX_NOTE_LENGTH = 200;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === "string";
const isTextOrNull = (value: unknown) => value === null || isText(value);

const isAnnotation = (value: unknown): value is Annotation =>
  isRecord(value) &&
  isText(value.id) &&
  isText(value.day) &&
  isTextOrNull(value.time) &&
  isText(value.text) &&
  isTextOrNull(value.environment) &&
  (value.author === null ||
    (isRecord(value.author) && isText(value.author.id) && isText(value.author.name))) &&
  isText(value.createdAt) &&
  isText(value.updatedAt);

const isReleaseMark = (value: unknown): value is ReleaseMark =>
  isRecord(value) && isText(value.release) && isText(value.firstSeen) && isText(value.local);

// eslint-disable-next-line no-control-regex -- control characters are what the API refuses
const CONTROL = /[\u0000-\u001F\u007F]/u;

/** Why the API would refuse a note's text; null when it would not. */
export function noteTextProblem(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed === "") return "Write the note.";
  if (characters(trimmed) > MAX_NOTE_LENGTH) {
    return `A note has at most ${MAX_NOTE_LENGTH} characters.`;
  }
  if (CONTROL.test(trimmed)) return "A note is one line of text.";
  return null;
}

const projectPath = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}`;

/** The days a chart covers, and the environment it shows. */
export interface MarksRange {
  from: string;
  to: string;
  environment: string;
}

const rangeParams = ({ from, to, environment }: MarksRange) =>
  new URLSearchParams({ from, to, environment }).toString();

/** GET /api/projects/:id/annotations: the notes of the range, for its environment and for all. */
export const annotationsQuery = (projectId: string, range: MarksRange) =>
  queryOptions({
    queryKey: ["annotations", projectId, range],
    queryFn: async ({ signal }) =>
      expectShape(
        await apiRequest(`${projectPath(projectId)}/annotations?${rangeParams(range)}`, {
          signal,
        }),
        (value): value is { annotations: Annotation[] } =>
          isRecord(value) &&
          Array.isArray(value.annotations) &&
          value.annotations.every(isAnnotation),
      ).annotations,
  });

/** GET /api/projects/:id/release-marks: the releases first seen in the range. */
export const releaseMarksQuery = (projectId: string, range: MarksRange) =>
  queryOptions({
    queryKey: ["release-marks", projectId, range],
    queryFn: async ({ signal }) =>
      expectShape(
        await apiRequest(`${projectPath(projectId)}/release-marks?${rangeParams(range)}`, {
          signal,
        }),
        (value): value is { releases: ReleaseMark[] } =>
          isRecord(value) && Array.isArray(value.releases) && value.releases.every(isReleaseMark),
      ).releases,
  });

const noteShape = (value: unknown): value is { annotation: Annotation } =>
  isRecord(value) && isAnnotation(value.annotation);

/** POST /api/projects/:id/annotations */
export async function createAnnotation(
  projectId: string,
  fields: AnnotationFields,
): Promise<Annotation> {
  return expectShape(
    await apiRequest(`${projectPath(projectId)}/annotations`, { method: "POST", body: fields }),
    noteShape,
  ).annotation;
}

/** PUT /api/projects/:id/annotations/:annotationId */
export async function updateAnnotation(
  projectId: string,
  annotationId: string,
  fields: AnnotationFields,
): Promise<Annotation> {
  return expectShape(
    await apiRequest(`${projectPath(projectId)}/annotations/${encodeURIComponent(annotationId)}`, {
      method: "PUT",
      body: fields,
    }),
    noteShape,
  ).annotation;
}

/** DELETE /api/projects/:id/annotations/:annotationId */
export async function deleteAnnotation(projectId: string, annotationId: string): Promise<void> {
  await apiRequest(`${projectPath(projectId)}/annotations/${encodeURIComponent(annotationId)}`, {
    method: "DELETE",
  });
}
