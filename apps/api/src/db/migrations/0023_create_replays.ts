import { type Kysely, sql } from "kysely";

/**
 * Session replays around errors (docs/session-replay.md).
 *
 * - projects.replay_mode: "off" (the default), or "errors", recording
 *   around errors. Recordings for a project that has it off are refused.
 * - events.replay_id: on an error event, the replay that shows it.
 * - replay_chunks: what browsers sent, one gzip member each, kept until the
 *   worker joins a replay's chunks into one object, and an hour after, past
 *   the tracker's retries. A chunk is stored once per (project, replay, seq).
 * - replays: the joined replays, one object each in the object store.
 *
 * Deleting a project deletes these rows; the worker deletes its objects.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table projects
      add column replay_mode text not null default 'off'
        constraint projects_replay_mode_check check (replay_mode in ('off', 'errors'))
  `.execute(db);
  await sql`alter table events add column replay_id uuid`.execute(db);
  await sql`
    create table replay_chunks (
      project_id uuid not null references projects (id) on delete cascade,
      replay_id uuid not null,
      seq smallint not null constraint replay_chunks_seq_check check (seq between 0 and 49),
      last boolean not null,
      cut boolean not null,
      data bytea not null
        constraint replay_chunks_data_check check (octet_length(data) between 1 and 65536),
      received_at timestamptz not null default now(),
      primary key (project_id, replay_id, seq)
    )
  `.execute(db);
  await sql`create index replay_chunks_received_at on replay_chunks (received_at)`.execute(db);
  await sql`
    create table replays (
      project_id uuid not null references projects (id) on delete cascade,
      replay_id uuid not null,
      object_key text not null,
      bytes integer not null constraint replays_bytes_check check (bytes > 0),
      cut boolean not null,
      created_at timestamptz not null default now(),
      primary key (project_id, replay_id)
    )
  `.execute(db);
  await sql`create index replays_created_at on replays (created_at)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table replays`.execute(db);
  await sql`drop table replay_chunks`.execute(db);
  await sql`alter table events drop column replay_id`.execute(db);
  await sql`alter table projects drop column replay_mode`.execute(db);
}
