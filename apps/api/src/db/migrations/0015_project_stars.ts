import { type Kysely, sql } from "kysely";

/**
 * Starred projects (docs/dashboard.md, "Starred projects"): each dashboard
 * user's own stars, which the workspace sidebar lists and the Projects
 * page sorts first. A star goes with the user and with the project
 * (foreign keys), and with the user's access to the project: changing a
 * member's projects deletes their stars on the others (access/grants.ts).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table project_stars (
      user_id    uuid        not null references dashboard_users (id) on delete cascade,
      project_id uuid        not null references projects (id) on delete cascade,
      created_at timestamptz not null default now(),
      primary key (user_id, project_id)
    )
  `.execute(db);
  // Deleting a project deletes its stars through this index.
  await sql`create index project_stars_project_id on project_stars (project_id)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table project_stars`.execute(db);
}
