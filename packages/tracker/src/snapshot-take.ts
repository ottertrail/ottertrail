/**
 * Save an rrweb snapshot only at the owner's request, excluding the overlay.
 * Keep text and media, mask every input, and apply replay-filter.ts to remove
 * scripts, handlers, and URL queries and fragments. Replay mask/block markers
 * still apply; data-ottertrail-name stays for heatmap keys.
 * The gzip JSON contains v, events (meta, full snapshot, styles), and pageHeight,
 * bounded by MAX_SNAPSHOT_BYTES. See docs/web-analytics.md, "Saved views".
 */
import { record as rrwebRecord } from "@rrweb/record";

import { OVERLAY_TAG } from "./overlay-names.ts";
import { blockSelector, createFilter, maskValue } from "./replay-filter.ts";
import { gzip } from "./replay-pack.ts";
import {
  MAX_SNAPSHOT_BYTES,
  MAX_SNAPSHOT_CONTAINERS,
  type SnapshotResult,
} from "./snapshot-names.ts";

// rrweb's numbers (@rrweb/types).
const FULL_SNAPSHOT = 2;
const INCREMENTAL = 3;
const META = 4;
/** Style events a full snapshot may bring with it: stylesheet rules and adopted sheets. */
const STYLE_SOURCES = new Set([8, 13, 15]);

const INPUT_TYPES = [
  "color",
  "date",
  "datetime-local",
  "email",
  "month",
  "number",
  "range",
  "search",
  "tel",
  "text",
  "time",
  "url",
  "week",
  "textarea",
  "select",
  "password",
] as const;

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The serialized tree without the overlay's element (blocked, so it has no children). */
function withoutOverlay(node: unknown): void {
  if (!isRecord(node) || !Array.isArray(node.childNodes)) return;
  const children = (node.childNodes as unknown[]).filter(
    (child) => !(isRecord(child) && child.tagName === OVERLAY_TAG),
  );
  node.childNodes = children;
  for (const child of children) withoutOverlay(child);
}

/** Objects and arrays in JSON text, outside strings (the API's structureOf, in snapshots.ts). */
function containersOf(text: string): number {
  let count = 0;
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (inString) {
      if (code === 92) i += 1;
      else if (code === 34) inString = false;
    } else if (code === 34) inString = true;
    else if (code === 123 || code === 91) count += 1;
  }
  return count;
}

export interface SnapshotOptions {
  /** The element to leave out: the overlay's own. */
  hide: Element;
  /** For tests: smaller caps. */
  maxBytes?: number;
  maxContainers?: number;
  /** For tests: rrweb's record, or a stand-in. */
  record?: typeof rrwebRecord;
}

/** Takes the snapshot; never throws. */
export async function takeSnapshot({
  hide,
  maxBytes = MAX_SNAPSHOT_BYTES,
  maxContainers = MAX_SNAPSHOT_CONTAINERS,
  record = rrwebRecord,
}: SnapshotOptions): Promise<SnapshotResult> {
  if (typeof CompressionStream !== "function") return { ok: false, reason: "unsupported" };
  try {
    const doc = hide.ownerDocument;
    const raw: unknown[] = [];
    // rrweb takes the full snapshot as it starts, at once on a loaded page; stopped straight after.
    const stop = record({
      emit: (event) => raw.push(event),
      blockSelector: `${OVERLAY_TAG},${blockSelector(true)}`,
      maskAllInputs: true,
      maskInputOptions: Object.fromEntries(INPUT_TYPES.map((type) => [type, true])),
      maskInputFn: maskValue,
      slimDOMOptions: "all",
      recordCanvas: false,
      collectFonts: false,
      recordCrossOriginIframes: false,
      inlineImages: false,
      errorHandler: () => true,
    });
    stop?.();
    const filter = createFilter({
      showText: true,
      showMedia: true,
      base: doc.location.href,
      keepNames: true,
    });
    const events: Json[] = [];
    for (const event of raw) {
      const clean = filter(event);
      if (clean === undefined) continue;
      const { type, data } = clean;
      if (
        type === META ||
        type === FULL_SNAPSHOT ||
        (type === INCREMENTAL && isRecord(data) && STYLE_SOURCES.has(Number(data.source)))
      ) {
        events.push(clean);
      }
    }
    const meta = events.find((event) => event.type === META);
    const full = events.find((event) => event.type === FULL_SNAPSHOT);
    if (meta === undefined || full === undefined || !isRecord(full.data)) {
      return { ok: false, reason: "failed" };
    }
    withoutOverlay(full.data.node);
    // The view opens at the top of the page, wherever the owner had scrolled.
    full.data.initialOffset = { top: 0, left: 0 };
    const width = isRecord(meta.data) ? Number(meta.data.width) : 0;
    const pageHeight = Math.max(
      doc.documentElement.scrollHeight,
      doc.body?.scrollHeight ?? 0,
      doc.documentElement.clientHeight,
    );
    const text = JSON.stringify({
      v: 1,
      events: [meta, full, ...events.filter((event) => event !== meta && event !== full)],
      pageHeight,
    });
    // The API counts objects and arrays before it parses (MAX_SNAPSHOT_CONTAINERS).
    if (containersOf(text) > maxContainers) return { ok: false, reason: "too_large" };
    const body = await gzip(text);
    if (body.byteLength > maxBytes) return { ok: false, reason: "too_large" };
    return { ok: true, body, width };
  } catch {
    return { ok: false, reason: "failed" };
  }
}
