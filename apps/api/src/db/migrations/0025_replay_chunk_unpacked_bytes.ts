import { type Kysely, sql } from "kysely";

/**
 * What each replay chunk unpacks to (replays/replays.ts, storeChunk), so an
 * upload can refuse a replay whose chunks would unpack past
 * MAX_REPLAY_UNPACKED_BYTES without unpacking the chunks already kept.
 * Chunks kept before it count as 0: the worker's join still caps them.
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
