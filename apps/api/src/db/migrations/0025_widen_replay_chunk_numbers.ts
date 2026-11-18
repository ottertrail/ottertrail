import { type Kysely, sql } from "kysely";

/**
 * A replay may have 100 chunks, numbered 0 to 99 (MAX_CHUNKS in
 * replays/replays.ts), not 50: the tracker fills each chunk at least
 * about half, so a 2 MB recording can need more than 50.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table replay_chunks
      drop constraint replay_chunks_seq_check,
      add constraint replay_chunks_seq_check check (seq between 0 and 99)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`delete from replay_chunks where seq > 49`.execute(db);
  await sql`
    alter table replay_chunks
      drop constraint replay_chunks_seq_check,
      add constraint replay_chunks_seq_check check (seq between 0 and 49)
  `.execute(db);
}
