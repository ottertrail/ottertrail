/**
 * The worker: background work, in its own process beside the API.
 *
 * - Deleting a deleted project's events from ClickHouse, and its source
 *   maps and replays from the object store, every minute
 *   (clickhouse/delete-events.ts).
 * - Joining each session replay's chunks into one object every few
 *   seconds, with what the Replays page lists and its timeline, then
 *   finding each new replay's error in ClickHouse (replays/link.ts), and
 *   deleting replays past their 30 days with retention (replays/replays.ts).
 * - Running due uptime checks every few seconds, at most 20 requests at
 *   once, and recording their state, incidents, and results
 *   (uptime/scheduler.ts).
 * - Evaluating alert rules (alerts/evaluator.ts): a check's rules as soon
 *   as it changes state or shows a new certificate, and every minute the
 *   check-down and error rules of every project, recording each alert
 *   with its notification; and, on a loop of their own every few seconds,
 *   the telemetry rules due (each once a minute, taken by one worker).
 * - Sending due notifications every few seconds, at most 10 at once, by
 *   email and webhook, retrying failures for about an hour, and deleting
 *   deliveries past their 30 days every hour (notifications/sender.ts).
 * - Sending account email every few seconds, with SMTP only: reset links,
 *   "password changed" notices, invitations, and email-change notices,
 *   retried as alert deliveries are, each row deleted once sent or given
 *   up (notifications/account-emails.ts).
 * - At start, every 6 hours, sooner after a failure while a file is
 *   missing, and within a minute of the setting being turned on:
 *   downloading a new location database (monthly) and new data-center
 *   ranges (weekly) when they are due and the instance's "Update location
 *   data automatically" setting is on, one updater at a time
 *   (enrichment/updates.ts). The API loads them within minutes
 *   (enrichment/reload.ts).
 * - At start and every 5 minutes: measuring what fills the disk, setting
 *   the stack's Garage bucket quota to the budgets plus 10% when it
 *   differs, and notifying the channels the "Storage warnings" setting
 *   names when a storage warning starts or ends (storage/warning-job.ts).
 * - Every 30 seconds: the scheduled backup when its daily time is due, an
 *   owner's "Back up now" or "Test restore", and the one retry of a failed
 *   backup (backups/job.ts): each backup encrypted and uploaded to S3, one
 *   at a time in any number of workers.
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
import { TELEMETRY_TICK_MS } from "./alerts/telemetry-rules.ts";
import { BACKUP_TICK_MS, BackupJob } from "./backups/job.ts";
import { BackupSecrets } from "./backups/secrets.ts";
import { backupSourcesOf } from "./backups/sources.ts";
import { createClickHouse } from "./clickhouse/clickhouse.ts";
import {
  purgeDeletedProjects,
  queueOrphanedProjects,
  removeDeletedRows,
} from "./clickhouse/delete-events.ts";
import { loadConfig } from "./config.ts";
import { createDatabase } from "./db/database.ts";
import {
  LocationDataJob,
  SETTING_POLL_MS,
  UPDATE_CHECK_INTERVAL_MS,
} from "./enrichment/updates.ts";
import { AccountEmailSender } from "./notifications/account-emails.ts";
import { pruneDeliveries } from "./notifications/deliveries.ts";
import { smtpMailer } from "./notifications/email.ts";
import { LinkSealer } from "./notifications/link-sealer.ts";
import { DELIVERY_TICK_MS, DeliverySender, PRUNE_INTERVAL_MS } from "./notifications/sender.ts";
import { addressPolicy, systemLookup } from "./outbound/addresses.ts";
import { linkReplays } from "./replays/link.ts";
import { deleteExpiredReplays, deleteJoinedChunks, joinReplays } from "./replays/replays.ts";
import { deleteExpiredEvents } from "./retention/retention.ts";
import { probeOpenAdminApi } from "./storage/garage-admin.ts";
import { s3ObjectStore } from "./storage/object-store.ts";
import { storageSourcesOf } from "./storage/usage.ts";
import { STORAGE_CHECK_INTERVAL_MS, StorageWarningJob } from "./storage/warning-job.ts";
import { CHECK_TICK_MS, CheckScheduler } from "./uptime/scheduler.ts";
import { OTTERTRAIL_VERSION } from "./version.ts";

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
const db = createDatabase({
  connectionString: config.databaseUrl,
  maxConnections: 3,
  onIdleError: (error) =>
    log("warn", "an idle PostgreSQL connection ended; the next query opens a new one", {
      err: error.message,
    }),
});
const clickhouse = createClickHouse(config.clickhouse);
const objectStore = config.objectStore === null ? null : s3ObjectStore(config.objectStore);

/** One JSON line per message, like the API's log. */
function log(level: "info" | "warn" | "error", msg: string, fields: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ level, time: Date.now(), name: "worker", msg, ...fields }));
}

let stopping = false;

/**
 * Runs `job` now and then every `intervalMs` after each run ends, until
 * shutdown. Returns what stops it: the waiting timer is cleared, and a run
 * in progress finishes first.
 */
function every(intervalMs: number, job: () => Promise<unknown>): () => Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<unknown> = Promise.resolve();
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
    const { firstError, ...result } = await joinReplays(db, objectStore);
    const chunksDeleted = await deleteJoinedChunks(db);
    if (result.joined + result.dropped + chunksDeleted > 0) {
      log("info", "session replays joined", { ...result, chunksDeleted });
    }
    // Replays the store refused wait for the next run; the others went on.
    if (result.failed > 0) {
      if (!replaysFailing) {
        log("error", "the object store refused some session replays; they wait for the next run", {
          failed: result.failed,
          err: String(firstError),
        });
      }
      replaysFailing = true;
      return;
    }
    if (replaysFailing) log("info", "joining session replays works again");
    replaysFailing = false;
  } catch (error) {
    if (!replaysFailing) log("error", "joining session replays failed", { err: String(error) });
    replaysFailing = true;
  }
});

