/**
 * The worker: background work, in its own process beside the API. For now
 * one job: deleting events older than each project's retention, at start
 * and every few hours (retention/retention.ts). The job is safe to repeat
 * and to run in two workers at once, so a plain timer is enough; a job
 * queue comes with work that needs one, such as sending email.
 */
import { loadConfig } from "./config.ts";
import { createDatabase } from "./db/database.ts";
import { deleteExpiredEvents } from "./retention/retention.ts";

/** How often retention runs. Expired events wait at most this long. */
export const RETENTION_INTERVAL_MS = 6 * 60 * 60 * 1000;

const config = loadConfig();
const db = createDatabase({ connectionString: config.databaseUrl, maxConnections: 2 });

/** One JSON line per message, like the API's log. */
function log(level: "info" | "error", msg: string, fields: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ level, time: Date.now(), name: "worker", msg, ...fields }));
}

let timer: ReturnType<typeof setTimeout> | undefined;
let running: Promise<void> = Promise.resolve();
let stopping = false;

async function retention() {
  try {
    const results = await deleteExpiredEvents(db);
    const deleted = results.reduce((sum, result) => sum + result.deleted, 0);
    log("info", "retention ran", { projects: results.length, deleted });
  } catch (error) {
    log("error", "retention failed", { err: String(error) });
  }
  if (!stopping) {
    timer = setTimeout(() => {
      running = retention();
    }, RETENTION_INTERVAL_MS);
  }
}

async function shutdown(signal: NodeJS.Signals) {
  log("info", "shutting down", { signal });
  stopping = true;
  clearTimeout(timer);
  await running; // A run in progress finishes its batch first.
  await db.destroy();
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, (received) => void shutdown(received));
}

log("info", "worker started", { retentionIntervalMs: RETENTION_INTERVAL_MS });
running = retention();
