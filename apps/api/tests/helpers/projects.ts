import type { Insertable, Kysely } from "kysely";

import type { Database, ProjectsTable } from "../../src/db/schema.ts";
import { updateInstanceSettings } from "../../src/settings/settings.ts";

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
 * Update reports and visitor IDs immediately, as the settings page does.
 */
export async function setInstanceTimeZone(db: Kysely<Database>, timeZone: string): Promise<void> {
  await updateInstanceSettings(db, { timeZone });
}
