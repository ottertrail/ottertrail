import { type Kysely, sql } from "kysely";

/**
 * Tracks unpacked chunk bytes to enforce MAX_REPLAY_UNPACKED_BYTES without rereading stored chunks
 * (replays/replays.ts, storeChunk). Older chunks count as 0; the worker still caps joins.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table replay_chunks
      add column unpacked_bytes integer not null default 0
        constraint replay_chunks_unpacked_bytes_check check (unpacked_bytes between 0 and 1048576)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`alter table replay_chunks drop column unpacked_bytes`.execute(db);
}
