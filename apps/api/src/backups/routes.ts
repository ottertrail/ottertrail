import type { FastifyPluginCallback, FastifyReply, FastifyRequest } from "fastify";
import type { Kysely, Transaction } from "kysely";

import { requirePermission } from "../access/access.ts";
import { checkPassword } from "../access/members.ts";
import type { Auth } from "../auth/auth.ts";
import { requireTrustedOrigin } from "../auth/origin.ts";
import { passwordTryLimiter } from "../auth/password-tries.ts";
import { requireSession, signedInUser } from "../auth/routes.ts";
import { type RateLimit, TokenBucketLimiter } from "../collection/rate-limiter.ts";
import type { ObjectStoreConfig } from "../config.ts";
import type { Database } from "../db/schema.ts";
import { enqueueAccountEmail } from "../notifications/account-emails.ts";
import { notifyIn } from "../notifications/deliveries.ts";
import type { LinkSealer } from "../notifications/link-sealer.ts";
import { AddressNotAllowedError, refusedKind } from "../outbound/addresses.ts";
import { readInstanceSettings } from "../settings/settings.ts";
import { readWarningChannels } from "../storage/warning-state.ts";
import {
  backupClient,
  listBackups,
  type OutboundRules,
  s3ErrorText,
  testConnection,
} from "./s3.ts";
import { nextDue, overdueSlot } from "./schedule.ts";
import { type BackupSecrets, keyFileName, keyFileText, makeBackupKey } from "./secrets.ts";
import {
  ACCESS_KEY_PATTERN,
  type BackupSettings,
  BUCKET_PATTERN,
  destinationModeOf,
  destinationOf,
  type DestinationFields,
  endpointOrigin,
  MAX_ENDPOINT,
  MAX_KEEP_DAYS,
  MAX_PREFIX,
  MAX_SECRET,
  OVERLAP_PROBLEM,
  overlapsObjects,
  PREFIX_PATTERN,
  readBackupSettings,
  REGION_PATTERN,
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
      message: `You ran ${what} too often for now. Try again in ${tried.retryAfterSeconds} seconds.`,
    });
  return false;
}

