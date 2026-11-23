/**
 * Shared with script.ts without bundling overlay.ts (o.js) in the tracker.
 */

/** The element o.js draws in, over the page: h.js ignores its changes. */
export const OVERLAY_TAG = "ottertrail-heatmap";

/** The property the tracker sets on o.js's script element: an OverlayConfig. */
export const OVERLAY_PROPERTY = "ottertrailOverlay";
export interface OverlayConfig {
  /** The instance's origin (the tag's data-host). */
  host: string;
  /** The one-time link token from the page's address, already removed from it. */
  token: string;
  /** The tag's environment, whose data the overlay shows. */
  environment?: string | undefined;
  /**
   * o.js says, once, whether the link was a real one and the overlay is
   * shown (true), or not (false): the tracker then records the page load.
   * Returns whether the answer came in time: false when the tracker had
   * stopped waiting (and recorded the page load) already.
   */
  settled: (shown: boolean) => boolean;
}
