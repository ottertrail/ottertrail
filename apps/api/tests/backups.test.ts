import { identityToRecipient } from "age-encryption";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import { NO_DESTINATION_REPORTED } from "../src/backups/routes.ts";
import { BackupSecrets } from "../src/backups/secrets.ts";
import type { DestinationReport } from "../src/backups/settings.ts";
import {
  OWNER,
  PUBLIC_URL,
  signedInDashboard,
  signedInUser,
  TEST_AUTH_SECRET,
} from "./helpers/dashboard.ts";
import {
  createTestDatabase,
  MIGRATION_TEST_MS,
  migrateTestDatabase,
} from "./helpers/test-database.ts";

/**
 * The Backups tab's routes (backups/routes.ts; docs/access.md): the owner
 * only, Origin on changes, bodies checked first; no destination fields,
 * since where backups go is the worker's BACKUP_S3_*, and the tab shows
 * what the worker reported; turning on refused without a reported
 * destination; the backup key made once, sealed, shown and downloaded only
 * on request (both logged, without the key); Test connection asked of the
 * worker; the listing the worker stored; and the per-user limits. The
 * worker's side (its report, Test connection, the listing, and the
 * backups themselves) is in backup-run.test.ts.
 */

type Dashboard = Awaited<ReturnType<typeof signedInDashboard>>;

/** What a worker with BACKUP_S3_* set reports: never the secret. */
const REPORTED: DestinationReport = {
  endpoint: "https://s3.eu-central-1.amazonaws.com",
  region: "eu-central-1",
  bucket: "acme-backups",
  prefix: "ottertrail-backups",
  accessKeyId: "AKIAEXAMPLE",
};

/** Writes the worker's report, as backups/job.ts does. */
async function report(
  dashboard: Dashboard,
  value: { destination: DestinationReport } | { problem: string } | null,
  at = new Date(),
): Promise<void> {
  await dashboard.db
    .updateTable("backup_settings")
    .set({
      destination:
        value !== null && "destination" in value ? JSON.stringify(value.destination) : null,
      destination_problem: value !== null && "problem" in value ? value.problem : null,
      destination_reported_at: at,
    })
    .execute();
}

