/**
 * The worker: background work, in its own process beside the API.
 *
 * - Deleting a deleted project's events from ClickHouse, and its source
 *   maps and replays from the object store, every minute
 *   (clickhouse/delete-events.ts).
 * - Joining each session replay's chunks into one object every few
 *   seconds, and deleting replays past their 30 days with retention
 *   (replays/replays.ts).
 * - Running due uptime checks every few seconds, at most 20 requests at
 *   once, and recording their state, incidents, and results
 *   (uptime/scheduler.ts).
 * - Evaluating alert rules (alerts/evaluator.ts): a check's rules as soon
 *   as it changes state or shows a new certificate, and every minute the
 *   check-down and error rules of every project, recording each alert
 *   with its notification.
 * - Sending due notifications every few seconds, at most 10 at once, by
 *   email and webhook, retrying failures for about an hour, and deleting
 *   deliveries past their 30 days every hour (notifications/sender.ts).
 * - At start and every few hours: finding projects ClickHouse still holds
 *   events of but PostgreSQL no longer knows, deleting events older than
 *   each project's retention (retention/retention.ts),
 *   and taking deleted rows off ClickHouse's disk.
 *
 * All are safe to repeat and to run in two workers at once (uptime checks
 * and deliveries are taken with FOR UPDATE SKIP LOCKED), so plain timers
 * are enough; a job queue comes with work that needs one.
 */
import { ALERT_TICK_MS, AlertEvaluator } from "./alerts/evaluator.ts";
import { createClickHouse } from "./clickhouse/clickhouse.ts";
import {
  purgeDeletedProjects,
  queueOrphanedProjects,
  removeDeletedRows,
} from "./clickhouse/delete-events.ts";
import { loadConfig } from "./config.ts";
import { createDatabase } from "./db/database.ts";
import { pruneDeliveries } from "./notifications/deliveries.ts";
import { smtpMailer } from "./notifications/email.ts";
import { DELIVERY_TICK_MS, DeliverySender, PRUNE_INTERVAL_MS } from "./notifications/sender.ts";
import { addressPolicy } from "./outbound/addresses.ts";
import { deleteExpiredReplays, deleteJoinedChunks, joinReplays } from "./replays/replays.ts";
import { deleteExpiredEvents } from "./retention/retention.ts";
import { s3ObjectStore } from "./storage/object-store.ts";
import { CHECK_TICK_MS, CheckScheduler } from "./uptime/scheduler.ts";

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

// Uptime checks and webhooks follow the same address rules.
const policy = addressPolicy({
  allowPrivate: config.uptimeAllowPrivateAddresses,
  deny: config.uptimeDenyAddresses,
});

const alerts = new AlertEvaluator({ db, clickhouse, publicUrl: config.publicUrl, log });

const checks = new CheckScheduler({
  db,
  clickhouse,
  policy,
  log,
  onStateChange: async (change) => {
    log(
      "info",
      change.to === "down" ? "an uptime check went down" : "an uptime check is up again",
      {
        check: change.checkId,
        project: change.projectId,
        cause: change.cause,
      },
    );
    await alerts.onStateChange(change);
  },
  onCertificate: (check) => alerts.onCertificate(check),
});

const stopAlerts = every(ALERT_TICK_MS, () => alerts.tick());

/** Whether the last look for due checks failed: an outage is logged once. */
let checksFailing = false;

const stopChecks = every(CHECK_TICK_MS, async () => {
  try {
    await checks.tick();
    if (checksFailing) log("info", "taking due uptime checks works again");
    checksFailing = false;
  } catch (error) {
    if (!checksFailing) log("error", "taking due uptime checks failed", { err: String(error) });
    checksFailing = true;
  }
});

// SMTP_URL holds a password: it is never logged, only whether it is set.
const mailer = config.email === null ? null : smtpMailer(config.email);
const deliveries = new DeliverySender({ db, mailer, policy, log });

/** Whether the last look for due deliveries failed: an outage is logged once. */
let deliveriesFailing = false;

const stopDeliveries = every(DELIVERY_TICK_MS, async () => {
  try {
    await deliveries.tick();
    if (deliveriesFailing) log("info", "taking due notifications works again");
    deliveriesFailing = false;
  } catch (error) {
    if (!deliveriesFailing) log("error", "taking due notifications failed", { err: String(error) });
    deliveriesFailing = true;
  }
});

const stopPruning = every(PRUNE_INTERVAL_MS, async () => {
  try {
    const pruned = await pruneDeliveries(db);
    if (pruned > 0) log("info", "old notification deliveries deleted", { pruned });
  } catch (error) {
    log("error", "deleting old notification deliveries failed", { err: String(error) });
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
  await Promise.all([
    stopPurging(),
    stopReplays(),
    stopChecks(),
    stopAlerts(),
    stopDeliveries(),
    stopPruning(),
    stopRetention(),
  ]);
  // Requests under way finish and are recorded: each is at most 30 seconds.
  await Promise.all([checks.drain(), deliveries.drain()]);
  mailer?.close();
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
  uptimeAllowPrivateAddresses: config.uptimeAllowPrivateAddresses,
  uptimeDenyAddresses: config.uptimeDenyAddresses,
  emailConfigured: config.email !== null,
});