/** Whether the last search for replays' errors failed: a ClickHouse outage is logged once. */
let linkingFailing = false;

const stopLinking = every(REPLAY_INTERVAL_MS, async () => {
  if (objectStore === null) return;
  try {
    const links = await linkReplays(db, { client: clickhouse });
    if (links.linked + links.givenUp > 0)
      log("info", "session replays linked to their errors", links);
    if (linkingFailing) log("info", "finding session replays' errors works again");
    linkingFailing = false;
  } catch (error) {
    if (!linkingFailing) {
      log("error", "finding session replays' errors failed", { err: String(error) });
    }
    linkingFailing = true;
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
// Telemetry rules due, every few seconds, on a loop of their own.
const stopTelemetryAlerts = every(TELEMETRY_TICK_MS, () => alerts.telemetryTick());

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

/** Account email, apart from alert deliveries; links start with PUBLIC_URL. */
// Queued links are sealed with a key from AUTH_SECRET, which the API uses too.
const accountEmails = new AccountEmailSender({
  db,
  mailer,
  sealer: new LinkSealer(config.authSecret),
  publicUrl: config.publicUrl,
  log,
});
if (mailer === null) {
  // The API may have SMTP while this worker has not: say so once, and keep the rows.
  void accountEmails.waiting().then(
    (waiting) => {
      if (waiting > 0) {
        log(
          "warn",
          "account emails are waiting, but SMTP_URL is not set on the worker: they stay queued for up to a day. Set SMTP_URL and EMAIL_FROM for the worker as for the API, then restart it to send them",
          { waiting },
        );
      }
    },
    () => undefined,
  );
}

/** Whether the last look for due account emails failed: an outage is logged once. */
let accountEmailsFailing = false;

const stopAccountEmails = every(DELIVERY_TICK_MS, async () => {
  try {
    await accountEmails.tick();
    if (accountEmailsFailing) log("info", "taking due account emails works again");
    accountEmailsFailing = false;
  } catch (error) {
    if (!accountEmailsFailing) {
      log("error", "taking due account emails failed", { err: String(error) });
    }
    accountEmailsFailing = true;
  }
});

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

/**
 * The location database and the data-center ranges: each downloaded when
 * due, checked, and swapped in; a failure keeps the old file, is recorded
 * for the Settings page, and waits for the next round, hours later.
 */
const locationData = new LocationDataJob({
  db,
  geoSource: config.geoSource,
  databasePath: config.geoDatabasePath,
  dataCentersPath: config.dataCentersPath,
  log,
});
const stopLocationData = every(SETTING_POLL_MS, () => locationData.tick());

/** What fills the disk, the Garage quota, and storage warnings to the channels. */
const storage = new StorageWarningJob({
  db,
  // Garage's admin token goes only to its client: never logged.
  sources: storageSourcesOf(config, db, clickhouse),
  publicUrl: config.publicUrl,
  log,
});
const stopStorage = every(STORAGE_CHECK_INTERVAL_MS, () => storage.tick());

/**
 * Scheduled backups: the destination's secret and the backup key are
 * sealed with a key from AUTH_SECRET, as the API seals them; a separate
 * destination follows the uptime checks' address rules.
 */
const backups = new BackupJob({
  db,
  objectStore: config.objectStore,
  stackGarage: config.garage !== null,
  secrets: new BackupSecrets(config.authSecret),
  rules: { policy, lookup: systemLookup },
  sources: backupSourcesOf(config, clickhouse),
  version: OTTERTRAIL_VERSION,
  log,
});
const stopBackups = every(BACKUP_TICK_MS, () => backups.tick());

// Without the token, Garage's admin API must refuse everyone (garage-admin.ts).
if (config.garage !== null && config.garage.adminToken === null) {
  void probeOpenAdminApi(config.garage.adminUrl).then((result) => {
    if (result === "accepted") {
      log(
        "error",
        "Garage's admin API answers without a token: set GARAGE_ADMIN_TOKEN, or stop Garage",
        {
          adminUrl: config.garage?.adminUrl,
        },
      );
    }
  });
}

async function shutdown(signal: NodeJS.Signals) {
  log("info", "shutting down", { signal });
  stopping = true;
  // Telemetry rules not started yet are left to another worker, or the next start.
  alerts.stop();
  // A backup under way is cut off: it fails, saying so, and deletes what it uploaded.
  backups.stop();
  // A download under way is cut off: the old files stay, its lease is given
  // back, and the next start tries again.
  await locationData.stop();
  // Runs in progress finish their batch first.
  await Promise.all([
    stopPurging(),
    stopReplays(),
    stopLinking(),
    stopChecks(),
    stopAlerts(),
    stopTelemetryAlerts(),
    stopDeliveries(),
    stopAccountEmails(),
    stopPruning(),
    stopRetention(),
    stopLocationData(),
    stopStorage(),
    stopBackups(),
  ]);
  // Requests under way finish and are recorded: each is at most 30 seconds.
  await Promise.all([checks.drain(), deliveries.drain(), accountEmails.drain()]);
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
  locationDataCheckIntervalMs: UPDATE_CHECK_INTERVAL_MS,
  storageCheckIntervalMs: STORAGE_CHECK_INTERVAL_MS,
  clickhouseBackupPath: config.clickhouseBackupPath,
  garageAdmin:
    config.garage === null ? "not the stack's Garage" : config.garage.adminToken !== null,
});