/** What each guarded action did, as a notice says it after the person's name. */
export const BACKUP_ACTIONS = {
  key_shown: "showed the backup key",
  key_downloaded: "downloaded the backup key",
  destination_changed: "changed where backups go",
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
  message: "The current password is incorrect. Enter it again.",
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

const DESTINATION_FIELDS = {
  bucket: { anyOf: [{ type: "string", pattern: BUCKET_PATTERN }, { type: "null" }] },
  prefix: { type: "string", pattern: PREFIX_PATTERN, maxLength: MAX_PREFIX },
  endpoint: {
    anyOf: [{ type: "string", minLength: 1, maxLength: MAX_ENDPOINT }, { type: "null" }],
  },
  region: { anyOf: [{ type: "string", pattern: REGION_PATTERN }, { type: "null" }] },
  accessKeyId: { anyOf: [{ type: "string", pattern: ACCESS_KEY_PATTERN }, { type: "null" }] },
  secretAccessKey: { type: "string", minLength: 1, maxLength: MAX_SECRET },
} as const;

/** What the form sends; every field optional, and null clears a separate destination's field. */
interface DestinationBody {
  bucket?: string | null;
  prefix?: string;
  endpoint?: string | null;
  region?: string | null;
  accessKeyId?: string | null;
  secretAccessKey?: string;
}

interface SettingsBody extends DestinationBody {
  enabled?: boolean;
  timeOfDay?: string;
  keepDays?: number;
  /** Needed to change the destination or turn backups off. */
  currentPassword?: string;
}

const SEPARATE_ONLY = ["endpoint", "region", "accessKeyId", "secretAccessKey"] as const;

/**
 * GET    /api/settings/backups                  settings, destination, key, and status
 * PATCH  /api/settings/backups                  the settings; the first turn-on makes the key
 * POST   /api/settings/backups/test-connection  put, list, get, and delete on the folder
 * POST   /api/settings/backups/run              Back up now (the worker runs it)
 * POST   /api/settings/backups/test-restore     Test restore (the worker runs it)
 * GET    /api/settings/backups/list             the backups in the destination's folder
 * POST   /api/settings/backups/key              the backup key, to view { password } (logged)
 * POST   /api/settings/backups/key/file         the backup key as a file { password } (logged)
 * POST   /api/settings/backups/key/saved        the owner saved the key: the reminder goes
 * POST   /api/settings/backups/key/replace      a new key, only when the old can't be read
 *
 * The Backups tab of the instance's Settings, for the owner only
 * (docs/access.md): the `settings` permission. Changes check Origin;
 * bodies are checked before any database work. The destination's secret
 * is never in an answer; the key only in the two key routes, which log
 * that it was shown (not the key). Test connection, Back up now, and Test
 * restore are limited per user.
 *
 * A stolen session must not take or stop the backups quietly: showing or
 * downloading the key, changing the destination, and turning backups off
 * need the current password (from the app's one limiter for password
 * tries, auth/password-tries.ts), and each sends `backups.changed` to the
 * channels that get storage warnings, and an account email to the owner
 * when SMTP is set up.
 */
export const backupRoutes: FastifyPluginCallback<{
  db: Kysely<Database>;
  auth: Auth;
  trustedOrigins: readonly string[];
  /** The object store (OBJECT_STORE_*), and whether it is the stack's own Garage. */
  objectStore: ObjectStoreConfig | null;
  stackGarage: boolean;
  secrets: BackupSecrets;
  rules: OutboundRules;
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
    objectStore,
    stackGarage,
    secrets,
    rules,
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
  const mode = destinationModeOf(objectStore, stackGarage);
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
      request.log.info({ userId: user.id, action }, "backup settings: a guarded action");
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
        bucket: settings.bucket ?? (mode.mode === "object_store" ? mode.store.bucket : null),
        prefix: settings.prefix,
        endpoint: settings.endpoint,
        region: settings.region,
        accessKeyId: settings.accessKeyId,
        // Only whether one is saved, and whether this server can still read it: never the secret.
        secret:
          settings.secretSealed === null
            ? ("none" as const)
            : secrets.openSecret(
                  settings.secretSealed,
                  settings.endpoint ?? "",
                  settings.accessKeyId ?? "",
                ) === null
              ? ("unreadable" as const)
              : ("saved" as const),
        /** Since when, and by whom, backups are off; null while on, or never turned on. */
        disabledAt: settings.enabled ? null : iso(settings.disabledAt),
        disabledBy: settings.enabled ? null : settings.disabledBy,
      },
      destination:
        mode.mode === "object_store"
          ? {
              mode: mode.mode,
              reason: "off_site" as const,
              objectStore: { endpoint: mode.store.url, bucket: mode.store.bucket },
            }
          : { mode: mode.mode, reason: mode.reason, objectStore: null },
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
      },
    };
  }

  /** A body's destination fields over the saved ones; a 400's body when they don't fit. */
  function fieldsOf(
    saved: BackupSettings,
    body: DestinationBody,
  ): { fields: DestinationFields } | { refused: { error: string; message: string } } {
    if (mode.mode === "object_store" && SEPARATE_ONLY.some((field) => body[field] != null)) {
      return {
        refused: {
          error: "not_used",
          message:
            "This instance's backups use the object store's connection (OBJECT_STORE_URL), so they take no endpoint, region, or keys of their own. Choose a bucket and folder only.",
        },
      };
    }
    let endpoint = body.endpoint === undefined ? saved.endpoint : body.endpoint;
    if (body.endpoint !== undefined && body.endpoint !== null) {
      endpoint = endpointOrigin(body.endpoint);
      if (endpoint === null) {
        return {
          refused: {
            error: "invalid_endpoint",
            message:
              "The endpoint must be an http:// or https:// address without a path, such as https://s3.eu-central-1.amazonaws.com.",
          },
        };
      }
      const host = new URL(endpoint).hostname.replace(/^\[|\]$/g, "");
      const kind = refusedKind(host, rules.policy);
      if (kind !== null && /^[\d.:a-fA-F]+$/.test(host)) {
        return {
          refused: {
            error: "address_not_allowed",
            message: new AddressNotAllowedError(host, host, kind, "backups").message,
          },
        };
      }
    }
    const accessKeyId = body.accessKeyId === undefined ? saved.accessKeyId : body.accessKeyId;
    // The saved secret goes only with the endpoint and key it was saved for.
    const sameKey = endpoint === saved.endpoint && accessKeyId === saved.accessKeyId;
    const fields = {
      bucket: body.bucket === undefined ? saved.bucket : body.bucket,
      prefix: body.prefix ?? saved.prefix,
      endpoint,
      region: body.region === undefined ? saved.region : body.region,
      accessKeyId,
      secretAccessKey: body.secretAccessKey ?? null,
      secretSealed: sameKey ? saved.secretSealed : null,
    };
    // A separate destination in the object store's own bucket may not overlap its objects either.
    if (
      objectStore !== null &&
      mode.mode === "separate" &&
      fields.endpoint === objectStore.url &&
      fields.bucket === objectStore.bucket &&
      overlapsObjects(fields.prefix)
    ) {
      return { refused: { error: "folder_overlaps_objects", message: OVERLAP_PROBLEM } };
    }
    if (
      mode.mode === "object_store" &&
      (fields.bucket ?? mode.store.bucket) === mode.store.bucket &&
      overlapsObjects(fields.prefix)
    ) {
      return { refused: { error: "folder_overlaps_objects", message: OVERLAP_PROBLEM } };
    }
    return { fields };
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
            ...DESTINATION_FIELDS,
            currentPassword: PASSWORD,
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body;
      const saved = await readBackupSettings(db);
      const merged = fieldsOf(saved, body);
      if ("refused" in merged) return reply.code(400).send(merged.refused);
      const enabled = body.enabled ?? saved.enabled;
      const f = merged.fields;
      const destinationChanged =
        f.secretAccessKey !== null ||
        (f.bucket ?? null) !== (saved.bucket ?? null) ||
        f.prefix !== saved.prefix ||
        f.endpoint !== saved.endpoint ||
        f.region !== saved.region ||
        f.accessKeyId !== saved.accessKeyId;
      const turnedOff = saved.enabled && !enabled;
      const actions: BackupAction[] = [
        ...(destinationChanged ? (["destination_changed"] as const) : []),
        ...(turnedOff ? (["turned_off"] as const) : []),
      ];
      if (enabled) {
        const destination = destinationOf(mode, merged.fields, secrets);
        if ("problem" in destination) {
          return reply
            .code(400)
            .send({ error: "destination_incomplete", message: destination.problem });
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
        const secret = merged.fields.secretAccessKey;
        await trx
          .updateTable("backup_settings")
          .set({
            enabled,
            ...(body.timeOfDay === undefined ? {} : { time_of_day: body.timeOfDay }),
            ...(body.keepDays === undefined ? {} : { keep_days: body.keepDays }),
            bucket: merged.fields.bucket,
            prefix: merged.fields.prefix,
            endpoint: merged.fields.endpoint,
            region: merged.fields.region,
            access_key_id: merged.fields.accessKeyId,
            // A new endpoint or key without a new secret clears the old one (fieldsOf).
            secret_sealed:
              secret === null || secret === undefined
                ? merged.fields.secretSealed
                : secrets.sealSecret(
                    secret,
                    merged.fields.endpoint ?? "",
                    merged.fields.accessKeyId ?? "",
                  ),
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
      if (key !== null) request.log.info("a backup key was made");
      return view();
    },
  );

  app.post<{ Body: DestinationBody }>(
    "/settings/backups/test-connection",
    {
      preHandler: [fromDashboard, signedIn, owner],
      schema: {
        body: { type: "object", additionalProperties: false, properties: DESTINATION_FIELDS },
      },
    },
    async (request, reply) => {
      if (!within(limits.testConnection, "Test connection", request, reply)) return reply;
      const saved = await readBackupSettings(db);
      const merged = fieldsOf(saved, request.body);
      if ("refused" in merged) return reply.code(400).send(merged.refused);
      const destination = destinationOf(mode, merged.fields, secrets);
      if ("problem" in destination) {
        return reply
          .code(400)
          .send({ error: "destination_incomplete", message: destination.problem });
      }
      let client;
      try {
        client = backupClient(destination, rules);
      } catch (error) {
        return reply.code(400).send({ error: "address_not_allowed", message: s3ErrorText(error) });
      }
      try {
        const steps = await testConnection(
          client,
          destination.bucket,
          destination.prefix,
          AbortSignal.timeout(30_000),
        );
        return { ok: steps.every((step) => step.status === "ok"), steps };
      } finally {
        client.destroy();
      }
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
          message:
            "Turn backups on and save first: Back up now uses the saved destination and the backup key, which turning backups on makes.",
        });
      }
      if (!within(limits.backupNow, "Back up now", request, reply)) return reply;
      await db
        .updateTable("backup_settings")
        .set({ backup_requested_at: now() })
        .where("backup_requested_at", "is", null)
        .execute();
      request.log.info("a backup was asked for");
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
          message: "There is no backup to check yet: turn backups on, save, and back up first.",
        });
      }
      if (!within(limits.testRestore, "Test restore", request, reply)) return reply;
      await db
        .updateTable("backup_settings")
        .set({ test_restore_requested_at: now() })
        .where("test_restore_requested_at", "is", null)
        .execute();
      request.log.info("a test restore was asked for");
      return view();
    },
  );

  app.get("/settings/backups/list", { preHandler: [signedIn, owner] }, async () => {
    const settings = await readBackupSettings(db);
    const destination = destinationOf(mode, { ...settings, secretAccessKey: null }, secrets);
    if ("problem" in destination) return { ok: false as const, error: destination.problem };
    let client;
    try {
      client = backupClient(destination, rules);
    } catch (error) {
      return { ok: false as const, error: s3ErrorText(error) };
    }
    try {
      const backups = await listBackups(
        client,
        destination.bucket,
        destination.prefix,
        AbortSignal.timeout(20_000),
      );
      return {
        ok: true as const,
        bucket: destination.bucket,
        prefix: destination.prefix,
        backups: backups.map((backup) => ({
          name: backup.name,
          at: backup.at.toISOString(),
          bytes: backup.bytes,
          complete: backup.complete,
        })),
      };
    } catch (error) {
      return {
        ok: false as const,
        error: `The backups could not be listed: ${s3ErrorText(error, "list")}`,
      };
    } finally {
      client.destroy();
    }
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
        message: "There is no backup key yet: it is made when backups are first turned on.",
      });
      return null;
    }
    const identity = secrets.openKey(settings.keySealed);
    if (identity === null) {
      void reply.code(409).send({
        error: "key_unreadable",
        message:
          "The backup key can't be read: AUTH_SECRET changed since it was made. Backups made with it can be restored with the key file you saved; make a new key to back up again.",
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
      request.log.info({ userId: signedInUser(request).id }, "the backup key was shown");
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
      request.log.info({ userId: signedInUser(request).id }, "the backup key was downloaded");
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
        return reply.code(404).send({ error: "no_key", message: "There is no backup key yet." });
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
            "The backup key can still be read, so it is kept: backups in the bucket need it. A new key is made only when the old one can't be read.",
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
          message: "The key was replaced meanwhile, by another request. Reload the page to see it.",
        });
      }
      request.log.info("the unreadable backup key was replaced with a new one");
      return view();
    },
  );

  done();
};
