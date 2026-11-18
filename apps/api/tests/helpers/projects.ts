import type { Insertable, Kysely } from "kysely";

import type { Database, ProjectsTable } from "../../src/db/schema.ts";
import { updateInstanceSettings } from "../../src/settings/settings.ts";

/** Inserts a project straight into the database. */
export async function insertProject(
  db: Kysely<Database>,
  values: Insertable<ProjectsTable>,
): Promise<{ id: string; public_key: string }> {
  return db
    .insertInto("projects")
    .values(values)
    .returning(["id", "public_key"])
    .executeTakeFirstOrThrow();
}

/**
 * Sets the instance's timezone, as the settings page does: every project's
 * reports and visitor IDs follow it, in this process at once.
 */
export async function setInstanceTimeZone(db: Kysely<Database>, timeZone: string): Promise<void> {
  await updateInstanceSettings(db, { timeZone });
}
