import { type Kysely, sql } from "kysely";

/**
 * goals: a project's saved conversions (docs/product-analytics.md,
 * "Goals"), each a page viewed or a product event with an optional
 * property filter, as a funnel step is. The analytics page counts them.
 *
 * The columns match the step's kind: a page has a path; an event a name,
 * and a property name and value together or neither. Names are unique in
 * a project, so a list can be read at a glance. Deleting the project
 * deletes its goals.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table goals (
      id uuid primary key default gen_random_uuid(),
      project_id uuid not null references projects (id) on delete cascade,
      name text not null constraint goals_name_check check (char_length(name) between 1 and 100),
      kind text not null constraint goals_kind_check check (kind in ('page', 'event')),
      path text constraint goals_path_check check (char_length(path) between 1 and 500),
      event_name text constraint goals_event_name_check check (char_length(event_name) between 1 and 200),
      filter_key text constraint goals_filter_key_check check (char_length(filter_key) between 1 and 100),
      filter_value text constraint goals_filter_value_check check (char_length(filter_value) <= 500),
      created_at timestamptz not null default now(),
      constraint goals_shape_check check (
        (kind = 'page' and path is not null and event_name is null
          and filter_key is null and filter_value is null)
        or (kind = 'event' and event_name is not null and path is null
          and (filter_key is null) = (filter_value is null))
      ),
      constraint goals_project_name_key unique (project_id, name)
    )
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table goals`.execute(db);
}
