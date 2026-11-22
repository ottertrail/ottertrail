import { keepPreviousData, queryOptions } from "@tanstack/react-query";

import { DEFAULT_ENVIRONMENT, type PageRange, rangeParams } from "./analytics-api";
import { apiRequest, expectShape } from "./api";
import { isListOf, isNumber, isRecord, isText, isTextOrNull } from "./telemetry-shapes";

/** The device classes heatmaps are split by, in the picker's order; left out means all. */
export const HEATMAP_DEVICES = [
  { value: "desktop", label: "Desktop" },
  { value: "tablet", label: "Tablet" },
  { value: "mobile", label: "Mobile" },
] as const;

export type HeatmapDevice = (typeof HEATMAP_DEVICES)[number]["value"];

export const isHeatmapDevice = (value: unknown): value is HeatmapDevice =>
  HEATMAP_DEVICES.some((item) => item.value === value);

/** What both heatmap answers start with: the range, the environment, and the setting. */
interface HeatmapRange {
  timeZone: string;
  environment: string;
  environments: string[];
  firstDay: string;
  lastDay: string;
  /** The project's setting: whether the tracker is asked to send heatmap data. */
  heatmaps: boolean;
  /** How long heatmap data is kept (90). */
  retentionDays: number;
  /** The range asked for began before the days kept; `firstDay` is then the first kept day. */
  clipped: boolean;
  /** The project's allowed hostnames: where "Open on your site" can open the page. */
  siteHostnames: string[];
}

/** GET /api/projects/:id/heatmaps/pages */
export interface HeatmapPages extends HeatmapRange {
  /** Most pageviews first, at most 100. */
  pages: { path: string; pageviews: number; clicks: number }[];
}

export interface HeatmapElement {
  /** The site's own name (`data-ottertrail-name`), on the element or its nearest ancestor. */
  label: string | null;
  /** The structural path, such as `body>main>section:2>div>a`; "*>" first when cut. */
  element: string;
  clicks: number;
  /** Of the page's clicks, 0 to 1. */
  share: number;
  rageClicks: number;
  /** Clicks after which nothing on the page responded within a second. */
  deadClicks: number;
  /** Where in the element the clicks fell, on average, 0 to 1. */
  x: number;
  y: number;
}

export interface HeatmapHotspot {
  label: string | null;
  element: string;
  rageClicks: number;
  x: number;
  y: number;
}

export interface HeatmapDeadHotspot {
  label: string | null;
  element: string;
  deadClicks: number;
  /** Where in the element the dead clicks fell, on average, 0 to 1. */
  x: number;
  y: number;
}

/** GET /api/projects/:id/heatmaps?path=… */
export interface Heatmap extends HeatmapRange {
  path: string;
  device: HeatmapDevice | null;
  /** The path's pageviews per device in the range, whatever the device filter. */
  devices: { device: string; pageviews: number }[];
  totals: {
    /** Pageviews with heatmap data: sampled pageviews that sent a scroll depth. */
    pageviews: number;
    clicks: number;
    rageClicks: number;
    deadClicks: number;
    /** Clicks not recorded because a pageview passed 100 clicks. */
    droppedClicks: number;
    /** Shares of the page's height, 0 to 1. */
    medianDepth: number | null;
    /** Of pageviews, 0 to 1. */
    reachedBottom: number | null;
  };
  scroll: {
    /** Depths 10, 20, … 100 (percent of the page's height), with the share of pageviews reaching each. */
    reach: { depth: number; pageviews: number; share: number }[];
    /** The share of the page visible without scrolling, on average, 0 to 1. */
    averageFold: number | null;
  };
  /** Most clicks first, at most 100. */
  elements: HeatmapElement[];
  /** Most rage clicks first, at most 20. */
  hotspots: HeatmapHotspot[];
  /** Most dead clicks first, at most 20. */
  deadHotspots: HeatmapDeadHotspot[];
}

const isNumberOrNull = (value: unknown): value is number | null =>
  value === null || isNumber(value);

