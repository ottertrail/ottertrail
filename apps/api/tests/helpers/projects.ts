import type { Insertable, Kysely } from "kysely";

import type { Database, ProjectsTable } from "../../src/db/schema.ts";

/** A new organization with no members, for tests that need its projects only. */
export async function insertOrganization(
  db: Kysely<Database>,
  { name = "Test organization", timeZone = "UTC" }: { name?: string; timeZone?: string } = {},
): Promise<string> {
  const { id } = await db
    .insertInto("organizations")
    .values({ name, time_zone: timeZone })
    .returning("id")
    .executeTakeFirstOrThrow();
  return id;
}

/**
 * Inserts a project straight into the database. It joins `organization_id`
 * when given, otherwise a new organization of its own in `timeZone`.
 */
export async function insertProject(
  db: Kysely<Database>,
  values: Omit<Insertable<ProjectsTable>, "organization_id"> & { organization_id?: string },
  { timeZone = "UTC" }: { timeZone?: string } = {},
): Promise<{ id: string; public_key: string; organization_id: string }> {
  const organizationId = values.organization_id ?? (await insertOrganization(db, { timeZone }));
  return db
    .insertInto("projects")
    .values({ ...values, organization_id: organizationId })
    .returning(["id", "public_key", "organization_id"])
    .executeTakeFirstOrThrow();
}
