/**
 * The worker: background work, in its own process beside the API.
 *
 * - Copying events to ClickHouse every few seconds, and deleting them from
 *   PostgreSQL once copied and two days old, every hour (clickhouse/copy-events.ts).
 * - Deleting a deleted project's events from ClickHouse, and its source
 *   maps from the object store, every minute (clickhouse/delete-events.ts).
 * - At start and every few hours: finding projects ClickHouse still holds
 *   events of but PostgreSQL no longer knows, deleting events older than
 *   each project's retention in both databases (retention/retention.ts),
 *   and taking deleted rows off ClickHouse's disk.
 *
 * Both are safe to repeat and to run in two workers at once, so plain
 * timers are enough; a job queue comes with work that needs one.
 */
import { createClickHouse } from "./clickhouse/clickhouse.ts";
import { copyEventsToClickHouse, deleteCopiedEvents } from "./clickhouse/copy-events.ts";
import {
  purgeDeletedProjects,
  queueOrphanedProjects,
  removeDeletedRows,
} from "./clickhouse/delete-events.ts";
import { loadConfig } from "./config.ts";
import { createDatabase } from "./db/database.ts";
import { deleteExpiredEvents } from "./retention/retention.ts";
import { s3ObjectStore } from "./storage/object-store.ts";

/**
 * How often retention runs, with the search for forgotten projects and the
 * removal of deleted rows from disk. Expired events wait at most this long.
 */
export const RETENTION_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** How often events are copied to ClickHouse: how far reports there can trail. */
export const COPY_INTERVAL_MS = 5_000;

/** How often copied events leave PostgreSQL. They stay at most this long past their day. */
export const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

/** How often a deleted project's events are deleted from ClickHouse: at most this late. */
export const PURGE_INTERVAL_MS = 60 * 1000;

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

/** Whether the last copy failed: an outage is logged once, not every few seconds. */
let copyFailing = false;

const stopCopying = every(COPY_INTERVAL_MS, async () => {
  try {
    const copied = await copyEventsToClickHouse(db, clickhouse);
    if (copied > 0) log("info", "events copied to ClickHouse", { copied });
    if (copyFailing) log("info", "copying events to ClickHouse works again");
    copyFailing = false;
  } catch (error) {
    if (!copyFailing) log("error", "copying events to ClickHouse failed", { err: String(error) });
    copyFailing = true;
  }
});

const stopPruning = every(PRUNE_INTERVAL_MS, async () => {
  try {
    const deleted = await deleteCopiedEvents(db);
    log("info", "copied events deleted from PostgreSQL", { deleted });
  } catch (error) {
    log("error", "deleting copied events from PostgreSQL failed", { err: String(error) });
  }
});

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

const stopRetention = every(RETENTION_INTERVAL_MS, async () => {
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
    const clickhouseDeleted = results.reduce((sum, result) => sum + result.clickhouseDeleted, 0);
    const cleanup = await removeDeletedRows(clickhouse);
    log("info", "retention ran", {
      projects: results.length,
      deleted,
      clickhouseDeleted,
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
  await Promise.all([stopCopying(), stopPruning(), stopPurging(), stopRetention()]);
  await clickhouse.close();
  objectStore?.close();
  await db.destroy();
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, (received) => void shutdown(received));
}

log("info", "worker started", {
  copyIntervalMs: COPY_INTERVAL_MS,
  pruneIntervalMs: PRUNE_INTERVAL_MS,
  purgeIntervalMs: PURGE_INTERVAL_MS,
  retentionIntervalMs: RETENTION_INTERVAL_MS,
});
