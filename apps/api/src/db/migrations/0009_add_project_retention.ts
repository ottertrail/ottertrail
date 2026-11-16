import { type Kysely, sql } from "kysely";

/**
 * projects.retention_days: how long a project keeps its events, in days.
 * null keeps them forever, the default: nothing is deleted until the owner
 * chooses a limit. The worker deletes older events (retention/retention.ts).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table projects
      add column retention_days integer
        check (retention_days is null or retention_days between 30 and 3650)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`alter table projects drop column retention_days`.execute(db);
}
