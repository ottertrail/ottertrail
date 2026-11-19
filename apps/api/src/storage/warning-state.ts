import type { Kysely, Transaction } from "kysely";

import type { Database } from "../db/schema.ts";
import { MAX_CHANNELS } from "../notifications/channels.ts";
import { isWarningId, type WarningId, type WarningLevel } from "./warnings.ts";

/**
 * What PostgreSQL keeps about storage warnings (migration 0010): the
 * channels that get them, and the warnings that are on.
 */

/** The most channels the setting takes: every channel the instance may have. */
export const MAX_WARNING_CHANNELS = MAX_CHANNELS;

/** The channels that get storage warnings, oldest first. */
export async function readWarningChannels(db: Kysely<Database>): Promise<string[]> {
  const rows = await db
    .selectFrom("storage_warning_channels")
    .innerJoin("notification_channels", "notification_channels.id", "channel_id")
    .select("channel_id")
    .orderBy("notification_channels.created_at")
    .orderBy("channel_id")
    .execute();
  return rows.map((row) => row.channel_id);
}

/**
 * Replaces the channels that get storage warnings. Refused, with the IDs,
 * when one is not a channel of the instance (deleted meanwhile, or never
 * one): nothing changes then.
 */
export async function setWarningChannels(
  db: Kysely<Database>,
  channelIds: readonly string[],
): Promise<{ unknown: string[] } | null> {
  const ids = [...new Set(channelIds.map((id) => id.toLowerCase()))];
  return db.transaction().execute(async (trx) => {
    // Locked, so a channel cannot be deleted between the check and the insert.
    const found =
      ids.length === 0
        ? []
        : await trx
            .selectFrom("notification_channels")
            .select("id")
            .where("id", "in", ids)
            .orderBy("id")
            .forShare()
            .execute();
    const unknown = ids.filter((id) => !found.some((row) => row.id === id));
    if (unknown.length > 0) return { unknown };
    await trx.deleteFrom("storage_warning_channels").execute();
    if (ids.length > 0) {
      await trx
        .insertInto("storage_warning_channels")
        .values(ids.map((id) => ({ channel_id: id })))
        .execute();
    }
    return null;
  });
}

export interface ActiveWarning {
  level: WarningLevel;
  startedAt: Date;
}

/** The warnings that are on; in a transaction, locked until it ends. */
export async function readActiveWarnings(
  db: Kysely<Database> | Transaction<Database>,
  { lock = false }: { lock?: boolean } = {},
): Promise<Map<WarningId, ActiveWarning>> {
  let query = db.selectFrom("storage_warnings").select(["warning", "level", "started_at"]);
  if (lock) query = query.forUpdate();
  const rows = await query.execute();
  const active = new Map<WarningId, ActiveWarning>();
  for (const row of rows) {
    if (isWarningId(row.warning)) {
      active.set(row.warning, { level: row.level, startedAt: row.started_at });
    }
  }
  return active;
}
