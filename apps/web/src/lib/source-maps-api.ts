import { queryOptions } from "@tanstack/react-query";

import { apiRequest, expectShape } from "./api";

/**
 * Builds upload maps per release and minified file with the project secret key.
 * The dashboard lists and deletes them (docs/errors.md, "Source maps").
 */

export interface SourceMapRelease {
  release: string;
  files: number;
  /** Compressed, as stored. */
  bytes: number;
  lastUploadedAt: string;
}

/** GET /api/projects/:id/source-maps */
export interface SourceMapOverview {
  /** false: the install has no object store, so source maps are off. */
  configured: boolean;
  /**
   * What all projects' maps take together, and the instance's limit: only
   * for those who manage projects (docs/access.md).
   */
  instance?: { storedBytes: number; limitBytes: number };
  /** Which come first: by their latest upload. */
  order: ReleaseOrder;
  /** At most 100, in `order`. */
  releases: SourceMapRelease[];
  /** How many releases have maps in all: more than `releases` holds when over 100. */
  totalReleases: number;
}

/** Newest releases first, or oldest: the oldest are the ones to delete for room. */
export type ReleaseOrder = "newest" | "oldest";

export interface SourceMapFile {
  release: string;
  /** The minified file's path as the browser loads it, such as /assets/index-4f3a.js. */
  path: string;
  bytes: number;
  uploadedAt: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === "string";
const isNumber = (value: unknown): value is number => typeof value === "number";

const isRelease = (value: unknown): value is SourceMapRelease =>
  isRecord(value) &&
  isText(value.release) &&
  isNumber(value.files) &&
  isNumber(value.bytes) &&
  isText(value.lastUploadedAt);

const isOverview = (value: unknown): value is SourceMapOverview =>
  isRecord(value) &&
  typeof value.configured === "boolean" &&
  (value.instance === undefined ||
    (isRecord(value.instance) &&
      isNumber(value.instance.storedBytes) &&
      isNumber(value.instance.limitBytes))) &&
  (value.order === "newest" || value.order === "oldest") &&
  Array.isArray(value.releases) &&
  value.releases.every(isRelease) &&
  isNumber(value.totalReleases);

const isFile = (value: unknown): value is SourceMapFile =>
  isRecord(value) &&
  isText(value.release) &&
  isText(value.path) &&
  isNumber(value.bytes) &&
  isText(value.uploadedAt);

const sourceMapsPath = (projectId: string) =>
  `/api/projects/${encodeURIComponent(projectId)}/source-maps`;

/** The key every source map change invalidates: the list and each release's files. */
export const sourceMapsKey = (projectId: string) => ["source-maps", projectId] as const;

/** The project's releases with maps, newest or oldest first, and the use of all projects together. */
export const sourceMapsQuery = (projectId: string, order: ReleaseOrder = "newest") =>
  queryOptions({
    queryKey: [...sourceMapsKey(projectId), "list", order],
    queryFn: async ({ signal }) =>
      expectShape(
        await apiRequest(
          order === "newest"
            ? sourceMapsPath(projectId)
            : `${sourceMapsPath(projectId)}?order=oldest`,
          { signal },
        ),
        isOverview,
      ),
  });

/** One release's files, by path. */
export const sourceMapFilesQuery = (projectId: string, release: string) =>
  queryOptions({
    queryKey: [...sourceMapsKey(projectId), "files", release],
    queryFn: async ({ signal }) => {
      const body = expectShape(
        await apiRequest(
          `${sourceMapsPath(projectId)}/files?${new URLSearchParams({ release }).toString()}`,
          { signal },
        ),
        (value): value is { release: string; files: SourceMapFile[] } =>
          isRecord(value) &&
          isText(value.release) &&
          Array.isArray(value.files) &&
          value.files.every(isFile),
      );
      return body.files;
    },
  });

/** DELETE /api/projects/:id/source-maps?release=…: the release's maps, or an ApiError (no_source_maps …). */
export async function deleteSourceMaps(projectId: string, release: string): Promise<void> {
  await apiRequest(`${sourceMapsPath(projectId)}?${new URLSearchParams({ release }).toString()}`, {
    method: "DELETE",
  });
}

const SIZE_UNITS = ["KB", "MB", "GB"] as const;

/** "512 bytes", "4.2 KB", "38 MB", "1 GB": sizes in powers of 1,024, as they are stored. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} ${bytes === 1 ? "byte" : "bytes"}`;
  let value = bytes;
  let unit: (typeof SIZE_UNITS)[number] = "KB";
  for (const next of SIZE_UNITS) {
    value /= 1024;
    unit = next;
    if (value < 1024) break;
  }
  const digits = value < 10 && !Number.isInteger(value) ? 1 : 0;
  return `${value.toLocaleString("en", { maximumFractionDigits: digits })} ${unit}`;
}
