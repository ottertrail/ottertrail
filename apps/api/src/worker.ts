/**
 * Jobs are safe to repeat across workers; uptime checks and deliveries use
 * FOR UPDATE SKIP LOCKED. Timers are sufficient without a separate job queue.
 * Only the worker reads BACKUP_S3_*; the API receives a report without secrets
 * (backups/job.ts). Worker logs reach the API through server-log/relay.ts.
 */
import { pruneIngestActivity } from "./activity/activity.ts";
import { ALERT_TICK_MS, AlertEvaluator } from "./alerts/evaluator.ts";
import { TELEMETRY_TICK_MS } from "./alerts/telemetry-rules.ts";
import { FAVICON_TICK_MS, FaviconJob, faviconPolicy } from "./avatars/favicons.ts";
import { BACKUP_TICK_MS, BackupJob } from "./backups/job.ts";
import { BackupSecrets } from "./backups/secrets.ts";
import { backupSourcesOf } from "./backups/sources.ts";
import { createClickHouse } from "./clickhouse/clickhouse.ts";
import {
  purgeDeletedProjects,
  queueOrphanedProjects,
  removeDeletedRows,
} from "./clickhouse/delete-events.ts";
import { loadBackupS3, loadConfig } from "./config.ts";
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
import { deleteExpiredEvents, deleteExpiredTelemetry } from "./retention/retention.ts";
import { redactRecord } from "./server-log/redact.ts";
import { WorkerLogRelay } from "./server-log/relay.ts";
import { probeOpenAdminApi } from "./storage/garage-admin.ts";
import { s3ObjectStore } from "./storage/object-store.ts";
import { storageSourcesOf } from "./storage/usage.ts";
import { STORAGE_CHECK_INTERVAL_MS, StorageWarningJob } from "./storage/warning-job.ts";
import { CHECK_TICK_MS, CheckScheduler } from "./uptime/scheduler.ts";
import { OTTERTRAIL_VERSION } from "./version.ts";

/** Expired events can wait this long for retention and disk cleanup. */
export const RETENTION_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Deleted project data can wait this long for ClickHouse cleanup. */
export const PURGE_INTERVAL_MS = 60 * 1000;

export const ACTIVITY_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Finished replays can wait this long before appearing. */
export const REPLAY_INTERVAL_MS = 10_000;

const config = loadConfig();
// Start relaying before the first log line.
const relay = new WorkerLogRelay({ connectionString: config.databaseUrl });
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

/** Redact before writing to stdout and the Server log (server-log/redact.ts). */
function log(level: "info" | "warn" | "error", msg: string, fields: Record<string, unknown> = {}) {
  const { value } = redactRecord({ level, time: Date.now(), name: "worker", msg, ...fields });
  console.log(JSON.stringify(value));
  relay.send(value);
}

let stopping = false;

/**
 * Wait intervalMs after each run finishes. Shutdown clears the timer
 * and waits for any active run.
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

/** Log an outage once until recovery. */
let replaysFailing = false;

const stopReplays = every(REPLAY_INTERVAL_MS, async () => {
  if (objectStore === null) return;
  try {
    const { firstError, ...result } = await joinReplays(db, objectStore, {
      onError: (error, { projectId, replayId, dropped }) => {
        // A failure that waits for the next run is logged once, below.
        if (dropped) {
          log("error", "a session replay could not be joined and was dropped", {
            projectId,
            replayId,
            err: String(error),
          });
        }
      },
    });
    const chunksDeleted = await deleteJoinedChunks(db);
    if (result.joined + result.dropped + chunksDeleted > 0) {
      log("info", "session replays joined", { ...result, chunksDeleted });
    }
    // Replays the store refused wait for the next run; the others went on.
    if (result.failed > 0) {
      if (!replaysFailing) {
        log("error", "some session replays could not be joined; they wait for the next run", {
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

/** Log a ClickHouse outage once until recovery. */
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
const stopTelemetryAlerts = every(TELEMETRY_TICK_MS, () => alerts.telemetryTick());

/** Log an outage once until recovery. */
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

/** Account links use PUBLIC_URL. */
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

/** Log an outage once until recovery. */
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

/** Log an outage once until recovery. */
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

const stopActivityPruning = every(ACTIVITY_PRUNE_INTERVAL_MS, async () => {
  try {
    const pruned = await pruneIngestActivity(db);
    if (pruned > 0) log("info", "old ingestion activity counts deleted", { pruned });
  } catch (error) {
    log("error", "deleting old ingestion activity counts failed", { err: String(error) });
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
    // Projects that keep fewer days of telemetry than the TTL's maximum.
    const telemetry = await deleteExpiredTelemetry(db, clickhouse, {
      maxDays: config.telemetryRetentionDays,
    });
    const telemetryDeleted = telemetry.reduce((sum, result) => sum + result.deleted, 0);
    const cleanup = await removeDeletedRows(clickhouse);
    log("info", "retention ran", {
      projects: results.length,
      deleted,
      telemetryProjects: telemetry.length,
      telemetryDeleted,
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
 * Failed location updates keep the old files and retry next round
 * (enrichment/updates.ts).
 */
const locationData = new LocationDataJob({
  db,
  databasePath: config.geoDatabasePath,
  dataCentersPath: config.dataCentersPath,
  log,
});
const stopLocationData = every(SETTING_POLL_MS, () => locationData.tick());

const storage = new StorageWarningJob({
  db,
  // Garage's admin token goes only to its client: never logged.
  sources: storageSourcesOf(config, db, clickhouse),
  publicUrl: config.publicUrl,
  log,
});
const stopStorage = every(STORAGE_CHECK_INTERVAL_MS, () => storage.tick());

/**
 * Read BACKUP_S3_* only here. Configuration errors stop backups alone.
 * Seal the backup key with AUTH_SECRET, as the API does (backups/job.ts).
 */
const backupDestination = loadBackupS3(process.env, config.objectStore);
const backups = new BackupJob({
  db,
  destination: backupDestination,
  secrets: new BackupSecrets(config.authSecret),
  sources: backupSourcesOf(config, clickhouse),
  version: OTTERTRAIL_VERSION,
  log,
});
const stopBackups = every(BACKUP_TICK_MS, () => backups.tick());

// Never private addresses, whatever the uptime checks may reach.
const favicons = new FaviconJob({
  db,
  store: objectStore,
  policy: faviconPolicy(config),
  lookup: systemLookup,
  log,
});

/** Log an outage once until recovery. */
let faviconsFailing = false;

const stopFavicons = every(FAVICON_TICK_MS, async () => {
  try {
    const fetched = await favicons.tick();
    if (fetched.kept > 0) log("info", "project favicons fetched", fetched);
    faviconsFailing = false;
  } catch (error) {
    if (!faviconsFailing) log("error", "fetching project favicons failed", { err: String(error) });
    faviconsFailing = true;
  }
});

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
    stopActivityPruning(),
    stopRetention(),
    stopLocationData(),
    stopStorage(),
    stopBackups(),
    stopFavicons(),
  ]);
  // Requests under way finish and are recorded: each is at most 30 seconds.
  await Promise.all([checks.drain(), deliveries.drain(), accountEmails.drain()]);
  mailer?.close();
  await clickhouse.close();
  objectStore?.close();
  await db.destroy();
  await relay.close();
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
  backupDestination:
    backupDestination === null
      ? "not set"
      : "problem" in backupDestination
        ? "invalid"
        : `${backupDestination.bucket}/${backupDestination.prefix}`,
  garageAdmin:
    config.garage === null ? "not the stack's Garage" : config.garage.adminToken !== null,
});
