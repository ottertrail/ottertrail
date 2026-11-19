import { QueryParams, queryRows, type Reader } from "../clickhouse/query.ts";
import { DEFAULT_ENVIRONMENT } from "../collection/environment.ts";
import { DEVICES, type HeatmapDevice, UNITS } from "./store.ts";

/**
 * The Heatmaps screen's figures (docs/web-analytics.md, "Heatmaps"), from
 * ClickHouse's `heatmaps` table. Every query filters by project first,
 * then the range, passes every value as a parameter, has a LIMIT or
 * returns one row. One page's report reads with FINAL: a retried batch is
 * a second copy until its parts merge, and FINAL counts it once, as reports
 * of events do; one page's rows are few, so it costs little. The page
 * picker reads every page of the project over up to 90 days, so it reads
 * without FINAL and counts distinct record IDs instead: a scroll row is
 * sent again as the visitor scrolls further, and a retry is a copy, and
 * each counts once. The table merges each day's parts once they are an
 * hour old (migration 0006), so copies do not pile up.
 */

/** Pages the picker lists, most pageviews first. */
export const HEATMAP_PAGES = 100;
/** Elements a report lists, most clicks first. */
export const HEATMAP_ELEMENTS = 100;
/** Rage-click hotspots a report lists. */
export const HEATMAP_HOTSPOTS = 20;
/** Scroll reach is counted at every tenth of the page: 10%, 20% … 100%. */
export const REACH_STEPS = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100] as const;

export interface HeatmapRange {
  projectId: string;
  environment: string;
  from: Date;
  to: Date;
  /** Only this device class, when given. */
  device?: HeatmapDevice | undefined;
}

export interface HeatmapPage {
  path: string;
  /** Pageviews that sent a scroll depth: those sampled for heatmaps. */
  pageviews: number;
  clicks: number;
}

export interface HeatmapElement {
  /** The site's data-ottertrail-name, or null. */
  label: string | null;
  /** The structural path. */
  element: string;
  clicks: number;
  /** Of the page's clicks, 0 to 1. */
  share: number;
  rageClicks: number;
  /** Where in the element the clicks fell, on average, 0 to 1. */
  x: number;
  y: number;
}

export interface HeatmapReport {
  devices: { device: HeatmapDevice; pageviews: number }[];
  totals: {
    pageviews: number;
    clicks: number;
    rageClicks: number;
    /** The median pageview's deepest share of the page, 0 to 1; null without pageviews. */
    medianDepth: number | null;
    /** The share of pageviews that reached the bottom; null without pageviews. */
    reachedBottom: number | null;
    /** Clicks not recorded: past the 100 a pageview sends. */
    droppedClicks: number;
  };
  scroll: {
    /** For each tenth of the page, the pageviews that reached it, and their share. */
    reach: { depth: number; pageviews: number; share: number }[];
    /**
     * The share of the page visible without scrolling, on average, as each
     * pageview first showed; null without pageviews.
     */
    averageFold: number | null;
  };
  elements: HeatmapElement[];
  hotspots: { label: string | null; element: string; rageClicks: number; x: number; y: number }[];
}

const count = (raw: unknown) => Number(raw ?? 0);
const share = (part: number, whole: number) => (whole === 0 ? 0 : part / whole);
const fraction = (raw: unknown): number | null => {
  const value = Number(raw);
  return raw === null || raw === undefined || !Number.isFinite(value) ? null : value;
};
const round = (value: number) => Math.round(value * 10_000) / 10_000;
const labelOf = (raw: unknown) => (typeof raw === "string" && raw !== "" ? raw : null);

/** The rows of the range, project first; `device` narrows to one class unless `allDevices`. */
function scope(params: QueryParams, range: HeatmapRange, { allDevices = false } = {}): string {
  return `project_id = ${params.add(range.projectId, "UUID")}
    AND occurred_at >= ${params.time(range.from)}
    AND occurred_at < ${params.time(range.to)}
    AND environment = ${params.add(range.environment, "String")}
    ${allDevices || range.device === undefined ? "" : `AND device = ${params.add(range.device, "String")}`}`;
}

/**
 * The environments with heatmap data in the range, most rows first, then
 * the one shown and production even without: the page can switch back.
 */
