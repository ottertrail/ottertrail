/**
 * What the tracker (script.ts) and heatmap capture (heatmaps.ts, built to
 * h.js) share, without the capture code: importing it here would put it in
 * the tracker.
 */

/** The property the tracker sets on h.js's script element: a HeatmapConfig. */
export const HEATMAP_PROPERTY = "ottertrailHeatmaps";

/** The pageview heatmaps record: sampled in by the tracker, per pageview. */
export interface HeatmapPage {
  /** Cleaned as pageviews' URLs are (url.ts). */
  url: string;
  /** The page's referrer as its pageview has it, for the API's referrer spam check only. */
  referrer?: string | undefined;
  /** When the pageview started (Date.now()): its scroll depth's time. */
  at: number;
}

/** What the tracker hands h.js. */
export interface HeatmapConfig {
  /** The data host's /api/heatmaps URL. */
  endpoint: string;
  /** The project's public key. */
  key: string;
  environment?: string | undefined;
  release?: string | undefined;
  /** The current pageview, or null when it was not sampled for heatmaps. */
  page: () => HeatmapPage | null;
  /** h.js gives the tracker its controls once it runs. */
  register: (capture: HeatmapCapture) => void;
}

/** h.js's controls, for the tracker. Never throws. */
export interface HeatmapCapture {
  /** A new pageview began (the path changed, or a page came back from the cache). */
  navigated: () => void;
  /**
   * Stops for the rest of the page load and drops what was not sent: the
   * page turned out to be the owner's, opened for the heatmap overlay.
   */
  stop: () => void;
}
