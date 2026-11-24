/**
 * How long a project keeps its traces, logs, and metrics (docs/telemetry.md,
 * "Limits"). The instance's TELEMETRY_RETENTION_DAYS is the maximum and the
 * default: ClickHouse's TTL drops every project's days past it. A project
 * may keep fewer days (projects.telemetry_retention_days), which the worker
 * deletes (retention/retention.ts).
 */

/** The fewest and most days a project may choose; the database checks the same. */
export const MIN_TELEMETRY_RETENTION_DAYS = 1;
export const MAX_TELEMETRY_RETENTION_DAYS = 365;

/**
 * The days a project keeps: its own setting, or the instance's maximum when
 * it has none. A setting above the maximum, left after the operator lowered
 * it, counts as the maximum.
 */
export function effectiveTelemetryRetentionDays(setting: number | null, maxDays: number): number {
  return Math.min(setting ?? maxDays, maxDays);
}