export async function heatmapEnvironments(reader: Reader, range: HeatmapRange): Promise<string[]> {
  const params = new QueryParams();
  const rows = await queryRows<{ environment: string }>(
    reader,
    `SELECT environment FROM heatmaps
     WHERE project_id = ${params.add(range.projectId, "UUID")}
       AND occurred_at >= ${params.time(range.from)}
       AND occurred_at < ${params.time(range.to)}
     GROUP BY environment
     ORDER BY count() DESC, environment
     LIMIT 100`,
    params,
  );
  const names = rows.map((row) => row.environment);
  for (const name of [range.environment, DEFAULT_ENVIRONMENT]) {
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

/**
 * The pages with heatmap data, for the picker: most records first (sampled
 * pageviews and clicks together, so a page whose scroll depths have not
 * arrived yet is listed too), `search` a part of the path. Without FINAL
 * (above).
 */
export async function heatmapPages(
  reader: Reader,
  range: HeatmapRange,
  search?: string,
): Promise<HeatmapPage[]> {
  const params = new QueryParams();
  const rows = await queryRows<Record<string, unknown>>(
    reader,
    `SELECT path, uniqExactIf(record_id, kind = 'scroll') AS pageviews,
            uniqExactIf(record_id, kind = 'click') AS clicks
     FROM heatmaps
     WHERE ${scope(params, range)}
       ${search === undefined || search === "" ? "" : `AND positionCaseInsensitiveUTF8(path, ${params.add(search, "String")}) > 0`}
     GROUP BY path
     ORDER BY pageviews + clicks DESC, pageviews DESC, path
     LIMIT ${HEATMAP_PAGES}`,
    params,
  );
  return rows.map((row) => ({
    path: String(row.path),
    pageviews: count(row.pageviews),
    clicks: count(row.clicks),
  }));
}

/** One page's report: five queries, run side by side. */
export async function heatmapReport(
  reader: Reader,
  range: HeatmapRange,
  path: string,
): Promise<HeatmapReport> {
  const onPage = (params: QueryParams, options?: { allDevices?: boolean }) =>
    `${scope(params, range, options)} AND path = ${params.add(path, "String")}`;
  const summaryParams = new QueryParams();
  const deviceParams = new QueryParams();
  const elementParams = new QueryParams();
  const hotspotParams = new QueryParams();
  // Thousandths: depth 1000 is the bottom of the page.
  const reach = REACH_STEPS.map(
    (step) => `countIf(kind = 'scroll' AND depth >= ${(step * UNITS) / 100}) AS reach_${step}`,
  ).join(",\n");

  const [[summary], devices, elements, hotspots] = await Promise.all([
    queryRows<Record<string, unknown>>(
      reader,
      `SELECT countIf(kind = 'scroll') AS pageviews,
              countIf(kind = 'click') AS clicks,
              countIf(kind = 'click' AND rage) AS rage_clicks,
              quantileExactInclusiveIf(0.5)(depth, kind = 'scroll') / ${UNITS} AS median_depth,
              countIf(kind = 'scroll' AND depth >= ${UNITS}) AS bottom,
              avgIf(fold, kind = 'scroll') / ${UNITS} AS fold,
              sumIf(dropped, kind = 'scroll') AS dropped,
              ${reach}
       FROM heatmaps FINAL
       WHERE ${onPage(summaryParams)}`,
      summaryParams,
    ),
    queryRows<{ device: HeatmapDevice; pageviews: string }>(
      reader,
      `SELECT device, countIf(kind = 'scroll') AS pageviews
       FROM heatmaps FINAL
       WHERE ${onPage(deviceParams, { allDevices: true })}
       GROUP BY device
       ORDER BY pageviews DESC, device`,
      deviceParams,
    ),
    queryRows<Record<string, unknown>>(
      reader,
      `SELECT label, element, count() AS clicks, countIf(rage) AS rage_clicks,
              avg(x) / ${UNITS} AS x, avg(y) / ${UNITS} AS y
       FROM heatmaps FINAL
       WHERE ${onPage(elementParams)} AND kind = 'click'
       GROUP BY label, element
       ORDER BY clicks DESC, label, element
       LIMIT ${HEATMAP_ELEMENTS}`,
      elementParams,
    ),
    queryRows<Record<string, unknown>>(
      reader,
      `SELECT label, element, count() AS rage_clicks, avg(x) / ${UNITS} AS x, avg(y) / ${UNITS} AS y
       FROM heatmaps FINAL
       WHERE ${onPage(hotspotParams)} AND kind = 'click' AND rage
       GROUP BY label, element
       ORDER BY rage_clicks DESC, label, element
       LIMIT ${HEATMAP_HOTSPOTS}`,
      hotspotParams,
    ),
  ]);

  const pageviews = count(summary?.pageviews);
  const clicks = count(summary?.clicks);
  const some = pageviews > 0;
  return {
    devices: devices
      .filter((row) => DEVICES.includes(row.device))
      .map((row) => ({ device: row.device, pageviews: count(row.pageviews) })),
    totals: {
      pageviews,
      clicks,
      rageClicks: count(summary?.rage_clicks),
      medianDepth: some ? round(fraction(summary?.median_depth) ?? 0) : null,
      reachedBottom: some ? round(share(count(summary?.bottom), pageviews)) : null,
      droppedClicks: count(summary?.dropped),
    },
    scroll: {
      reach: REACH_STEPS.map((depth) => {
        const reached = count(summary?.[`reach_${depth}`]);
        return { depth, pageviews: reached, share: round(share(reached, pageviews)) };
      }),
      averageFold: some ? round(fraction(summary?.fold) ?? 0) : null,
    },
    elements: elements.map((row) => ({
      label: labelOf(row.label),
      element: String(row.element),
      clicks: count(row.clicks),
      share: round(share(count(row.clicks), clicks)),
      rageClicks: count(row.rage_clicks),
      x: round(Number(row.x)),
      y: round(Number(row.y)),
    })),
    hotspots: hotspots.map((row) => ({
      label: labelOf(row.label),
      element: String(row.element),
      rageClicks: count(row.rage_clicks),
      x: round(Number(row.x)),
      y: round(Number(row.y)),
    })),
  };
}

/** A report with nothing in it: for a range wholly before the 90 days kept. */
export function emptyReport(): HeatmapReport {
  return {
    devices: [],
    totals: {
      pageviews: 0,
      clicks: 0,
      rageClicks: 0,
      medianDepth: null,
      reachedBottom: null,
      droppedClicks: 0,
    },
    scroll: {
      reach: REACH_STEPS.map((depth) => ({ depth, pageviews: 0, share: 0 })),
      averageFold: null,
    },
    elements: [],
    hotspots: [],
  };
}

/** Elements the overlay draws, most clicks first. */
export const OVERLAY_ELEMENTS = 200;
/** The grid each element's clicks are counted in: 8 by 8 cells. */
export const OVERLAY_GRID = 8;
/** Cells the overlay gets in all, the busiest first: at most 64 per element. */
export const OVERLAY_CELLS = 3000;
/** The overlay's scroll reach is counted at every twentieth of the page: 5%, 10% … 100%. */
export const OVERLAY_REACH_STEPS = Array.from({ length: 20 }, (_, index) => (index + 1) * 5);

/**
 * What the overlay on the live site draws (heatmaps/overlay-routes.ts):
 * aggregates of one page, device, and range, and nothing about any one
 * pageview. Clicks per element (its label and structural path), with
 * where in the element they fell counted in a coarse 8 by 8 grid of
 * cells; the share of pageviews that reached each 5% of the page.
 */
export interface HeatmapOverlay {
  totals: { pageviews: number; clicks: number; rageClicks: number };
  devices: { device: HeatmapDevice; pageviews: number }[];
  /** For each twentieth of the page, the share of pageviews that reached it, 0 to 1. */
  reach: { depth: number; share: number }[];
  elements: {
    label: string | null;
    element: string;
    clicks: number;
    rageClicks: number;
    /** [column, row, clicks]: columns and rows 0 to 7, from the element's top left. */
    cells: [number, number, number][];
  }[];
}

/** One page's overlay: four queries, run side by side, each project first and with FINAL. */
export async function heatmapOverlay(
  reader: Reader,
  range: HeatmapRange & { device: HeatmapDevice },
  path: string,
): Promise<HeatmapOverlay> {
  const onPage = (params: QueryParams, options?: { allDevices?: boolean }) =>
    `${scope(params, range, options)} AND path = ${params.add(path, "String")}`;
  const summaryParams = new QueryParams();
  const deviceParams = new QueryParams();
  const elementParams = new QueryParams();
  const cellParams = new QueryParams();
  const reach = OVERLAY_REACH_STEPS.map(
    (step) => `countIf(kind = 'scroll' AND depth >= ${(step * UNITS) / 100}) AS reach_${step}`,
  ).join(",\n");
  const cellSize = UNITS / OVERLAY_GRID;
  const topElements = (params: QueryParams) =>
    `SELECT label, element FROM heatmaps FINAL
     WHERE ${onPage(params)} AND kind = 'click'
     GROUP BY label, element
     ORDER BY count() DESC, label, element
     LIMIT ${OVERLAY_ELEMENTS}`;

  const [[summary], devices, elements, cells] = await Promise.all([
    queryRows<Record<string, unknown>>(
      reader,
      `SELECT countIf(kind = 'scroll') AS pageviews,
              countIf(kind = 'click') AS clicks,
              countIf(kind = 'click' AND rage) AS rage_clicks,
              ${reach}
       FROM heatmaps FINAL
       WHERE ${onPage(summaryParams)}`,
      summaryParams,
    ),
    queryRows<{ device: HeatmapDevice; pageviews: string }>(
      reader,
      `SELECT device, countIf(kind = 'scroll') AS pageviews
       FROM heatmaps FINAL
       WHERE ${onPage(deviceParams, { allDevices: true })}
       GROUP BY device
       ORDER BY pageviews DESC, device`,
      deviceParams,
    ),
    queryRows<Record<string, unknown>>(
      reader,
      `SELECT label, element, count() AS clicks, countIf(rage) AS rage_clicks
       FROM heatmaps FINAL
       WHERE ${onPage(elementParams)} AND kind = 'click'
       GROUP BY label, element
       ORDER BY clicks DESC, label, element
       LIMIT ${OVERLAY_ELEMENTS}`,
      elementParams,
    ),
    queryRows<Record<string, unknown>>(
      reader,
      `SELECT label, element,
              least(intDiv(x, ${cellSize}), ${OVERLAY_GRID - 1}) AS cx,
              least(intDiv(y, ${cellSize}), ${OVERLAY_GRID - 1}) AS cy,
              count() AS clicks
       FROM heatmaps FINAL
       WHERE ${onPage(cellParams)} AND kind = 'click'
         AND (label, element) IN (${topElements(cellParams)})
       GROUP BY label, element, cx, cy
       ORDER BY clicks DESC, label, element, cx, cy
       LIMIT ${OVERLAY_CELLS}`,
      cellParams,
    ),
  ]);

  const pageviews = count(summary?.pageviews);
  const cellsOf = new Map<string, [number, number, number][]>();
  for (const row of cells) {
    const key = `${String(row.label)}\u0000${String(row.element)}`;
    const list = cellsOf.get(key) ?? [];
    list.push([count(row.cx), count(row.cy), count(row.clicks)]);
    cellsOf.set(key, list);
  }
  return {
    totals: {
      pageviews,
      clicks: count(summary?.clicks),
      rageClicks: count(summary?.rage_clicks),
    },
    devices: devices
      .filter((row) => DEVICES.includes(row.device))
      .map((row) => ({ device: row.device, pageviews: count(row.pageviews) })),
    reach: OVERLAY_REACH_STEPS.map((depth) => ({
      depth,
      share: round(share(count(summary?.[`reach_${depth}`]), pageviews)),
    })),
    elements: elements.map((row) => ({
      label: labelOf(row.label),
      element: String(row.element),
      clicks: count(row.clicks),
      rageClicks: count(row.rage_clicks),
      cells: cellsOf.get(`${String(row.label)}\u0000${String(row.element)}`) ?? [],
    })),
  };
}

/** An overlay with nothing in it: for a range wholly before the 90 days kept. */
export function emptyOverlay(): HeatmapOverlay {
  return {
    totals: { pageviews: 0, clicks: 0, rageClicks: 0 },
    devices: [],
    reach: OVERLAY_REACH_STEPS.map((depth) => ({ depth, share: 0 })),
    elements: [],
  };
}
