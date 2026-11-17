import { type Kysely, sql } from "kysely";

/**
 * source_maps: the source maps a project uploaded (docs/errors.md, "Source
 * maps"), one per release and minified file. The map itself is in the
 * object store, compressed, under object_key; bytes is its stored size,
 * which each organization's limit counts. A new upload of the same file
 * and release replaces the old one. Deleting the project deletes these
 * rows; the worker deletes its objects (project_deletions).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table source_maps (
      project_id uuid not null references projects (id) on delete cascade,
      release text not null
        constraint source_maps_release_check check (char_length(release) between 1 and 200),
      -- ASCII, as browsers report a path (source-maps.ts, isSourcePath),
      -- and short enough that the primary key stays within what an index takes.
      path text not null
        constraint source_maps_path_check check (
          char_length(path) between 1 and 1024 and left(path, 1) = '/'
        ),
      object_key text not null,
      bytes integer not null constraint source_maps_bytes_check check (bytes > 0),
      uploaded_at timestamptz not null default now(),
      primary key (project_id, release, path)
    )
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table source_maps`.execute(db);
}