const isRange = (value: unknown): value is HeatmapRange =>
  isRecord(value) &&
  isText(value.timeZone) &&
  isText(value.environment) &&
  isListOf(value.environments, isText) &&
  isText(value.firstDay) &&
  isText(value.lastDay) &&
  typeof value.heatmaps === "boolean" &&
  isNumber(value.retentionDays) &&
  typeof value.clipped === "boolean" &&
  isListOf(value.siteHostnames, isText);

const isPageRow = (value: unknown): value is HeatmapPages["pages"][number] =>
  isRecord(value) && isText(value.path) && isNumber(value.pageviews) && isNumber(value.clicks);

const isPages = (value: unknown): value is HeatmapPages =>
  isRange(value) && isRecord(value) && isListOf(value.pages, isPageRow);

const isPosition = (value: Record<string, unknown>) => isNumber(value.x) && isNumber(value.y);

const isElement = (value: unknown): value is HeatmapElement =>
  isRecord(value) &&
  isTextOrNull(value.label) &&
  isText(value.element) &&
  isNumber(value.clicks) &&
  isNumber(value.share) &&
  isNumber(value.rageClicks) &&
  isNumber(value.deadClicks) &&
  isPosition(value);

const isHotspot = (value: unknown): value is HeatmapHotspot =>
  isRecord(value) &&
  isTextOrNull(value.label) &&
  isText(value.element) &&
  isNumber(value.rageClicks) &&
  isPosition(value);

const isDeadHotspot = (value: unknown): value is HeatmapDeadHotspot =>
  isRecord(value) &&
  isTextOrNull(value.label) &&
  isText(value.element) &&
  isNumber(value.deadClicks) &&
  isPosition(value);

const isReach = (value: unknown): value is Heatmap["scroll"]["reach"][number] =>
  isRecord(value) && isNumber(value.depth) && isNumber(value.pageviews) && isNumber(value.share);

const isHeatmap = (value: unknown): value is Heatmap =>
  isRange(value) &&
  isRecord(value) &&
  isText(value.path) &&
  (value.device === null || isHeatmapDevice(value.device)) &&
  isListOf(
    value.devices,
    (item): item is Heatmap["devices"][number] =>
      isRecord(item) && isText(item.device) && isNumber(item.pageviews),
  ) &&
  isRecord(value.totals) &&
  isNumber(value.totals.pageviews) &&
  isNumber(value.totals.clicks) &&
  isNumber(value.totals.rageClicks) &&
  isNumber(value.totals.deadClicks) &&
  isNumber(value.totals.droppedClicks) &&
  isNumberOrNull(value.totals.medianDepth) &&
  isNumberOrNull(value.totals.reachedBottom) &&
  isRecord(value.scroll) &&
  isListOf(value.scroll.reach, isReach) &&
  isNumberOrNull(value.scroll.averageFold) &&
  isListOf(value.elements, isElement) &&
  isListOf(value.hotspots, isHotspot) &&
  isListOf(value.deadHotspots, isDeadHotspot);

/** The range, environment, and device as the API's query parameters. */
const params = (range: PageRange, environment: string, device: HeatmapDevice | undefined) => ({
  ...rangeParams(range),
  ...(environment === DEFAULT_ENVIRONMENT ? {} : { environment }),
  ...(device === undefined ? {} : { device }),
});

/** The pages with heatmap data, most pageviews first; `search` is part of a path. */
export const heatmapPagesQuery = (
  projectId: string,
  range: PageRange,
  environment: string,
  device: HeatmapDevice | undefined,
  search = "",
) =>
  queryOptions({
    queryKey: ["heatmaps", projectId, "pages", range, environment, device, search],
    queryFn: async ({ signal }) => {
      const query = new URLSearchParams({
        ...params(range, environment, device),
        ...(search === "" ? {} : { search }),
      });
      return expectShape(
        await apiRequest(
          `/api/projects/${encodeURIComponent(projectId)}/heatmaps/pages?${query.toString()}`,
          { signal },
        ),
        isPages,
      );
    },
    // While another period or search loads, keep showing the last list (dimmed).
    placeholderData: keepPreviousData,
  });

