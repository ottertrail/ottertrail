/**
 * Shared with script.ts without bundling overlay.ts (o.js) in the tracker.
 */

/** The element o.js draws in, over the page: h.js ignores its changes. */
export const OVERLAY_TAG = "ottertrail-heatmap";

/**
 * The property the tracker sets on o.js's script element: an
 * OverlayHandoff, never the config itself, which a page script watching the
 * DOM could read before o.js runs.
 */
export const OVERLAY_PROPERTY = "ottertrailOverlay";
/** Gives the config once, and only to o.js as it runs (document.currentScript is its element). */
export type OverlayHandoff = () => OverlayConfig | undefined;
export interface OverlayConfig {
  /** The instance's origin (the tag's data-host). */
  host: string;
  /** The one-time link token from the page's address, already removed from it. */
  token: string;
  /** The tag's environment, whose data the overlay shows. */
  environment?: string | undefined;
  /** The page's fetch as the tracker found it when it started, before later scripts could wrap it. */
  fetch?: typeof fetch;
  /**
   * o.js says, once, whether the link was a real one and the overlay is
   * shown (true), or not (false): the tracker then records the page load.
   * Returns whether the answer came in time: false when the tracker had
   * stopped waiting (and recorded the page load) already.
   */
  settled: (shown: boolean) => boolean;
}
