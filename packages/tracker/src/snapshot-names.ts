/**
 * Shared by o.js and snapshot.ts (s.js) without bundling rrweb in o.js.
 */

/** The property o.js sets on s.js's script element: a SnapshotConfig. */
export const SNAPSHOT_PROPERTY = "ottertrailSnapshot";

/**
 * The largest snapshot, in bytes once compressed: the API refuses more
 * (apps/api/src/heatmaps/snapshots.ts, MAX_SNAPSHOT_BYTES).
 */
export const MAX_SNAPSHOT_BYTES = 5_000_000;
/**
 * The most objects and arrays its JSON may hold: about three per element,
 * as rrweb writes a page (apps/api/src/heatmaps/snapshots.ts, MAX_SNAPSHOT_CONTAINERS).
 */
export const MAX_SNAPSHOT_CONTAINERS = 500_000;
export type SnapshotResult =
  | {
      ok: true;
      /** The snapshot as gzip-compressed JSON, as the API takes it. */
      body: Uint8Array<ArrayBuffer>;
      /** The viewport's width, which decides the device class. */
      width: number;
    }
  | { ok: false; reason: "too_large" | "unsupported" | "failed" };

/** Takes a snapshot of the page as it is now, leaving out `hide` (the overlay's own element). */
export type TakeSnapshot = (hide: Element) => Promise<SnapshotResult>;
export interface SnapshotConfig {
  /** s.js calls it once, as it runs, with the function that takes snapshots. */
  ready: (take: TakeSnapshot) => void;
}
