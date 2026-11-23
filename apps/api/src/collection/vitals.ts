/**
 * Web Vitals: one "vitals" event per page load carries them as properties,
 * measured by the tracker's v.js (packages/tracker/src/vitals.ts;
 * docs/web-analytics.md, "Web Vitals").
 */

export const VITAL_NAMES = ["lcp", "inp", "cls", "fcp", "ttfb"] as const;
export type VitalName = (typeof VITAL_NAMES)[number];

/** The largest value each may have: milliseconds, and CLS's score. */
export const VITAL_LIMITS: Record<VitalName, number> = {
  lcp: 600_000,
  inp: 600_000,
  cls: 100,
  fcp: 600_000,
  ttfb: 600_000,
};

/**
 * Discard invalid measurements without losing other values or events in the batch.
 * Reports need at least one remaining value to count the page load (speed/speed.ts).
 */
export function keepValidVitals(properties: Record<string, unknown>): void {
  for (const [name, value] of Object.entries(properties)) {
    const limit = (VITAL_LIMITS as Record<string, number | undefined>)[name];
    const valid =
      limit !== undefined &&
      typeof value === "number" &&
      Number.isFinite(value) &&
      value >= 0 &&
      value <= limit &&
      (name === "cls" || Number.isInteger(value));
    if (!valid) delete properties[name];
  }
}

/** SQL for a vital's value in an event's properties: NULL when missing or impossible. */
export function vitalValue(name: VitalName): string {
  // SQL uses only the constants above.
  const raw = `JSONExtract(properties, '${name}', 'Nullable(Float64)')`;
  return `if(${raw} BETWEEN 0 AND ${VITAL_LIMITS[name]}, ${raw}, NULL)`;
}
