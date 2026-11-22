import type { FastifyPluginCallback, FastifyReply, FastifyRequest } from "fastify";
import type { Kysely, Transaction } from "kysely";

import { requirePermission } from "../access/access.ts";
import { checkPassword } from "../access/members.ts";
import type { Auth } from "../auth/auth.ts";
import { requireTrustedOrigin } from "../auth/origin.ts";
import { passwordTryLimiter } from "../auth/password-tries.ts";
import { requireSession, signedInUser } from "../auth/routes.ts";
import { type RateLimit, TokenBucketLimiter } from "../collection/rate-limiter.ts";
import type { Database } from "../db/schema.ts";
import { enqueueAccountEmail } from "../notifications/account-emails.ts";
import { notifyIn } from "../notifications/deliveries.ts";
import type { LinkSealer } from "../notifications/link-sealer.ts";
import { readInstanceSettings } from "../settings/settings.ts";
import { readWarningChannels } from "../storage/warning-state.ts";
import { nextDue, overdueSlot } from "./schedule.ts";
import { type BackupSecrets, keyFileName, keyFileText, makeBackupKey } from "./secrets.ts";
import {
  type BackupSettings,
  MAX_KEEP_DAYS,
  readBackupSettings,
  TIME_PATTERN,
} from "./settings.ts";
import { latestRuns, type Run } from "./state.ts";

/** Test connection, per user: 10 in 10 minutes. */
export const DEFAULT_TEST_CONNECTION_LIMIT: RateLimit = { capacity: 10, refillPerSecond: 10 / 600 };
/** Back up now, per user: 3 an hour. */
export const DEFAULT_BACKUP_NOW_LIMIT: RateLimit = { capacity: 3, refillPerSecond: 3 / 3600 };
/** Test restore, per user: 3 an hour, since it downloads a whole backup. */
export const DEFAULT_TEST_RESTORE_LIMIT: RateLimit = { capacity: 3, refillPerSecond: 3 / 3600 };

/** Refuses past the limit with 429 and how long to wait; true when it may go on. */
function within(
  limiter: TokenBucketLimiter,
  what: string,
  request: FastifyRequest,
  reply: FastifyReply,
): boolean {
  const tried = limiter.take(signedInUser(request).id);
  if (tried.allowed) return true;
  void reply
    .code(429)
    .header("retry-after", String(tried.retryAfterSeconds))
    .send({
      error: "rate_limited",
      message: `${what} limit reached. Retry in ${tried.retryAfterSeconds} seconds.`,
    });
  return false;
}

/** What each guarded action did, as a notice says it after the person's name. */
export const BACKUP_ACTIONS = {
  key_shown: "showed the backup key",
  key_downloaded: "downloaded the backup key",
  turned_off: "turned backups off",
} as const;

export type BackupAction = keyof typeof BACKUP_ACTIONS;

const PASSWORD = { type: "string", minLength: 1, maxLength: 128 } as const;

const PASSWORD_NEEDED = {
  error: "password_required",
  message: "Enter your current password.",
} as const;

const WRONG_PASSWORD = {
  error: "wrong_password",
  message: "Incorrect password. Try again.",
} as const;

const iso = (date: Date | null) => date?.toISOString() ?? null;

function runView(run: Run | null) {
  if (run === null) return null;
  return {
    kind: run.kind,
    trigger: run.trigger,
    status: run.status,
    startedAt: run.startedAt.toISOString(),
    finishedAt: iso(run.finishedAt),
    durationMs: run.finishedAt === null ? null : run.finishedAt.getTime() - run.startedAt.getTime(),
    bytes: run.bytes,
    folder: run.folder,
    error: run.error,
  };
}

interface SettingsBody {
  enabled?: boolean;
  timeOfDay?: string;
  keepDays?: number;
  /** Needed to turn backups off. */
  currentPassword?: string;
}

/** Turning backups on without a destination the worker reported. */
export const NO_DESTINATION_REPORTED =
  "No backup destination. Set the BACKUP_S3_* variables in the server's .env, restart the worker, then turn backups on.";

/** Why backups can't be turned on, or Test connection asked for: null when they can. */
function destinationMissing(settings: BackupSettings): string | null {
  if (settings.destinationProblem !== null) {
    return `The worker's BACKUP_S3_* variables have a problem: ${settings.destinationProblem}`;
  }
  return settings.destination === null ? NO_DESTINATION_REPORTED : null;
}

