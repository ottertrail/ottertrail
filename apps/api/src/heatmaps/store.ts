import type { ClickHouseClient } from "../clickhouse/clickhouse.ts";
import { insertRows } from "../clickhouse/insert.ts";
import { clickHouseTime } from "../clickhouse/query.ts";

/**
 * ClickHouse heatmap rows (clickhouse/migrations.ts, 0006;
 * docs/web-analytics.md, "Heatmaps").
 */

/** Device classes, by the viewport's width in CSS pixels: under 768, under 1024, the rest. */
export const DEVICES = ["mobile", "tablet", "desktop"] as const;
export type HeatmapDevice = (typeof DEVICES)[number];
export const TABLET_FROM_PX = 768;
export const DESKTOP_FROM_PX = 1024;

export function deviceOf(viewportWidth: number): HeatmapDevice {
  if (viewportWidth < TABLET_FROM_PX) return "mobile";
  return viewportWidth < DESKTOP_FROM_PX ? "tablet" : "desktop";
}

/** Fractions (0 to 1) are stored in thousandths. */
export const UNITS = 1000;

export interface NewHeatmapRecord {
  recordId: string;
  kind: "click" | "scroll";
  /** A click's time, or a scroll row's pageview start; stored to the minute. */
  occurredAt: Date;
  environment: string;
  release?: string | undefined;
  path: string;
  device: HeatmapDevice;
  /** The site's data-ottertrail-name, or "". */
  label: string;
  /** The click's element as a structural path, or "" for a scroll row. */
  element: string;
  /** Where in its element a click fell, 0 to 1; 0 for a scroll row. */
  x: number;
  y: number;
  viewportWidth: number;
  viewportHeight: number;
  pageHeight: number;
  rage: boolean;
  /** Nothing on the page responded to the click within a second. */
  dead?: boolean;
  /** A scroll row's deepest share of the page reached, 0 to 1; 0 for a click. */
  depth: number;
  /** A scroll row's share of the page visible without scrolling, at first; 0 for a click. */
  fold?: number;
  /** A scroll row's clicks not recorded, past the 100 of a pageview; 0 for a click. */
  dropped?: number;
}

/**
 * Round clock-corrected times to the nearest minute. The browser floors
 * timestamps; flooring again could move retries to another minute or UTC day.
 */
export const toMinute = (moment: Date) => new Date(Math.round(moment.getTime() / 60_000) * 60_000);

const thousandths = (fraction: number) => Math.round(Math.min(1, Math.max(0, fraction)) * UNITS);

export function toHeatmapRow(
  projectId: string,
  record: NewHeatmapRecord,
  receivedAt: Date,
): Record<string, unknown> {
  const scroll = record.kind === "scroll";
  const depth = scroll ? thousandths(record.depth) : 0;
  const dropped = scroll ? Math.min(65_535, Math.max(0, Math.round(record.dropped ?? 0))) : 0;
  return {
    project_id: projectId,
    record_id: record.recordId.toLowerCase(),
    kind: record.kind,
    occurred_at: clickHouseTime(toMinute(record.occurredAt)),
    // To the minute too: rows of one request share it, and to the millisecond
    // it would give away the order of a visitor's clicks.
    received_at: clickHouseTime(new Date(Math.floor(receivedAt.getTime() / 60_000) * 60_000)),
    environment: record.environment,
    release: record.release ?? "",
    path: record.path,
    device: record.device,
    label: record.label,
    element: record.element,
    x: thousandths(record.x),
    y: thousandths(record.y),
    viewport_width: record.viewportWidth,
    viewport_height: record.viewportHeight,
    page_height: record.pageHeight,
    rage: record.rage,
    dead: record.dead === true,
    depth,
    fold: scroll ? thousandths(record.fold ?? 0) : 0,
    dropped,
    // Depth and dropped clicks only grow; the higher ReplacingMergeTree
    // version replaces earlier scroll rows.
    version: depth * 65_536 + dropped,
  };
}

/**
 * Wait for the ClickHouse write before acknowledging ingestion
 * (clickhouse/insert.ts).
 */
export async function storeHeatmapRecords(
  clickhouse: ClickHouseClient,
  projectId: string,
  records: readonly NewHeatmapRecord[],
  {
    receivedAt = new Date(),
    waitSeconds,
  }: {
    receivedAt?: Date;
    /** How long ClickHouse may take to write them before it answers an error (storeEvents). */
    waitSeconds?: number;
  } = {},
): Promise<void> {
  await insertRows(
    clickhouse,
    "heatmaps",
    records.map((record) => toHeatmapRow(projectId, record, receivedAt)),
    waitSeconds === undefined ? {} : { wait_for_async_insert_timeout: waitSeconds },
  );
}