function call(
  dashboard: Dashboard,
  method: "GET" | "PATCH" | "POST",
  url: string,
  {
    cookie = dashboard.cookie,
    body,
    origin = true,
  }: { cookie?: string; body?: unknown; origin?: boolean } = {},
) {
  return dashboard.app.inject({
    method,
    url,
    headers: {
      cookie,
      ...(origin && method !== "GET" ? { origin: PUBLIC_URL } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
}

describe("the Backups tab's routes", () => {
  let dashboard: Dashboard;
  const log: string[] = [];

  beforeAll(async () => {
    dashboard = await signedInDashboard({
      timeZone: "Europe/Berlin",
      backups: {
        authSecret: TEST_AUTH_SECRET,
        testConnectionLimit: { capacity: 3, refillPerSecond: 0.0001 },
        backupNowLimit: { capacity: 2, refillPerSecond: 0.0001 },
      },
      logStream: { write: (line) => void log.push(line) },
      passwordTryLimit: { capacity: 100, refillPerSecond: 1 },
    });
  });
  afterAll(() => dashboard.close());

  test("only the owner reaches the routes: admins and members get 403", async () => {
    const admin = await signedInUser(dashboard, {
      name: "Ann Admin",
      email: "ann@example.com",
      role: "admin",
    });
    const member = await signedInUser(dashboard, {
      name: "Max Member",
      email: "max@example.com",
      grants: { projects: "all", areas: { errors: "manage" } },
    });
    const routes: ["GET" | "PATCH" | "POST", string, unknown?][] = [
      ["GET", "/api/settings/backups"],
      ["PATCH", "/api/settings/backups", { keepDays: 7 }],
      ["POST", "/api/settings/backups/test-connection"],
      ["POST", "/api/settings/backups/run"],
      ["POST", "/api/settings/backups/test-restore"],
      ["GET", "/api/settings/backups/list"],
      ["POST", "/api/settings/backups/key", { password: "x" }],
      ["POST", "/api/settings/backups/key/file", { password: "x" }],
      ["POST", "/api/settings/backups/key/saved"],
      ["POST", "/api/settings/backups/key/replace"],
    ];
    for (const [method, url, body] of routes) {
      for (const user of [admin, member]) {
        const response = await call(dashboard, method, url, { cookie: user.cookie, body });
        expect(response.statusCode, `${method} ${url}`).toBe(403);
        expect(response.json().error).toBe("forbidden");
      }
      const anonymous = await call(dashboard, method, url, { cookie: "", body });
      expect(anonymous.statusCode, `${method} ${url} signed out`).toBe(401);
    }
    // Nothing changed.
    expect((await call(dashboard, "GET", "/api/settings/backups")).json().settings.keepDays).toBe(
      14,
    );
  });

  test("off by default, with no destination reported and nothing listed", async () => {
    const body = (await call(dashboard, "GET", "/api/settings/backups")).json();
    expect(body.settings).toEqual({
      enabled: false,
      timeOfDay: "03:00",
      keepDays: 14,
      disabledAt: null,
      disabledBy: null,
    });
    expect(body.destination).toEqual({
      reportedAt: null,
      config: null,
      problem: null,
      stale: false,
    });
    expect(body.connectionTest).toEqual({
      requested: false,
      untaken: false,
      testedAt: null,
      result: null,
    });
    expect(body.key).toEqual({ state: "none", recipient: null, createdAt: null, savedAt: null });
    expect(body.status.nextDueAt).toBeNull();
    expect(body.status.lastBackup).toBeNull();
    expect(body.status.listedAt).toBeNull();
    const list = await call(dashboard, "GET", "/api/settings/backups/list");
    expect(list.json()).toEqual({ listedAt: null });
  });

  test("changes need the dashboard's Origin", async () => {
    const response = await call(dashboard, "PATCH", "/api/settings/backups", {
      body: { keepDays: 7 },
      origin: false,
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe("untrusted_origin");
  });

  test("bodies are checked before anything is saved", async () => {
    const refused: unknown[] = [
      {},
      { timeOfDay: "25:00" },
      { timeOfDay: "3:00" },
      { keepDays: 0 },
      { keepDays: 366 },
      { keepDays: 2.5 },
      { enabled: "true" },
      { enabled: null },
    ];
    const answers = [];
    for (const body of refused) {
      const response = await call(dashboard, "PATCH", "/api/settings/backups", { body });
      answers.push({ body, status: response.statusCode });
    }
    expect(answers).toEqual(refused.map((body) => ({ body, status: 400 })));
    const row = await dashboard.db
      .selectFrom("backup_settings")
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({ enabled: false, keep_days: 14, key_sealed: null });
  });

  test("turning on is refused until the worker reports a destination, saying what to do", async () => {
    const none = await call(dashboard, "PATCH", "/api/settings/backups", {
      body: { enabled: true },
    });
    expect(none.statusCode).toBe(409);
    expect(none.json()).toEqual({ error: "no_destination", message: NO_DESTINATION_REPORTED });

    await report(dashboard, { problem: "Set BACKUP_S3_REGION too." });
    const invalid = await call(dashboard, "PATCH", "/api/settings/backups", {
      body: { enabled: true },
    });
    expect(invalid.statusCode).toBe(409);
    expect(invalid.json().message).toBe(
      "The worker's BACKUP_S3_* variables have a problem: Set BACKUP_S3_REGION too.",
    );
    const view = (await call(dashboard, "GET", "/api/settings/backups")).json();
    expect(view.destination).toMatchObject({
      config: null,
      problem: "Set BACKUP_S3_REGION too.",
    });
    expect(view.destination.reportedAt).not.toBeNull();
    // The schedule saves while off, without a destination.
    const time = await call(dashboard, "PATCH", "/api/settings/backups", {
      body: { timeOfDay: "02:30", keepDays: 7 },
    });
    expect(time.statusCode).toBe(200);
    expect(time.json().settings).toMatchObject({ enabled: false, timeOfDay: "02:30", keepDays: 7 });
    const row = await dashboard.db
      .selectFrom("backup_settings")
      .select(["enabled", "key_sealed"])
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ enabled: false, key_sealed: null });
  });

  test("Back up now, Test restore, and Test connection wait for backups and a destination", async () => {
    await report(dashboard, null);
    const run = await call(dashboard, "POST", "/api/settings/backups/run");
    expect(run.statusCode).toBe(409);
    expect(run.json().error).toBe("backups_off");
    const restore = await call(dashboard, "POST", "/api/settings/backups/test-restore");
    expect(restore.statusCode).toBe(409);
    const connection = await call(dashboard, "POST", "/api/settings/backups/test-connection");
    expect(connection.statusCode).toBe(409);
    expect(connection.json()).toEqual({
      error: "no_destination",
      message: NO_DESTINATION_REPORTED,
    });
    const key = await call(dashboard, "POST", "/api/settings/backups/key", {
      body: { password: OWNER.password },
    });
    expect(key.statusCode).toBe(404);
  });

  test("with a reported destination, turning on makes the key once, and shows the destination", async () => {
    await report(dashboard, { destination: REPORTED });
    const saved = await call(dashboard, "PATCH", "/api/settings/backups", {
      body: { enabled: true },
    });
    // Turning on needs no password: only off does.
    expect(saved.statusCode).toBe(200);
    const body = saved.json();
    expect(body.settings).toMatchObject({ enabled: true, timeOfDay: "02:30", keepDays: 7 });
    expect(body.destination.config).toEqual(REPORTED);
    expect(body.destination.problem).toBeNull();
    expect(body.key.state).toBe("ready");
    expect(body.key.recipient).toMatch(/^age1[0-9a-z]+$/);
    expect(body.key.savedAt).toBeNull();
    expect(body.status.nextDueAt).not.toBeNull();

    // Sealed at rest: the key is not in the row.
    const row = await dashboard.db
      .selectFrom("backup_settings")
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(row.key_sealed).toMatch(/^v1\./);
    expect(JSON.stringify(row)).not.toContain("AGE-SECRET-KEY");
    // Another AUTH_SECRET can't open it.
    const other = new BackupSecrets("another-secret-of-at-least-32-characters!!");
    expect(other.openKey(row.key_sealed ?? "")).toBeNull();

    // Turning off needs the password.
    const off = await call(dashboard, "PATCH", "/api/settings/backups", {
      body: { enabled: false },
    });
    expect(off.json().error).toBe("password_required");
    const turnedOff = await call(dashboard, "PATCH", "/api/settings/backups", {
      body: { enabled: false, currentPassword: OWNER.password },
    });
    expect(turnedOff.json().settings).toMatchObject({ enabled: false, disabledBy: OWNER.name });
    expect(turnedOff.json().settings.disabledAt).not.toBeNull();
    // Off and on again: the same key.
    const again = (
      await call(dashboard, "PATCH", "/api/settings/backups", { body: { enabled: true } })
    ).json();
    expect(again.key.recipient).toBe(body.key.recipient);
    // While on, the schedule saves even if the worker now reports a problem.
    await report(dashboard, { problem: "Set BACKUP_S3_BUCKET too." });
    const time = await call(dashboard, "PATCH", "/api/settings/backups", {
      body: { timeOfDay: "03:15" },
    });
    expect(time.statusCode).toBe(200);
    await report(dashboard, { destination: REPORTED });
  });

  test("the key is shown and downloaded on request, logged without the key", async () => {
    log.length = 0;
    // Only with the current password, and only from the dashboard.
    const noPassword = await call(dashboard, "POST", "/api/settings/backups/key", { body: {} });
    expect(noPassword.statusCode).toBe(400);
    const badPassword = await call(dashboard, "POST", "/api/settings/backups/key", {
      body: { password: "not it" },
    });
    expect(badPassword.statusCode).toBe(403);
    expect(badPassword.body).not.toContain("AGE-SECRET-KEY");
    const shown = await call(dashboard, "POST", "/api/settings/backups/key", {
      body: { password: OWNER.password },
    });
    expect(shown.statusCode).toBe(200);
    expect(shown.headers["cache-control"]).toBe("no-store");
    const { key, recipient } = shown.json();
    expect(key).toMatch(/^AGE-SECRET-KEY-1[0-9A-Z]+$/);
    expect(await identityToRecipient(key)).toBe(recipient);

    const file = await call(dashboard, "POST", "/api/settings/backups/key/file", {
      body: { password: OWNER.password },
    });
    expect(file.statusCode).toBe(200);
    expect(file.headers["content-disposition"]).toBe(
      'attachment; filename="ottertrail-backup-key-ada-s-company.txt"',
    );
    expect(file.headers["content-type"]).toBe("text/plain; charset=utf-8");
    // age's identity file format: comments, then the key on a line of its own.
    expect(file.body.split("\n")).toContain(key);
    expect(file.body).toContain(`# public key: ${recipient}`);

    const lines = log.join("");
    expect(lines).toContain("backup key shown");
    expect(lines).toContain("backup key downloaded");
    expect(lines).not.toContain(key);
  });

  test("the reminder stays until the owner says the key is saved", async () => {
    const before = (await call(dashboard, "GET", "/api/settings/backups")).json();
    expect(before.key.savedAt).toBeNull();
    const saved = await call(dashboard, "POST", "/api/settings/backups/key/saved");
    expect(saved.statusCode).toBe(200);
    expect(saved.json().key.savedAt).not.toBeNull();
    // A readable key is never replaced: backups in the bucket need it.
    const replace = await call(dashboard, "POST", "/api/settings/backups/key/replace");
    expect(replace.statusCode).toBe(409);
    expect(replace.json().error).toBe("key_readable");
  });

  test("Test connection asks the worker, pending until it stores the steps", async () => {
    const asked = await call(dashboard, "POST", "/api/settings/backups/test-connection");
    expect(asked.statusCode).toBe(200);
    expect(asked.json().connectionTest).toEqual({
      requested: true,
      untaken: false,
      testedAt: null,
      result: null,
    });
    const first = await dashboard.db
      .selectFrom("backup_settings")
      .select("connection_test_requested_at")
      .executeTakeFirstOrThrow();
    expect(first.connection_test_requested_at).not.toBeNull();
    // Asked again while pending: still the one request.
    expect(
      (await call(dashboard, "POST", "/api/settings/backups/test-connection")).statusCode,
    ).toBe(200);
    const second = await dashboard.db
      .selectFrom("backup_settings")
      .select("connection_test_requested_at")
      .executeTakeFirstOrThrow();
    expect(second.connection_test_requested_at).toEqual(first.connection_test_requested_at);

    // The worker ran it (backups/job.ts): the tab shows each step.
    const steps = [
      { step: "put", status: "ok" },
      { step: "list", status: "ok" },
      { step: "get", status: "ok" },
      {
        step: "delete",
        status: "failed",
        error:
          "Access denied (AccessDenied). Give this key permission to delete objects in the backup folder.",
      },
    ];
    const testedAt = new Date("2026-11-20T10:00:00Z");
    await dashboard.db
      .updateTable("backup_settings")
      .set({
        connection_test: JSON.stringify({ ok: false, steps }),
        connection_tested_at: testedAt,
        connection_test_requested_at: null,
      })
      .execute();
    const view = (await call(dashboard, "GET", "/api/settings/backups")).json();
    expect(view.connectionTest).toEqual({
      requested: false,
      untaken: false,
      testedAt: testedAt.toISOString(),
      result: { ok: false, steps },
    });
  });

  test("a request no worker took in a few minutes is not waited for, and a new one replaces it", async () => {
    const old = new Date(Date.now() - 4 * 60_000);
    await dashboard.db
      .updateTable("backup_settings")
      .set({ connection_test_requested_at: old })
      .execute();
    const view = (await call(dashboard, "GET", "/api/settings/backups")).json();
    expect(view.connectionTest).toMatchObject({ requested: false, untaken: true });
    // The third of three allowed.
    const again = await call(dashboard, "POST", "/api/settings/backups/test-connection");
    expect(again.statusCode).toBe(200);
    expect(again.json().connectionTest).toMatchObject({ requested: true, untaken: false });
    const row = await dashboard.db
      .selectFrom("backup_settings")
      .select("connection_test_requested_at")
      .executeTakeFirstOrThrow();
    expect(row.connection_test_requested_at?.getTime()).toBeGreaterThan(old.getTime());
  });

  test("a report older than two hours is out of date", async () => {
    await report(dashboard, { destination: REPORTED }, new Date(Date.now() - 3 * 3_600_000));
    const view = (await call(dashboard, "GET", "/api/settings/backups")).json();
    expect(view.destination).toMatchObject({ config: REPORTED, stale: true });
    await report(dashboard, { destination: REPORTED });
    const fresh = (await call(dashboard, "GET", "/api/settings/backups")).json();
    expect(fresh.destination.stale).toBe(false);
  });

  test("Test connection is limited per user", async () => {
    // Three ran above, of three.
    const fourth = await call(dashboard, "POST", "/api/settings/backups/test-connection");
    expect(fourth.statusCode).toBe(429);
    expect(fourth.json().error).toBe("rate_limited");
    expect(fourth.headers["retry-after"]).toBeDefined();
  });

  test("the list is the worker's last listing, with when it was listed", async () => {
    const listedAt = new Date("2026-11-20T03:05:00Z");
    const listing = {
      ok: true,
      bucket: REPORTED.bucket,
      prefix: REPORTED.prefix,
      backups: [
        { name: "2026-11-20T020000Z", at: "2026-11-20T02:00:00.000Z", bytes: 1234, complete: true },
      ],
    };
    await dashboard.db
      .updateTable("backup_settings")
      .set({ backup_list: JSON.stringify(listing), backup_listed_at: listedAt })
      .execute();
    const list = await call(dashboard, "GET", "/api/settings/backups/list");
    expect(list.json()).toEqual({ listedAt: listedAt.toISOString(), ...listing });
    const view = (await call(dashboard, "GET", "/api/settings/backups")).json();
    expect(view.status.listedAt).toBe(listedAt.toISOString());

    const failed = {
      ok: false,
      bucket: REPORTED.bucket,
      prefix: REPORTED.prefix,
      error: "Couldn't list backups: Bucket not found (NoSuchBucket). Check the name or create it.",
    };
    await dashboard.db
      .updateTable("backup_settings")
      .set({ backup_list: JSON.stringify(failed) })
      .execute();
    expect((await call(dashboard, "GET", "/api/settings/backups/list")).json()).toEqual({
      listedAt: listedAt.toISOString(),
      ...failed,
    });
  });

  test("Back up now and Test restore ask the worker, limited per user", async () => {
    const first = await call(dashboard, "POST", "/api/settings/backups/run");
    expect(first.statusCode).toBe(200);
    expect(first.json().status.backupRequested).toBe(true);
    expect((await call(dashboard, "POST", "/api/settings/backups/run")).statusCode).toBe(200);
    expect((await call(dashboard, "POST", "/api/settings/backups/run")).statusCode).toBe(429);
    const restore = await call(dashboard, "POST", "/api/settings/backups/test-restore");
    expect(restore.statusCode).toBe(200);
    expect(restore.json().status.testRestoreRequested).toBe(true);
    const row = await dashboard.db
      .selectFrom("backup_settings")
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(row.backup_requested_at).not.toBeNull();
    expect(row.test_restore_requested_at).not.toBeNull();
  });

  test("a key AUTH_SECRET can no longer open shows as unreadable, and can be replaced", async () => {
    const other = new BackupSecrets("another-secret-of-at-least-32-characters!!");
    const before = (await call(dashboard, "GET", "/api/settings/backups")).json();
    await dashboard.db
      .updateTable("backup_settings")
      .set({ key_sealed: other.sealKey("AGE-SECRET-KEY-1NOTREAL") })
      .execute();
    const body = (await call(dashboard, "GET", "/api/settings/backups")).json();
    expect(body.key.state).toBe("unreadable");
    const shown = await call(dashboard, "POST", "/api/settings/backups/key", {
      body: { password: OWNER.password },
    });
    expect(shown.statusCode).toBe(409);
    expect(shown.json().error).toBe("key_unreadable");
    const replaced = await call(dashboard, "POST", "/api/settings/backups/key/replace");
    expect(replaced.statusCode).toBe(200);
    expect(replaced.json().key.state).toBe("ready");
    expect(replaced.json().key.recipient).not.toBe(before.key.recipient);
    expect(replaced.json().key.savedAt).toBeNull();
  });
});

describe("guarded actions", () => {
  test("each one notifies the storage-warning channels and emails the owner", async () => {
    const dashboard = await signedInDashboard({
      backups: { authSecret: TEST_AUTH_SECRET },
      notifications: { emailConfigured: true },
    });
    try {
      const channel = await dashboard.db
        .insertInto("notification_channels")
        .values({
          name: "Ops",
          kind: "webhook",
          webhook_url: "https://hooks.example/x",
          webhook_secret: "s".repeat(64),
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      await dashboard.db
        .insertInto("storage_warning_channels")
        .values({ channel_id: channel.id })
        .execute();
      await report(dashboard, { destination: REPORTED });
      // Not guarded: turning on, and the time of day.
      await call(dashboard, "PATCH", "/api/settings/backups", { body: { enabled: true } });
      await call(dashboard, "PATCH", "/api/settings/backups", { body: { timeOfDay: "04:00" } });
      await call(dashboard, "POST", "/api/settings/backups/key", {
        body: { password: OWNER.password },
      });
      await call(dashboard, "POST", "/api/settings/backups/key/file", {
        body: { password: OWNER.password },
      });
      await call(dashboard, "PATCH", "/api/settings/backups", {
        body: { enabled: false, currentPassword: OWNER.password },
      });
      // A wrong password does nothing, and tells no one.
      await call(dashboard, "POST", "/api/settings/backups/key", { body: { password: "nope" } });

      const deliveries = await dashboard.db
        .selectFrom("notification_deliveries")
        .select(["event_type", "payload"])
        .orderBy("created_at")
        .orderBy("id")
        .execute();
      expect(
        deliveries.map((d) => (d.payload as { subject: { action: string } }).subject.action),
      ).toEqual(["key_shown", "key_downloaded", "turned_off"]);
      expect(deliveries.every((d) => d.event_type === "backups.changed")).toBe(true);
      expect(deliveries[0]?.payload).toMatchObject({
        message: "Ada Owner showed the backup key.",
        url: `${PUBLIC_URL}/settings?tab=backups`,
      });
      // And the inbox, once each, for the owner (the Backups tab is theirs).
      const inbox = await dashboard.db
        .selectFrom("notifications")
        .select(["title", "permission", "link"])
        .orderBy("created_at")
        .orderBy("id")
        .execute();
      expect(inbox).toEqual(
        [
          "Ada Owner showed the backup key",
          "Ada Owner downloaded the backup key",
          "Ada Owner turned backups off",
        ].map((title) => ({ title, permission: "settings", link: "/settings?tab=backups" })),
      );
      const emails = await dashboard.db
        .selectFrom("account_emails")
        .select(["kind", "to_address", "params"])
        .where("kind", "=", "backup_changed")
        .execute();
      expect(emails.map((email) => (email.params as { action: string }).action)).toEqual([
        "showed the backup key",
        "downloaded the backup key",
        "turned backups off",
      ]);
      expect(emails.every((email) => email.to_address === OWNER.email)).toBe(true);
      // The message says what happened and what to do.
      const { accountEmailMessage } = await import("../src/notifications/account-emails.ts");
      const message = accountEmailMessage(
        {
          kind: "backup_changed",
          to: OWNER.email,
          params: { action: "turned backups off", by: "Ada Owner", at: "2026-11-20T03:00:00.000Z" },
        },
        "Acme",
      );
      expect(message.text).toContain(
        "Ada Owner turned backups off on Acme, at 2026-11-20 03:00 UTC.",
      );
      expect(message.text).toContain("change your password");
    } finally {
      await dashboard.close();
    }
  });

  test("of two key replacements at once, one wins and the other is refused", async () => {
    const dashboard = await signedInDashboard({ backups: { authSecret: TEST_AUTH_SECRET } });
    try {
      const other = new BackupSecrets("another-secret-of-at-least-32-characters!!");
      await dashboard.db
        .updateTable("backup_settings")
        .set({ key_sealed: other.sealKey("AGE-SECRET-KEY-1NOTREAL"), key_recipient: "age1notreal" })
        .execute();
      const answers = await Promise.all([
        call(dashboard, "POST", "/api/settings/backups/key/replace"),
        call(dashboard, "POST", "/api/settings/backups/key/replace"),
      ]);
      expect(answers.map((answer) => answer.statusCode).toSorted((a, b) => a - b)).toEqual([
        200, 409,
      ]);
      const winner = answers.find((answer) => answer.statusCode === 200)?.json();
      const row = await dashboard.db
        .selectFrom("backup_settings")
        .select("key_recipient")
        .executeTakeFirstOrThrow();
      expect(row.key_recipient).toBe(winner.key.recipient);
    } finally {
      await dashboard.close();
    }
  });
});

describe("migration 0020", () => {
  test(
    "drops the destination 0014 saved, and adds the worker's report, both ways",
    { timeout: MIGRATION_TEST_MS },
    async () => {
      const testDb = await createTestDatabase();
      try {
        await migrateTestDatabase(testDb, "0019_ai_model_prices");
        // A database with 0014's columns, a destination saved on the tab.
        await sql`
          update backup_settings set enabled = true, bucket = 'acme-backups',
            prefix = 'instance-1', endpoint = 'https://s3.example.com', region = 'auto',
            access_key_id = 'AKIA1', secret_sealed = 'v1.sealed', keep_days = 7
        `.execute(testDb.db);
        await migrateTestDatabase(testDb, "latest");
        const columns = await sql<{ column_name: string }>`
          select column_name from information_schema.columns
          where table_schema = ${testDb.schema} and table_name = 'backup_settings'
        `.execute(testDb.db);
        const names = columns.rows.map((row) => row.column_name);
        for (const gone of ["bucket", "prefix", "endpoint", "region", "access_key_id"]) {
          expect(names).not.toContain(gone);
        }
        expect(names).not.toContain("secret_sealed");
        for (const added of [
          "destination",
          "destination_problem",
          "destination_reported_at",
          "connection_test_requested_at",
          "connection_test",
          "connection_tested_at",
          "backup_list",
          "backup_listed_at",
        ]) {
          expect(names).toContain(added);
        }
        // The rest of the row stays.
        const row = await testDb.db
          .selectFrom("backup_settings")
          .select(["enabled", "keep_days", "destination", "destination_problem"])
          .executeTakeFirstOrThrow();
        expect(row).toEqual({
          enabled: true,
          keep_days: 7,
          destination: null,
          destination_problem: null,
        });
        // A report is a destination or a problem, never both.
        await expect(
          testDb.db
            .updateTable("backup_settings")
            .set({ destination: JSON.stringify({ bucket: "x" }), destination_problem: "x" })
            .execute(),
        ).rejects.toThrow(/backup_settings_destination_check/);
        // And back: 0014's columns, with the default folder.
        await migrateTestDatabase(testDb, "0019_ai_model_prices");
        const back = await sql<{ prefix: string; bucket: string | null }>`
          select prefix, bucket from backup_settings
        `.execute(testDb.db);
        expect(back.rows).toEqual([{ prefix: "ottertrail-backups", bucket: null }]);
        await migrateTestDatabase(testDb, "latest");
      } finally {
        await testDb.destroy();
      }
    },
  );
});
