import { type Kysely, sql } from "kysely";

import type { Database, MembershipRole } from "../db/schema.ts";

export const MAX_ORGANIZATION_NAME_LENGTH = 100;

/** An organization as one of its members sees it. */
export interface Organization {
  id: string;
  name: string;
  /** IANA timezone: reports count days in it, and visitor salts change at its midnight. */
  timeZone: string;
  /** The signed-in user's role in it. */
  role: MembershipRole;
  createdAt: Date;
}

function memberView(db: Kysely<Database>, userId: string) {
  return db
    .selectFrom("organizations")
    .innerJoin("memberships", (join) =>
      join
        .onRef("memberships.organization_id", "=", "organizations.id")
        .on("memberships.user_id", "=", userId),
    )
    .select([
      "organizations.id",
      "organizations.name",
      "organizations.time_zone",
      "organizations.created_at",
      "memberships.role",
    ]);
}

type OrganizationRow = Awaited<
  ReturnType<ReturnType<typeof memberView>["executeTakeFirstOrThrow"]>
>;

function toOrganization(row: OrganizationRow): Organization {
  return {
    id: row.id,
    name: row.name,
    timeZone: row.time_zone,
    role: row.role,
    createdAt: row.created_at,
  };
}

/** The organizations a user belongs to, oldest first. */
export async function listOrganizations(
  db: Kysely<Database>,
  userId: string,
): Promise<Organization[]> {
  const rows = await memberView(db, userId)
    .orderBy("organizations.created_at")
    .orderBy("organizations.id")
    .execute();
  return rows.map(toOrganization);
}

/** One organization, if the user belongs to it; null otherwise, whether or not it exists. */
export async function findOrganization(
  db: Kysely<Database>,
  userId: string,
  organizationId: string,
): Promise<Organization | null> {
  const row = await memberView(db, userId)
    .where("organizations.id", "=", organizationId)
    .executeTakeFirst();
  return row === undefined ? null : toOrganization(row);
}

/**
 * Whether PostgreSQL knows a timezone name. Node.js and PostgreSQL carry
 * separate timezone databases, and reports and retention hand the name to
 * PostgreSQL, so a name only Node.js knows would make them fail.
 */
export async function postgresKnowsTimeZone(db: Kysely<Database>, name: string): Promise<boolean> {
  const { rows } = await sql<{ known: boolean }>`
    select exists (select 1 from pg_timezone_names where name = ${name}) as known
  `.execute(db);
  return rows[0]?.known === true;
}

/** A new organization with `ownerId` as its owner. Run it inside the caller's transaction. */
export async function createOrganization(
  db: Kysely<Database>,
  input: { name: string; timeZone: string; ownerId: string },
): Promise<{ id: string }> {
  const organization = await db
    .insertInto("organizations")
    .values({ name: input.name, time_zone: input.timeZone })
    .returning("id")
    .executeTakeFirstOrThrow();
  await db
    .insertInto("memberships")
    .values({ organization_id: organization.id, user_id: input.ownerId, role: "owner" })
    .execute();
  return organization;
}

/** Changes an organization's name or timezone. Checking who may do it is the caller's job. */
export async function updateOrganization(
  db: Kysely<Database>,
  organizationId: string,
  changes: { name?: string; timeZone?: string },
): Promise<void> {
  await db
    .updateTable("organizations")
    .set({
      ...(changes.name === undefined ? {} : { name: changes.name }),
      ...(changes.timeZone === undefined ? {} : { time_zone: changes.timeZone }),
    })
    .where("id", "=", organizationId)
    .execute();
}

/** The public keys of an organization's projects, for caches that must forget them. */
export async function organizationProjectKeys(
  db: Kysely<Database>,
  organizationId: string,
): Promise<string[]> {
  const rows = await db
    .selectFrom("projects")
    .select("public_key")
    .where("organization_id", "=", organizationId)
    .execute();
  return rows.map((row) => row.public_key);
}
