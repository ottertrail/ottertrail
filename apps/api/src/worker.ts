/**
 * The worker: background work, in its own process beside the API.
 *
 * - Deleting a deleted project's events from ClickHouse, and its source
 *   maps and replays from the object store, every minute
 *   (clickhouse/delete-events.ts).
 * - Joining each session replay's chunks into one object every few
 *   seconds, and deleting replays past their 30 days with retention
 *   (replays/replays.ts).
 * - At start and every few hours: finding projects ClickHouse still holds
 *   events of but PostgreSQL no longer knows, deleting events older than
 *   each project's retention (retention/retention.ts),
 *   and taking deleted rows off ClickHouse's disk.
 *
 * All are safe to repeat and to run in two workers at once, so plain
 * timers are enough; a job queue comes with work that needs one.
 */
import { createClickHouse } from "./clickhouse/clickhouse.ts";
import {
  purgeDeletedProjects,
  queueOrphanedProjects,
  removeDeletedRows,
} from "./clickhouse/delete-events.ts";
import { loadConfig } from "./config.ts";
import { createDatabase } from "./db/database.ts";
import { deleteExpiredReplays, deleteJoinedChunks, joinReplays } from "./replays/replays.ts";
import { deleteExpiredEvents } from "./retention/retention.ts";
import { s3ObjectStore } from "./storage/object-store.ts";

/**
 * How often retention runs, with the search for forgotten projects and the
 * removal of deleted rows from disk. Expired events wait at most this long.
 */
export const RETENTION_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** How often a deleted project's events are deleted from ClickHouse: at most this late. */
export const PURGE_INTERVAL_MS = 60 * 1000;

/** How often finished replays are joined: how long one waits to be seen. */
export const REPLAY_INTERVAL_MS = 10_000;

const config = loadConfig();
const db = createDatabase({ connectionString: config.databaseUrl, maxConnections: 3 });
const clickhouse = createClickHouse(config.clickhouse);
const objectStore = config.objectStore === null ? null : s3ObjectStore(config.objectStore);

/** One JSON line per message, like the API's log. */
function log(level: "info" | "error", msg: string, fields: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ level, time: Date.now(), name: "worker", msg, ...fields }));
}

let stopping = false;

/**
 * Runs `job` now and then every `intervalMs` after each run ends, until
 * shutdown. Returns what stops it: the waiting timer is cleared, and a run
 * in progress finishes first.
 */
function every(intervalMs: number, job: () => Promise<void>): () => Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> = Promise.resolve();
  const run = () => {
    running = job().finally(() => {
      if (!stopping) timer = setTimeout(run, intervalMs);
    });
  };
  run();
  return async () => {
    clearTimeout(timer);
    await running;
  };
}

const stopPurging = every(PURGE_INTERVAL_MS, async () => {
  try {
    const purged = await purgeDeletedProjects(db, clickhouse, objectStore);
    if (purged.projects > 0) log("info", "deleted projects' events and files deleted", purged);
  } catch (error) {
    log("error", "deleting deleted projects' events and files failed", {
      err: String(error),
    });
  }
});

/** Whether the last join failed: an outage is logged once. */
let replaysFailing = false;

const stopReplays = every(REPLAY_INTERVAL_MS, async () => {
  if (objectStore === null) return;
  try {
    const result = await joinReplays(db, objectStore);
    const chunksDeleted = await deleteJoinedChunks(db);
    if (result.joined + result.dropped + chunksDeleted > 0) {
      log("info", "session replays joined", { ...result, chunksDeleted });
    }
    if (replaysFailing) log("info", "joining session replays works again");
    replaysFailing = false;
  } catch (error) {
    if (!replaysFailing) log("error", "joining session replays failed", { err: String(error) });
    replaysFailing = true;
  }
});

const stopRetention = every(RETENTION_INTERVAL_MS, async () => {
  if (objectStore !== null) {
    try {
      const expired = await deleteExpiredReplays(db, objectStore);
      if (expired > 0) log("info", "expired session replays deleted", { expired });
    } catch (error) {
      log("error", "deleting expired session replays failed", { err: String(error) });
    }
  }
  try {
    const sweep = await queueOrphanedProjects(db, clickhouse);
    if (sweep.queued) {
      log("info", "deleted projects found in ClickHouse, to be deleted", {
        projects: sweep.orphans,
      });
    } else if (sweep.orphans > 0) {
      // Too many to be deletions the purge missed: PostgreSQL may be the
      // wrong database, or empty. A person decides (docs/clickhouse.md).
      log("error", "ClickHouse holds events of projects PostgreSQL does not know; not deleting", {
        projects: sweep.orphans,
      });
    }
    const results = await deleteExpiredEvents(db, clickhouse);
    const deleted = results.reduce((sum, result) => sum + result.deleted, 0);
    const cleanup = await removeDeletedRows(clickhouse);
    log("info", "retention ran", {
      projects: results.length,
      deleted,
      rewriting: cleanup.started,
    });
    if (cleanup.waitingFor?.failReason) {
      log("error", "a change to ClickHouse's events keeps failing; deleted rows stay on disk", {
        mutation: cleanup.waitingFor.mutationId,
        reason: cleanup.waitingFor.failReason,
      });
    }
  } catch (error) {
    log("error", "retention failed", { err: String(error) });
  }
});

async function shutdown(signal: NodeJS.Signals) {
  log("info", "shutting down", { signal });
  stopping = true;
  // Runs in progress finish their batch first.
  await Promise.all([stopPurging(), stopReplays(), stopRetention()]);
  await clickhouse.close();
  objectStore?.close();
  await db.destroy();
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, (received) => void shutdown(received));
}

log("info", "worker started", {
  purgeIntervalMs: PURGE_INTERVAL_MS,
  retentionIntervalMs: RETENTION_INTERVAL_MS,
});
