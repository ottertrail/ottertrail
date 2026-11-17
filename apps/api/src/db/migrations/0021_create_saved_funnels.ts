import { type Kysely, sql } from "kysely";

/**
 * saved_funnels: a project's named funnels (docs/product-analytics.md,
 * "Saved funnels"): the steps, who the funnel counts, and its conversion
 * window, so the funnel page can open one again. The period and the
 * environment are the page's, not the funnel's.
 *
 * The steps are the JSON the funnel report takes (product/steps.ts),
 * checked by the API before they are stored: here only their number. A
 * window over a day needs users, whose IDs do not change daily. Names are
 * unique in a project. Deleting the project deletes its funnels.
 *
 * updated_at is a funnel's version: a change names the one it read, and is
 * refused when another came first. It is kept in whole milliseconds, as
 * JSON carries it, and every change moves it forward.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table saved_funnels (
      id uuid primary key default gen_random_uuid(),
      project_id uuid not null references projects (id) on delete cascade,
      name text not null
        constraint saved_funnels_name_check check (char_length(name) between 1 and 100),
      steps jsonb not null constraint saved_funnels_steps_check check (
        case when jsonb_typeof(steps) = 'array'
          then jsonb_array_length(steps) between 2 and 5
          else false end
      ),
      count_by text not null
        constraint saved_funnels_count_by_check check (count_by in ('visitors', 'users')),
      window_seconds integer not null constraint saved_funnels_window_check check (
        window_seconds > 0 and (count_by = 'users' or window_seconds <= 86400)
      ),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default date_trunc('milliseconds', now()),
      constraint saved_funnels_project_name_key unique (project_id, name)
    )
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table saved_funnels`.execute(db);
}