/**
 * GET    /api/settings/backups                  settings, destination, key, and status
 * PATCH  /api/settings/backups                  the settings; the first turn-on makes the key
 * POST   /api/settings/backups/test-connection  Test connection (the worker runs it)
 * POST   /api/settings/backups/run              Back up now (the worker runs it)
 * POST   /api/settings/backups/test-restore     Test restore (the worker runs it)
 * GET    /api/settings/backups/list             the folder's backups, as the worker listed them
 * POST   /api/settings/backups/key              the backup key, to view { password } (logged)
 * POST   /api/settings/backups/key/file         the backup key as a file { password } (logged)
 * POST   /api/settings/backups/key/saved        the owner saved the key: the reminder goes
 * POST   /api/settings/backups/key/replace      a new key, only when the old can't be read
 *
 * The Backups tab of the instance's Settings, for the owner only
 * (docs/access.md): the `settings` permission. Changes check Origin;
 * bodies are checked before any database work. Where backups go is the
 * worker's BACKUP_S3_* (config.ts), which this process never reads: the
 * tab shows what the worker reported (backups/job.ts). The key is only in
 * the two key routes, which log that it was shown (not the key). Test
 * connection, Back up now, and Test restore are limited per user.
 *
 * A stolen session must not take or stop the backups quietly: showing or
 * downloading the key, and turning backups off, need the current password (from the app's one limiter for password
 * tries, auth/password-tries.ts), and each sends `backups.changed` to the
 * channels that get storage warnings, and an account email to the owner
 * when SMTP is set up.
 */