/** One page's clicks and scroll depth. */
export const heatmapQuery = (
  projectId: string,
  range: PageRange,
  environment: string,
  device: HeatmapDevice | undefined,
  path: string,
) =>
  queryOptions({
    queryKey: ["heatmaps", projectId, "page", range, environment, device, path],
    queryFn: async ({ signal }) => {
      const query = new URLSearchParams({ path, ...params(range, environment, device) });
      return expectShape(
        await apiRequest(
          `/api/projects/${encodeURIComponent(projectId)}/heatmaps?${query.toString()}`,
          { signal },
        ),
        isHeatmap,
      );
    },
    placeholderData: keepPreviousData,
  });

/**
 * POST /api/projects/:id/heatmaps/overlay-link: a one-time link token that
 * opens the page with its heatmap over it, working once within 5 minutes
 * (docs/web-analytics.md, "The overlay on your site"). Made only when the
 * reader asks to open it.
 */
export async function mintOverlayLink(projectId: string, path: string): Promise<{ token: string }> {
  return expectShape(
    // The page it opens: the overlay may save a view of that page only.
    await apiRequest(`/api/projects/${encodeURIComponent(projectId)}/heatmaps/overlay-link`, {
      method: "POST",
      body: { path },
    }),
    (value): value is { token: string } => isRecord(value) && isText(value.token),
  );
}

/** One saved view of a page (docs/web-analytics.md, "Saved views"). */
export interface HeatmapSnapshot {
  device: HeatmapDevice;
  /** The viewport it was saved at, in CSS pixels. */
  width: number;
  height: number;
  pageHeight: number;
  savedAt: string;
  /** Who saved it; null once that user was removed. */
  savedBy: string | null;
}

/** GET /api/projects/:id/heatmaps/snapshots?path=… */
export interface HeatmapSnapshots {
  /** Whether the server can keep saved views: it has an object store. */
  configured: boolean;
  snapshots: HeatmapSnapshot[];
}

const isSnapshot = (value: unknown): value is HeatmapSnapshot =>
  isRecord(value) &&
  isHeatmapDevice(value.device) &&
  isNumber(value.width) &&
  isNumber(value.height) &&
  isNumber(value.pageHeight) &&
  isText(value.savedAt) &&
  isTextOrNull(value.savedBy);

const isSnapshots = (value: unknown): value is HeatmapSnapshots =>
  isRecord(value) && typeof value.configured === "boolean" && isListOf(value.snapshots, isSnapshot);

export const heatmapSnapshotsKey = (projectId: string, path: string) =>
  ["heatmaps", projectId, "snapshots", path] as const;

/** The page's saved views, one per device class at most. */
export const heatmapSnapshotsQuery = (projectId: string, path: string) =>
  queryOptions({
    queryKey: heatmapSnapshotsKey(projectId, path),
    queryFn: async ({ signal }) =>
      expectShape(
        await apiRequest(
          `/api/projects/${encodeURIComponent(projectId)}/heatmaps/snapshots?${new URLSearchParams({ path }).toString()}`,
          { signal },
        ),
        isSnapshots,
      ),
  });

/**
 * The page that shows a saved view with the heatmap over it, for the
 * report's range and environment: the replay player's, served by the API
 * under its own Content Security Policy.
 */
export function snapshotPlayerSrc(
  projectId: string,
  device: HeatmapDevice,
  path: string,
  range: PageRange,
  environment: string,
): string {
  const query = new URLSearchParams({ path, ...params(range, environment, undefined) });
  return `/api/projects/${encodeURIComponent(projectId)}/heatmaps/snapshots/${device}/player?${query.toString()}`;
}

/** DELETE /api/projects/:id/heatmaps/snapshots/:device?path=… */
export async function deleteHeatmapSnapshot(
  projectId: string,
  device: HeatmapDevice,
  path: string,
): Promise<void> {
  await apiRequest(
    `/api/projects/${encodeURIComponent(projectId)}/heatmaps/snapshots/${device}?${new URLSearchParams({ path }).toString()}`,
    { method: "DELETE" },
  );
}
