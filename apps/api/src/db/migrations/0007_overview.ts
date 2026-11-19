import { type Kysely, sql } from "kysely";

/**
 * The project overview (docs/dashboard.md, "Overview").
 *
 * - projects.main_goal_id: the goal the overview's business figures start
 *   with, or null. The foreign key names the goal and its project
 *   together, so it can only be one of the project's own goals; deleting
 *   the goal sets only this column to null.
 * - overview_layouts: each dashboard user's own layout of one project's
 *   overview: the widgets in their order, and those hidden, by ID
 *   (overview/widgets.ts). No row means the default layout. It goes with
 *   the user and with the project.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table goals add constraint goals_id_project_key unique (id, project_id)
  `.execute(db);
  await sql`
    alter table projects
      add column main_goal_id uuid,
      add constraint projects_main_goal_fkey foreign key (main_goal_id, id)
        references goals (id, project_id) on delete set null (main_goal_id)
  `.execute(db);
  await sql`
    create table overview_layouts (
      user_id    uuid        not null references dashboard_users (id) on delete cascade,
      project_id uuid        not null references projects (id) on delete cascade,
      widgets    text[]      not null check (cardinality(widgets) <= 20),
      hidden     text[]      not null default '{}' check (cardinality(hidden) <= 20),
      updated_at timestamptz not null default now(),
      primary key (user_id, project_id)
    )
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table overview_layouts`.execute(db);
  await sql`
    alter table projects
      drop constraint projects_main_goal_fkey,
      drop column main_goal_id
  `.execute(db);
  await sql`alter table goals drop constraint goals_id_project_key`.execute(db);
}