export const backupRoutes: FastifyPluginCallback<{
  db: Kysely<Database>;
  auth: Auth;
  trustedOrigins: readonly string[];
  secrets: BackupSecrets;
  testConnectionLimit?: RateLimit;
  backupNowLimit?: RateLimit;
  testRestoreLimit?: RateLimit;
  /** The app's one limiter for current-password checks. */
  passwordTries?: TokenBucketLimiter;
  /** For notices' links. */
  publicUrl: string;
  /** With SMTP set up, the owner gets an account email for each guarded action. */
  emailConfigured?: boolean;
  sealer?: LinkSealer | null;
  now?: () => Date;
}> = (
  app,
  {
    db,
    auth,
    trustedOrigins,
    secrets,
    testConnectionLimit = DEFAULT_TEST_CONNECTION_LIMIT,
    backupNowLimit = DEFAULT_BACKUP_NOW_LIMIT,
    testRestoreLimit = DEFAULT_TEST_RESTORE_LIMIT,
    passwordTries = passwordTryLimiter(),
    publicUrl,
    emailConfigured = false,
    sealer = null,
    now = () => new Date(),
  },
  done,
) => {
  const signedIn = requireSession(auth);
  const fromDashboard = requireTrustedOrigin(trustedOrigins);
  const owner = requirePermission(db, "settings");
  const limits = {
    testConnection: new TokenBucketLimiter(testConnectionLimit),
    backupNow: new TokenBucketLimiter(backupNowLimit),
    testRestore: new TokenBucketLimiter(testRestoreLimit),
  };

  /**
   * Checks the current password; false once it has answered the request
   * (missing, wrong, or too many tries).
   */
  async function passwordConfirmed(
    request: FastifyRequest,
    reply: FastifyReply,
    password: string | undefined,
  ): Promise<boolean> {
    if (password === undefined || password === "") {
      void reply.code(400).send(PASSWORD_NEEDED);
      return false;
    }
    const user = signedInUser(request);
    const tried = passwordTries.take(user.id);
    if (!tried.allowed) {
      void reply
        .code(429)
        .header("retry-after", String(tried.retryAfterSeconds))
        .send({
          error: "rate_limited",
          message: `Too many attempts. Retry after ${tried.retryAfterSeconds} seconds.`,
        });
      return false;
    }
    if (!(await checkPassword(db, auth, user.id, password))) {
      void reply.code(403).send(WRONG_PASSWORD);
      return false;
    }
    return true;
  }

  /** Tells the storage-warning channels, and the owner by email, what was done to the backups. */
  async function notice(
    trx: Transaction<Database>,
    request: FastifyRequest,
    actions: readonly BackupAction[],
  ): Promise<void> {
    if (actions.length === 0) return;
    const user = signedInUser(request);
    const at = now();
    const channelIds = await readWarningChannels(trx);
    for (const action of actions) {
      request.log.info({ userId: user.id, action }, "backup settings action");
      await notifyIn(trx, {
        channelIds,
        type: "backups.changed",
        project: null,
        subject: { type: "backups", action },
        message: `${user.name} ${BACKUP_ACTIONS[action]}.`,
        url: `${publicUrl}/settings?tab=backups`,
        time: at,
        // The Backups tab is the owner's.
        inbox: { title: `${user.name} ${BACKUP_ACTIONS[action]}`, permission: "settings" },
      });
      if (emailConfigured && sealer !== null) {
        const theOwner = await trx
          .selectFrom("dashboard_users")
          .select("email")
          .where("role", "=", "owner")
          .executeTakeFirst();
        if (theOwner !== undefined) {
          await enqueueAccountEmail(
            trx,
            {
              kind: "backup_changed",
              to: theOwner.email,
              params: { action: BACKUP_ACTIONS[action], by: user.name, at: at.toISOString() },
            },
            sealer,
          );
        }
      }
    }
  }

  function keyState(settings: BackupSettings): "none" | "ready" | "unreadable" {
    if (settings.keySealed === null) return "none";
    return secrets.openKey(settings.keySealed) === null ? "unreadable" : "ready";
  }

  async function view() {
    const [settings, runs, { timeZone }] = await Promise.all([
      readBackupSettings(db),
      latestRuns(db),
      readInstanceSettings(db),
    ]);
    const at = now();
    const schedule = {
      enabled: settings.enabled,
      timeOfDay: settings.timeOfDay,
      scheduleFrom: settings.scheduleFrom,
      lastSlot: settings.lastSlot,
    };
    const overdue =
      runs.running?.kind === "backup"
        ? null
        : overdueSlot(at, schedule, timeZone, runs.lastSuccess?.startedAt ?? null);
    return {
      settings: {
        enabled: settings.enabled,
        timeOfDay: settings.timeOfDay,
        keepDays: settings.keepDays,
        /** Since when, and by whom, backups are off; null while on, or never turned on. */
        disabledAt: settings.enabled ? null : iso(settings.disabledAt),
        disabledBy: settings.enabled ? null : settings.disabledBy,
      },
      // What the worker last reported of its BACKUP_S3_*, never the secret.
      destination: {
        reportedAt: iso(settings.destinationReportedAt),
        config: settings.destination,
        problem: settings.destinationProblem,
      },
      connectionTest: {
        requested: settings.connectionTestRequestedAt !== null,
        testedAt: iso(settings.connectionTestedAt),
        result: settings.connectionTest,
      },
      key: {
        state: keyState(settings),
        recipient: settings.keyRecipient,
        createdAt: iso(settings.keyCreatedAt),
        savedAt: iso(settings.keySavedAt),
      },
      status: {
        now: at.toISOString(),
        running: runView(runs.running),
        lastBackup: runView(runs.lastBackup),
        lastSuccess: runView(runs.lastSuccess),
        lastTestRestore: runView(runs.lastTestRestore),
        nextDueAt: iso(nextDue(at, schedule, timeZone)),
        overdueSince: overdue === null ? null : overdue.at.toISOString(),
        retryAt: settings.enabled ? iso(settings.retryAt) : null,
        backupRequested: settings.backupRequestedAt !== null,
        testRestoreRequested: settings.testRestoreRequestedAt !== null,
        /** When the worker last listed the folder (GET …/list). */
        listedAt: iso(settings.backupListedAt),
      },
    };
  }

  app.get("/settings/backups", { preHandler: [signedIn, owner] }, async () => view());

  app.patch<{ Body: SettingsBody }>(
    "/settings/backups",
    {
      preHandler: [fromDashboard, signedIn, owner],
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          minProperties: 1,
          properties: {
            // Not `type: "boolean"`: Fastify would turn null, 0, "" and "false" into false.
            enabled: { enum: [true, false] },
            timeOfDay: { type: "string", pattern: TIME_PATTERN },
            keepDays: { type: "integer", minimum: 1, maximum: MAX_KEEP_DAYS },
            currentPassword: PASSWORD,
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body;
      const saved = await readBackupSettings(db);
      const enabled = body.enabled ?? saved.enabled;
      const turnedOff = saved.enabled && !enabled;
      const actions: BackupAction[] = turnedOff ? ["turned_off"] : [];
      // Turning on needs a destination the worker reported; saving the time while on does not.
      if (enabled && !saved.enabled) {
        const missing = destinationMissing(saved);
        if (missing !== null) {
          return reply.code(409).send({ error: "no_destination", message: missing });
        }
      }
      if (actions.length > 0 && !(await passwordConfirmed(request, reply, body.currentPassword))) {
        return reply;
      }
      // Made before the transaction: age's key generation is asynchronous.
      const key = enabled && saved.keySealed === null ? await makeBackupKey() : null;
      const at = now();
      const scheduleChanged =
        (enabled && !saved.enabled) ||
        (body.timeOfDay !== undefined && body.timeOfDay !== saved.timeOfDay);
      const user = signedInUser(request);
      await db.transaction().execute(async (trx) => {
        const current = await readBackupSettings(trx, { lock: true });
        await trx
          .updateTable("backup_settings")
          .set({
            enabled,
            ...(body.timeOfDay === undefined ? {} : { time_of_day: body.timeOfDay }),
            ...(body.keepDays === undefined ? {} : { keep_days: body.keepDays }),
            // Off is a state the tab and the Storage page show: since when, and by whom.
            ...(turnedOff ? { disabled_at: at, disabled_by: user.name } : {}),
            ...(enabled ? { disabled_at: null, disabled_by: null } : {}),
            // Another request may have made one meanwhile: never replace a key.
            ...(key !== null && current.keySealed === null
              ? {
                  key_sealed: secrets.sealKey(key.identity),
                  key_recipient: key.recipient,
                  key_created_at: at,
                  key_saved_at: null,
                }
              : {}),
            // Times already past when backups are turned on, or the time changes, are not due.
            ...(scheduleChanged ? { schedule_from: at, last_slot: null } : {}),
            ...(enabled ? {} : { retry_at: null }),
            updated_at: at,
          })
          .execute();
        await notice(trx, request, actions);
      });
      if (key !== null) request.log.info("backup key created");
      return view();
    },
  );

  app.post(
    "/settings/backups/test-connection",
    { preHandler: [fromDashboard, signedIn, owner] },
    async (request, reply) => {
      const settings = await readBackupSettings(db);
      const missing = destinationMissing(settings);
      if (missing !== null) {
        return reply.code(409).send({ error: "no_destination", message: missing });
      }
      if (!within(limits.testConnection, "Test connection", request, reply)) return reply;
      // The worker takes it on its next tick, with its own BACKUP_S3_*.
      await db
        .updateTable("backup_settings")
        .set({ connection_test_requested_at: now() })
        .where("connection_test_requested_at", "is", null)
        .execute();
      request.log.info("backup test connection requested");
      return view();
    },
  );

  app.post(
    "/settings/backups/run",
    { preHandler: [fromDashboard, signedIn, owner] },
    async (request, reply) => {
      const settings = await readBackupSettings(db);
      if (!settings.enabled || settings.keyRecipient === null) {
        return reply.code(409).send({
          error: "backups_off",
          message: "Turn on backups and save first.",
        });
      }
      if (!within(limits.backupNow, "Back up now", request, reply)) return reply;
      await db
        .updateTable("backup_settings")
        .set({ backup_requested_at: now() })
        .where("backup_requested_at", "is", null)
        .execute();
      request.log.info("backup requested");
      return view();
    },
  );

  app.post(
    "/settings/backups/test-restore",
    { preHandler: [fromDashboard, signedIn, owner] },
    async (request, reply) => {
      const settings = await readBackupSettings(db);
      if (settings.keySealed === null) {
        return reply.code(409).send({
          error: "no_key",
          message: "Turn on backups, save, and back up first.",
        });
      }
      if (!within(limits.testRestore, "Test restore", request, reply)) return reply;
      await db
        .updateTable("backup_settings")
        .set({ test_restore_requested_at: now() })
        .where("test_restore_requested_at", "is", null)
        .execute();
      request.log.info("test restore requested");
      return view();
    },
  );

  app.get("/settings/backups/list", { preHandler: [signedIn, owner] }, async () => {
    const settings = await readBackupSettings(db);
    if (settings.backupList === null || settings.backupListedAt === null) {
      return { listedAt: null };
    }
    return { listedAt: settings.backupListedAt.toISOString(), ...settings.backupList };
  });

  /** The key, opened; or the answer that says why there is none to show. */
  async function openKey(reply: FastifyReply) {
    const settings = await readBackupSettings(db);
    if (
      settings.keySealed === null ||
      settings.keyRecipient === null ||
      settings.keyCreatedAt === null
    ) {
      void reply.code(404).send({
        error: "no_key",
        message: "Turn on backups to create a key.",
      });
      return null;
    }
    const identity = secrets.openKey(settings.keySealed);
    if (identity === null) {
      void reply.code(409).send({
        error: "key_unreadable",
        message:
          "AUTH_SECRET changed. Restore older backups with your saved key file. Create a new key to resume backups.",
      });
      return null;
    }
    return { identity, recipient: settings.keyRecipient, createdAt: settings.keyCreatedAt };
  }

  const keyBody = {
    body: {
      type: "object",
      additionalProperties: false,
      required: ["password"],
      properties: { password: PASSWORD },
    },
  } as const;

  app.post<{ Body: { password: string } }>(
    "/settings/backups/key",
    { preHandler: [fromDashboard, signedIn, owner], schema: keyBody },
    async (request, reply) => {
      const key = await openKey(reply);
      if (key === null) return reply;
      if (!(await passwordConfirmed(request, reply, request.body.password))) return reply;
      await db.transaction().execute((trx) => notice(trx, request, ["key_shown"]));
      // Logged as an action, without the key.
      request.log.info({ userId: signedInUser(request).id }, "backup key shown");
      void reply.header("cache-control", "no-store");
      return {
        key: key.identity,
        recipient: key.recipient,
        createdAt: key.createdAt.toISOString(),
      };
    },
  );

  app.post<{ Body: { password: string } }>(
    "/settings/backups/key/file",
    { preHandler: [fromDashboard, signedIn, owner], schema: keyBody },
    async (request, reply) => {
      const key = await openKey(reply);
      if (key === null) return reply;
      if (!(await passwordConfirmed(request, reply, request.body.password))) return reply;
      await db.transaction().execute((trx) => notice(trx, request, ["key_downloaded"]));
      const { name } = await readInstanceSettings(db);
      request.log.info({ userId: signedInUser(request).id }, "backup key downloaded");
      return reply
        .header("cache-control", "no-store")
        .header("content-type", "text/plain; charset=utf-8")
        .header("content-disposition", `attachment; filename="${keyFileName(name)}"`)
        .send(
          keyFileText({
            identity: key.identity,
            recipient: key.recipient,
            instanceName: name,
            createdAt: key.createdAt,
          }),
        );
    },
  );

  app.post(
    "/settings/backups/key/saved",
    { preHandler: [fromDashboard, signedIn, owner] },
    async (_request, reply) => {
      const result = await db
        .updateTable("backup_settings")
        .set({ key_saved_at: now() })
        .where("key_sealed", "is not", null)
        .executeTakeFirst();
      if (result.numUpdatedRows === 0n) {
        return reply.code(404).send({ error: "no_key", message: "No backup key yet." });
      }
      return view();
    },
  );

  app.post(
    "/settings/backups/key/replace",
    { preHandler: [fromDashboard, signedIn, owner] },
    async (request, reply) => {
      const settings = await readBackupSettings(db);
      if (keyState(settings) !== "unreadable") {
        return reply.code(409).send({
          error: "key_readable",
          message:
            "The key still works and existing backups need it. Replace it only if it can't be read.",
        });
      }
      const key = await makeBackupKey();
      // Only over the key read above: of two at once, one replaces it, and the other is refused.
      const replaced = await db
        .updateTable("backup_settings")
        .set({
          key_sealed: secrets.sealKey(key.identity),
          key_recipient: key.recipient,
          key_created_at: now(),
          key_saved_at: null,
        })
        .where("key_sealed", "=", settings.keySealed)
        .executeTakeFirst();
      if (replaced.numUpdatedRows === 0n) {
        return reply.code(409).send({
          error: "key_changed",
          message: "Another request replaced the key. Reload the page.",
        });
      }
      request.log.info("unreadable backup key replaced");
      return view();
    },
  );

  done();
};
