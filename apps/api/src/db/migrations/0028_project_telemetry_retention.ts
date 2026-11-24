import { type Kysely, sql } from "kysely";

/**
 * How long each project keeps its traces, logs, and metrics
 * (docs/telemetry.md, "Limits"): telemetry_retention_days, 1 to 365, or
 * null for the instance's maximum (TELEMETRY_RETENTION_DAYS). A value above
 * the maximum, after the operator lowers it, counts as the maximum.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table projects
      add column telemetry_retention_days integer
        check (telemetry_retention_days between 1 and 365)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`alter table projects drop column telemetry_retention_days`.execute(db);
}
