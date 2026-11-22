/**
 * The heatmap overlay's data and drawing, shared by o.js (overlay-view.ts),
 * which draws over the owner's live page, and the replay player's snapshot
 * view (packages/replay-player/src/snapshot.ts), which draws over a saved
 * snapshot of it (docs/web-analytics.md, "The overlay on your site" and
 * "Saved views"). Everything from the API is checked and capped here, and
 * drawn as shapes or canvas text, never parsed as HTML.
 */

/** The grid the API counts clicks in, per element. */
export const GRID = 8;
/** What the overlay takes from an answer at most, whatever the API sends. */
const MAX_ELEMENTS = 200;
const MAX_CELLS = 64;

export interface OverlayElement {
  label: string | null;
  element: string;
  clicks: number;
  rageClicks: number;
  deadClicks: number;
  cells: [number, number, number][];
}

export interface OverlayData {
  firstDay: string;
  lastDay: string;
  totals: { pageviews: number; clicks: number; rageClicks: number; deadClicks: number };
  reach: { depth: number; share: number }[];
  elements: OverlayElement[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const whole = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
const text = (value: unknown, max: number): string =>
  typeof value === "string" ? value.slice(0, max) : "";

/** The parts of an answer the overlay uses, checked and capped: anything else is dropped. */
export function parseOverlay(value: unknown): OverlayData | null {
  if (!isRecord(value) || !isRecord(value.totals)) return null;
  const elements = Array.isArray(value.elements) ? value.elements.slice(0, MAX_ELEMENTS) : [];
  const reach = Array.isArray(value.reach) ? value.reach.slice(0, 20) : [];
  return {
    firstDay: text(value.firstDay, 10),
    lastDay: text(value.lastDay, 10),
    totals: {
      pageviews: whole(value.totals.pageviews),
      clicks: whole(value.totals.clicks),
      rageClicks: whole(value.totals.rageClicks),
      deadClicks: whole(value.totals.deadClicks),
    },
    reach: reach.filter(isRecord).map((step) => ({
      depth: Math.min(100, whole(step.depth)),
      share: Math.min(1, Math.max(0, Number(step.share) || 0)),
    })),
    elements: elements.filter(isRecord).map((item) => ({
      label: typeof item.label === "string" ? item.label.slice(0, 64) : null,
      element: text(item.element, 512),
      clicks: whole(item.clicks),
      rageClicks: whole(item.rageClicks),
      deadClicks: whole(item.deadClicks),
      cells: (Array.isArray(item.cells) ? item.cells.slice(0, MAX_CELLS) : [])
        .filter((cell): cell is unknown[] => Array.isArray(cell))
        .map((cell): [number, number, number] => [
          Math.min(GRID - 1, whole(cell[0])),
          Math.min(GRID - 1, whole(cell[1])),
          whole(cell[2]),
        ]),
    })),
  };
}

/** An element's name for people: the site's own, or its path's last two steps. */
export function elementName(item: Pick<OverlayElement, "label" | "element">): string {
  return item.label ?? item.element.split(">").slice(-2).join(" > ");
}

const formatWhole = (value: number) => value.toLocaleString("en-US");

/** What is drawn on: the viewport's size, how far it is scrolled, and the page's height. */
export interface DrawView {
  width: number;
  height: number;
  scrollY: number;
  pageHeight: number;
}

/**
 * Draws the dots on each element found and the scroll bands at the right
 * edge, in the viewport's coordinates: each node's box is read as it is
 * now (getBoundingClientRect, in its own document's viewport). The canvas
 * is cleared first; its transform is the caller's.
 */
export function drawHeatmap(
  context: CanvasRenderingContext2D,
  view: DrawView,
  data: OverlayData,
  found: readonly { item: OverlayElement; node: Element }[],
): void {
  const { width, height } = view;
  // Clicks: a dot per cell with clicks, larger and hotter for more.
  let most = 1;
  for (const { item } of found) for (const cell of item.cells) most = Math.max(most, cell[2]);
  for (const { item, node } of found) {
    if (!node.isConnected) continue;
    const box = node.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) continue;
    if (box.bottom < 0 || box.top > height || box.right < 0 || box.left > width) continue;
    context.lineWidth = 1;
    // Rage clicks red, dead clicks amber, the rest blue.
    context.strokeStyle =
      item.rageClicks > 0
        ? "rgba(220, 38, 38, 0.9)"
        : item.deadClicks > 0
          ? "rgba(217, 119, 6, 0.9)"
          : "rgba(37, 99, 235, 0.6)";
    context.strokeRect(box.left + 0.5, box.top + 0.5, box.width - 1, box.height - 1);
    for (const [column, row, clicks] of item.cells) {
      const heat = clicks / most;
      const x = box.left + ((column + 0.5) / GRID) * box.width;
      const y = box.top + ((row + 0.5) / GRID) * box.height;
      const radius = 5 + 15 * Math.sqrt(heat);
      const gradient = context.createRadialGradient(x, y, 0, x, y, radius);
      const hue = Math.round(220 - 220 * heat);
      gradient.addColorStop(0, `hsla(${hue}, 95%, 50%, 0.85)`);
      gradient.addColorStop(1, `hsla(${hue}, 95%, 50%, 0)`);
      context.fillStyle = gradient;
      context.beginPath();
      context.arc(x, y, radius, 0, Math.PI * 2);
      context.fill();
    }
    // The element's clicks, as text drawn on the canvas.
    const label = [
      formatWhole(item.clicks),
      ...(item.rageClicks > 0 ? [`${formatWhole(item.rageClicks)} rage`] : []),
      ...(item.deadClicks > 0 ? [`${formatWhole(item.deadClicks)} dead`] : []),
    ].join(" · ");
    context.font = "600 11px system-ui, sans-serif";
    const labelWidth = context.measureText(label).width + 8;
    const labelX = Math.max(0, Math.min(box.left, width - labelWidth));
    const labelY = Math.max(0, box.top - 16);
    context.fillStyle =
      item.rageClicks > 0
        ? "rgba(185, 28, 28, 0.95)"
        : item.deadClicks > 0
          ? "rgba(146, 64, 14, 0.95)"
          : "rgba(24, 24, 27, 0.85)";
    context.fillRect(labelX, labelY, labelWidth, 16);
    context.fillStyle = "#fff";
    context.textBaseline = "middle";
    context.fillText(label, labelX + 4, labelY + 8);
  }

  // Scroll reach: a band at the right edge, each 5% of the page shaded
  // by the share of pageviews that reached it, with its share every 25%.
  const bandWidth = 14;
  let previous = 0;
  for (const step of data.reach) {
    const top = (previous / 100) * view.pageHeight - view.scrollY;
    const bottom = (step.depth / 100) * view.pageHeight - view.scrollY;
    previous = step.depth;
    if (bottom < 0 || top > height) continue;
    context.fillStyle = `hsla(${Math.round(220 * (1 - step.share))}, 85%, 45%, ${0.25 + 0.6 * step.share})`;
    context.fillRect(width - bandWidth, top, bandWidth, bottom - top);
    if (step.depth % 25 === 0) {
      const reached = `${Math.round(step.share * 100)}% reached`;
      context.font = "600 11px system-ui, sans-serif";
      const textWidth = context.measureText(reached).width + 8;
      const y = Math.min(Math.max(bottom - 16, 0), height - 16);
      context.fillStyle = "rgba(24, 24, 27, 0.85)";
      context.fillRect(width - bandWidth - textWidth - 2, y, textWidth, 16);
      context.fillStyle = "#fff";
      context.textBaseline = "middle";
      context.fillText(reached, width - bandWidth - textWidth + 2, y + 8);
    }
  }
}
