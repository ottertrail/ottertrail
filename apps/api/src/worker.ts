/**
 * The worker: background work, in its own process beside the API.
 *
 * - Copying events to ClickHouse every few seconds (clickhouse/copy-events.ts).
 * - Deleting events older than each project's retention, at start and every
 *   few hours (retention/retention.ts).
 *
 * Both are safe to repeat and to run in two workers at once, so plain
 * timers are enough; a job queue comes with work that needs one.
 */
import { createClickHouse } from "./clickhouse/clickhouse.ts";
import { copyEventsToClickHouse } from "./clickhouse/copy-events.ts";
import { loadConfig } from "./config.ts";
import { createDatabase } from "./db/database.ts";
import { deleteExpiredEvents } from "./retention/retention.ts";

/** How often retention runs. Expired events wait at most this long. */
export const RETENTION_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** How often events are copied to ClickHouse: how far reports there can trail. */
export const COPY_INTERVAL_MS = 5_000;

const config = loadConfig();
const db = createDatabase({ connectionString: config.databaseUrl, maxConnections: 3 });
const clickhouse = createClickHouse(config.clickhouse);

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

const stopRetention = every(RETENTION_INTERVAL_MS, async () => {
  try {
    const results = await deleteExpiredEvents(db);
    const deleted = results.reduce((sum, result) => sum + result.deleted, 0);
    log("info", "retention ran", { projects: results.length, deleted });
  } catch (error) {
    log("error", "retention failed", { err: String(error) });
  }
});

async function shutdown(signal: NodeJS.Signals) {
  log("info", "shutting down", { signal });
  stopping = true;
  // Runs in progress finish their batch first.
  await Promise.all([stopCopying(), stopRetention()]);
  await clickhouse.close();
  await db.destroy();
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, (received) => void shutdown(received));
}

log("info", "worker started", {
  copyIntervalMs: COPY_INTERVAL_MS,
  retentionIntervalMs: RETENTION_INTERVAL_MS,
});
