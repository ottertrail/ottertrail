/**
 * Shared with script.ts without importing vitals.ts, which would bundle web-vitals in the tracker.
 */

/** The event a page load's Web Vitals are sent as. Reserved: pages cannot send it themselves. */
export const VITALS = "vitals";

/** The property the tracker sets on the Web Vitals script's element: the function it calls. */
export const RECORD_PROPERTY = "ottertrailRecord";

export type VitalName = "LCP" | "INP" | "CLS" | "FCP" | "TTFB";

export type RecordVital = (name: VitalName, value: number) => void;
