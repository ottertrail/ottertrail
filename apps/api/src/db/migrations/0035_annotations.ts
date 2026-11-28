import { type Kysely, sql } from "kysely";

/**
 * Notes on the Web analytics chart (docs/web-analytics.md, "Notes and
 * releases on the chart"): a day, or a day and a time, on the instance's
 * clock, with a short text. Kept as local wall-clock values, not instants,
 * so a note on 17 November stays on 17 November when the instance's
 * timezone changes. `environment` null: every environment. A note goes with
 * its project; it stays when the user who wrote it is removed (`author_id`
 * becomes null).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table annotations (
      id          uuid        primary key default gen_random_uuid(),
      project_id  uuid        not null references projects (id) on delete cascade,
      day         date        not null,
      time        time(0)     check (extract(second from time) = 0),
      text        text        not null check (char_length(text) between 1 and 200),
      environment text        check (environment ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
      author_id   uuid        references dashboard_users (id) on delete set null,
      created_at  timestamptz not null default now(),
      updated_at  timestamptz not null default now()
    )
  `.execute(db);
  await sql`create index annotations_project_day on annotations (project_id, day)`.execute(db);
  // Removing a user sets their notes' author to null through this index.
  await sql`create index annotations_author_id on annotations (author_id)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table annotations`.execute(db);
}
