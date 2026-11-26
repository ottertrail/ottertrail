/**
 * The part of traces (docs/web-analytics.md, "Traces") that tracker.js holds:
 * the page load's trace, which the server names in its Server-Timing
 * header, read before the first pageview. Request tracing is n.js
 * (requests.ts), loaded only with data-traces="on". Shared with n.js
 * without bundling it in the tracker.
 */

/** A trace and a span in it, in lowercase hex, as W3C Trace Context writes them. */
export interface TraceRef {
  traceId: string;
  spanId: string;
}

/** A request the page made, as an error carries it. */
export interface TracedRequest {
  method: string;
  /** The URL's path, without query string or fragment. */
  path: string;
  /** The response's status; 0 when no response came (offline, blocked, aborted). */
  status: number;
  durationMs: number;
  traceId: string;
}

/**
 * W3C Trace Context's version 00: lowercase hex, and neither ID all zeros.
 * Stricter than the spec, which lets a later version add fields: the
 * tracker sends only what it can read.
 */
const TRACEPARENT = /^00-(?!0{32}-)([\da-f]{32})-(?!0{16}-)([\da-f]{16})-[\da-f]{2}$/;

/** The trace and span a traceparent value names, or undefined for anything else. */
export function parseTraceparent(value: unknown): TraceRef | undefined {
  const match = typeof value === "string" ? TRACEPARENT.exec(value.trim()) : null;
  return match ? { traceId: match[1] ?? "", spanId: match[2] ?? "" } : undefined;
}

/**
 * The server's trace of this page load: the navigation entry's
 * Server-Timing entry named "traceparent" (docs/telemetry.md). The browser
 * shows it only for the page's own origin, or with Timing-Allow-Origin.
 */
export function pageLoadTrace(performance: {
  getEntriesByType?: (type: string) => readonly unknown[];
}): TraceRef | undefined {
  try {
    const [entry] = performance.getEntriesByType?.("navigation") ?? [];
    const timings: unknown =
      typeof entry === "object" && entry !== null && "serverTiming" in entry
        ? entry.serverTiming
        : undefined;
    if (!Array.isArray(timings)) return undefined;
    for (const timing of timings as unknown[]) {
      if (
        typeof timing === "object" &&
        timing !== null &&
        "name" in timing &&
        timing.name === "traceparent" &&
        "description" in timing
      ) {
        return parseTraceparent(timing.description);
      }
    }
  } catch {
    // An old browser without the entry: no trace.
  }
  return undefined;
}

/** The property the tracker sets on n.js's script element: a TracesConfig. */
export const TRACES_PROPERTY = "ottertrailTraces";

export interface TracesConfig {
  /** data-traces-origins as written: origins besides the page's own. */
  origins: string | undefined;
  /** The tracker's own endpoints start with this, and never get the header. */
  skip: string;
  /** Whether the current page view's requests get the header (data-traces-sample). */
  sampled: () => boolean;
  /** n.js gives the tracker the page's last requests, for errors. */
  register: (recent: () => TracedRequest[]) => void;
}
