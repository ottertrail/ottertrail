import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { identityToRecipient } from "age-encryption";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import { BackupSecrets } from "../src/backups/secrets.ts";
import { LOCAL_OBJECT_STORE } from "../src/config.ts";
import { addressPolicy, systemLookup } from "../src/outbound/addresses.ts";
import {
  OWNER,
  PUBLIC_URL,
  signedInDashboard,
  signedInUser,
  TEST_AUTH_SECRET,
} from "./helpers/dashboard.ts";
import { testName } from "./helpers/test-names.ts";

/**
 * The Backups tab's routes (backups/routes.ts; docs/access.md): the owner
 * only, Origin on changes, bodies checked first; the destination's
 * secret sealed and never returned; the backup key made once, sealed,
 * shown and downloaded only on request (both logged, without the key);
 * Test connection's steps; and the per-user limits. Backups themselves
 * are in backup-run.test.ts.
 */

type Dashboard = Awaited<ReturnType<typeof signedInDashboard>>;

/** The dev Garage as a separate destination: the off-site store's stand-in in tests. */
const GARAGE = {
  endpoint: LOCAL_OBJECT_STORE.url,
  region: LOCAL_OBJECT_STORE.region,
  bucket: LOCAL_OBJECT_STORE.bucket,
  accessKeyId: LOCAL_OBJECT_STORE.accessKeyId,
  secretAccessKey: LOCAL_OBJECT_STORE.secretAccessKey,
};

/** Loopback allowed: the dev Garage is on 127.0.0.1. Metadata services are refused regardless. */
const LOOPBACK_RULES = { policy: addressPolicy({ allowPrivate: true }), lookup: systemLookup };

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

describe("a separate destination (no object store)", () => {
  let dashboard: Dashboard;
  const log: string[] = [];
  const prefix = `test-backups/${testName()}`;

  beforeAll(async () => {
    dashboard = await signedInDashboard({
      timeZone: "Europe/Berlin",
      backups: {
        objectStore: null,
        stackGarage: false,
        authSecret: TEST_AUTH_SECRET,
        rules: LOOPBACK_RULES,
        testConnectionLimit: { capacity: 4, refillPerSecond: 0.0001 },
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
      ["POST", "/api/settings/backups/test-connection", {}],
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

  test("off by default, asking for a separate destination, with nothing saved", async () => {
    const body = (await call(dashboard, "GET", "/api/settings/backups")).json();
    expect(body.settings).toEqual({
      enabled: false,
      timeOfDay: "03:00",
      keepDays: 14,
      bucket: null,
      prefix: "ottertrail-backups",
      endpoint: null,
      region: null,
      accessKeyId: null,
      secret: "none",
      disabledAt: null,
      disabledBy: null,
    });
    expect(body.destination).toEqual({ mode: "separate", reason: "none", objectStore: null });
    expect(body.key).toEqual({ state: "none", recipient: null, createdAt: null, savedAt: null });
    expect(body.status.nextDueAt).toBeNull();
    expect(body.status.lastBackup).toBeNull();
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
    const refused: [unknown, string?][] = [
      [{}],
      [{ timeOfDay: "25:00" }],
      [{ timeOfDay: "3:00" }],
      [{ keepDays: 0 }],
      [{ keepDays: 366 }],
      [{ keepDays: 2.5 }],
      [{ enabled: "true" }],
      [{ enabled: null }],
      [{ prefix: "" }],
      [{ prefix: "/backups" }],
      [{ prefix: "backups/" }],
      [{ prefix: "a/../b" }],
      [{ prefix: "x".repeat(201) }],
      [{ bucket: "Not_A_Bucket" }],
      [{ region: "us east" }],
      [{ accessKeyId: "has space" }],
      [{ secretAccessKey: "" }],
      [{ secretAccessKey: "s".repeat(257) }],
      [{ endpoint: "ftp://storage.example.com" }, "invalid_endpoint"],
      [{ endpoint: "https://storage.example.com/bucket" }, "invalid_endpoint"],
      [{ endpoint: "https://user:pass@storage.example.com" }, "invalid_endpoint"],
      [{ endpoint: "http://169.254.169.254" }, "address_not_allowed"],
      [{ enabled: true }, "destination_incomplete"],
      [{ enabled: true, ...GARAGE, secretAccessKey: undefined }, "destination_incomplete"],
    ];
    const answers = [];
    for (const [body, error] of refused) {
      const response = await call(dashboard, "PATCH", "/api/settings/backups", { body });
      const answer: { error?: string } = response.json();
      answers.push({
        body,
        status: response.statusCode,
        error: error === undefined ? null : answer.error,
      });
    }
    expect(answers).toEqual(
      refused.map(([body, error]) => ({ body, status: 400, error: error ?? null })),
    );
    const row = await dashboard.db
      .selectFrom("backup_settings")
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({ enabled: false, keep_days: 14, endpoint: null, key_sealed: null });
  });

  test("Back up now and Test restore wait for backups to be on", async () => {
    const run = await call(dashboard, "POST", "/api/settings/backups/run");
    expect(run.statusCode).toBe(409);
    expect(run.json().error).toBe("backups_off");
    const restore = await call(dashboard, "POST", "/api/settings/backups/test-restore");
    expect(restore.statusCode).toBe(409);
    const key = await call(dashboard, "POST", "/api/settings/backups/key", {
      body: { password: OWNER.password },
    });
    expect(key.statusCode).toBe(404);
  });

  test("turning backups on saves the destination, seals the secret, and makes the key once", async () => {
    const response = await call(dashboard, "PATCH", "/api/settings/backups", {
      body: { enabled: true, timeOfDay: "02:30", keepDays: 7, prefix, ...GARAGE },
    });
    // A new destination needs the current password.
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("password_required");
    const wrong = await call(dashboard, "PATCH", "/api/settings/backups", {
      body: { enabled: true, prefix, ...GARAGE, currentPassword: "not it" },
    });
    expect(wrong.statusCode).toBe(403);
    expect(wrong.json().error).toBe("wrong_password");
    const saved = await call(dashboard, "PATCH", "/api/settings/backups", {
      body: {
        enabled: true,
        timeOfDay: "02:30",
        keepDays: 7,
        prefix,
        ...GARAGE,
        currentPassword: OWNER.password,
      },
    });
    expect(saved.statusCode).toBe(200);
    const response2 = saved;
    const text = response2.body;
    const body = response2.json();
    // The secret is never in an answer: only that one is saved.
    expect(text).not.toContain(GARAGE.secretAccessKey);
    expect(body.settings).toMatchObject({
      enabled: true,
      timeOfDay: "02:30",
      keepDays: 7,
      prefix,
      endpoint: GARAGE.endpoint,
      bucket: GARAGE.bucket,
      accessKeyId: GARAGE.accessKeyId,
      secret: "saved",
    });
    expect(body.key.state).toBe("ready");
    expect(body.key.recipient).toMatch(/^age1[0-9a-z]+$/);
    expect(body.key.savedAt).toBeNull();
    expect(body.status.nextDueAt).not.toBeNull();

    // Sealed at rest: neither the secret nor the key is in the row.
    const row = await dashboard.db
      .selectFrom("backup_settings")
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(row.secret_sealed).toMatch(/^v1\./);
    expect(row.secret_sealed).not.toContain(GARAGE.secretAccessKey);
    expect(row.key_sealed).toMatch(/^v1\./);
    expect(JSON.stringify(row)).not.toContain("AGE-SECRET-KEY");
    const secrets = new BackupSecrets(TEST_AUTH_SECRET);
    expect(secrets.openSecret(row.secret_sealed ?? "", GARAGE.endpoint, GARAGE.accessKeyId)).toBe(
      GARAGE.secretAccessKey,
    );
    // Sealed for this endpoint and key only.
    expect(
      secrets.openSecret(row.secret_sealed ?? "", "https://evil.example", GARAGE.accessKeyId),
    ).toBeNull();
    expect(secrets.openSecret(row.secret_sealed ?? "", GARAGE.endpoint, "AKIAOTHER")).toBeNull();
    // Another AUTH_SECRET opens neither.
    const other = new BackupSecrets("another-secret-of-at-least-32-characters!!");
    expect(
      other.openSecret(row.secret_sealed ?? "", GARAGE.endpoint, GARAGE.accessKeyId),
    ).toBeNull();
    expect(other.openKey(row.key_sealed ?? "")).toBeNull();

    // Off and on again: the same key.
    // Turning off needs the password too.
    const off = await call(dashboard, "PATCH", "/api/settings/backups", {
      body: { enabled: false },
    });
    expect(off.json().error).toBe("password_required");
    const turnedOff = await call(dashboard, "PATCH", "/api/settings/backups", {
      body: { enabled: false, currentPassword: OWNER.password },
    });
    expect(turnedOff.json().settings).toMatchObject({ enabled: false, disabledBy: OWNER.name });
    expect(turnedOff.json().settings.disabledAt).not.toBeNull();
    const again = (
      await call(dashboard, "PATCH", "/api/settings/backups", { body: { enabled: true } })
    ).json();
    expect(again.key.recipient).toBe(body.key.recipient);
    // A save without a secret keeps the saved one.
    expect(again.settings.secret).toBe("saved");
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
    expect(lines).not.toContain(GARAGE.secretAccessKey);
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

  test("Test connection puts, lists, reads, and deletes on the folder", async () => {
    const response = await call(dashboard, "POST", "/api/settings/backups/test-connection", {
      body: { prefix: `${prefix}/connection` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      steps: [
        { step: "put", status: "ok" },
        { step: "list", status: "ok" },
        { step: "get", status: "ok" },
        { step: "delete", status: "ok" },
      ],
    });
  });

  test("Test connection says which step failed, in plain words", async () => {
    const wrong = await call(dashboard, "POST", "/api/settings/backups/test-connection", {
      body: { secretAccessKey: "not-the-secret" },
    });
    expect(wrong.statusCode).toBe(200);
    const body = wrong.json();
    expect(body.ok).toBe(false);
    expect(body.steps[0].status).toBe("failed");
    expect(body.steps[0].error).toMatch(
      /Secret access key mismatch|Unknown access key|Access denied/i,
    );
    expect(body.steps.slice(1).map((step: { status: string }) => step.status)).toEqual([
      "skipped",
      "skipped",
      "skipped",
    ]);
  });

  test("Test connection reports a refused permission on the step it refused", async () => {
    const s3 = await startRefusingS3("DELETE");
    try {
      const response = await call(dashboard, "POST", "/api/settings/backups/test-connection", {
        body: {
          endpoint: s3.url,
          region: "auto",
          bucket: "backups",
          accessKeyId: "AKIA1",
          secretAccessKey: "secret-for-the-stand-in",
        },
      });
      const body = response.json();
      expect(body.ok).toBe(false);
      expect(body.steps.map((step: { status: string }) => step.status)).toEqual([
        "ok",
        "ok",
        "ok",
        "failed",
      ]);
      expect(body.steps[3].error).toBe(
        "Access denied (AccessDenied). Give this key permission to delete objects in the backup folder.",
      );
    } finally {
      await s3.close();
    }
  });

  test("Test connection is limited per user", async () => {
    // Three ran above, of four.
    const fourth = await call(dashboard, "POST", "/api/settings/backups/test-connection", {
      body: { prefix: `${prefix}/connection` },
    });
    expect(fourth.statusCode).toBe(200);
    const fifth = await call(dashboard, "POST", "/api/settings/backups/test-connection", {
      body: { prefix: `${prefix}/connection` },
    });
    expect(fifth.statusCode).toBe(429);
    expect(fifth.json().error).toBe("rate_limited");
    expect(fifth.headers["retry-after"]).toBeDefined();
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
      .set({
        key_sealed: other.sealKey("AGE-SECRET-KEY-1NOTREAL"),
        secret_sealed: other.sealSecret("x", GARAGE.endpoint, GARAGE.accessKeyId),
      })
      .execute();
    const body = (await call(dashboard, "GET", "/api/settings/backups")).json();
    expect(body.key.state).toBe("unreadable");
    expect(body.settings.secret).toBe("unreadable");
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
  test("a new endpoint or access key drops the saved secret: it is never sent elsewhere", async () => {
    const dashboard = await signedInDashboard({
      backups: {
        objectStore: null,
        stackGarage: false,
        authSecret: TEST_AUTH_SECRET,
        rules: LOOPBACK_RULES,
      },
    });
    try {
      const prefix = `test-backups/${testName()}`;
      const saved = await call(dashboard, "PATCH", "/api/settings/backups", {
        body: { enabled: true, prefix, ...GARAGE, currentPassword: OWNER.password },
      });
      expect(saved.statusCode).toBe(200);
      // Test connection to another endpoint, without a secret: the saved one is not used.
      const elsewhere = await call(dashboard, "POST", "/api/settings/backups/test-connection", {
        body: { endpoint: "https://elsewhere.example" },
      });
      expect(elsewhere.statusCode).toBe(400);
      expect(elsewhere.json().message).toMatch(/^Enter the destination's secret access key/);
      // Saving another access key without a secret clears the saved one.
      const otherKey = await call(dashboard, "PATCH", "/api/settings/backups", {
        body: { enabled: false, accessKeyId: "AKIAOTHER", currentPassword: OWNER.password },
      });
      expect(otherKey.statusCode).toBe(200);
      expect(otherKey.json().settings.secret).toBe("none");
      const row = await dashboard.db
        .selectFrom("backup_settings")
        .select("secret_sealed")
        .executeTakeFirstOrThrow();
      expect(row.secret_sealed).toBeNull();
    } finally {
      await dashboard.close();
    }
  });

  test("each one notifies the storage-warning channels and emails the owner", async () => {
    const dashboard = await signedInDashboard({
      backups: {
        objectStore: null,
        stackGarage: false,
        authSecret: TEST_AUTH_SECRET,
        rules: LOOPBACK_RULES,
      },
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
      const prefix = `test-backups/${testName()}`;
      await call(dashboard, "PATCH", "/api/settings/backups", {
        body: { enabled: true, prefix, ...GARAGE, currentPassword: OWNER.password },
      });
      // Not guarded: the time of day alone.
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
      ).toEqual(["destination_changed", "key_shown", "key_downloaded", "turned_off"]);
      expect(deliveries.every((d) => d.event_type === "backups.changed")).toBe(true);
      expect(deliveries[0]?.payload).toMatchObject({
        message: "Ada Owner changed where backups go.",
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
          "Ada Owner changed where backups go",
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
        "changed where backups go",
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
    const dashboard = await signedInDashboard({
      backups: {
        objectStore: null,
        stackGarage: false,
        authSecret: TEST_AUTH_SECRET,
        rules: LOOPBACK_RULES,
      },
    });
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

describe("the destination follows the object store", () => {
  test("an off-site object store's connection is reused: a bucket and folder only", async () => {
    const store = {
      url: "https://account.r2.cloudflarestorage.com",
      region: "auto",
      bucket: "ottertrail-files",
      accessKeyId: "AKIAEXAMPLE",
      secretAccessKey: "not-a-real-secret",
    };
    const dashboard = await signedInDashboard({
      backups: { objectStore: store, stackGarage: false, authSecret: TEST_AUTH_SECRET },
    });
    try {
      const body = (await call(dashboard, "GET", "/api/settings/backups")).json();
      expect(body.destination).toEqual({
        mode: "object_store",
        reason: "off_site",
        objectStore: { endpoint: store.url, bucket: store.bucket },
      });
      // The store's own bucket by default, under a folder of its own.
      expect(body.settings.bucket).toBe(store.bucket);
      expect(JSON.stringify(body)).not.toContain(store.secretAccessKey);
      const refused = await call(dashboard, "PATCH", "/api/settings/backups", {
        body: { enabled: true, endpoint: "https://s3.example.com", accessKeyId: "x" },
      });
      expect(refused.statusCode).toBe(400);
      expect(refused.json().error).toBe("not_used");
      const saved = await call(dashboard, "PATCH", "/api/settings/backups", {
        body: {
          enabled: true,
          bucket: "ottertrail-backups",
          prefix: "instance-1",
          currentPassword: OWNER.password,
        },
      });
      expect(saved.statusCode).toBe(200);
      expect(saved.json().settings).toMatchObject({
        bucket: "ottertrail-backups",
        prefix: "instance-1",
      });
    } finally {
      await dashboard.close();
    }
  });

  test("a folder overlapping the store's replays or source maps, in its bucket, is refused", async () => {
    const store = {
      url: "https://account.r2.cloudflarestorage.com",
      region: "auto",
      bucket: "ottertrail-files",
      accessKeyId: "AKIAEXAMPLE",
      secretAccessKey: "not-a-real-secret",
    };
    const dashboard = await signedInDashboard({
      backups: { objectStore: store, stackGarage: false, authSecret: TEST_AUTH_SECRET },
    });
    try {
      for (const prefix of [
        "replays",
        "replays/backups",
        "source-maps",
        "source-maps/x/y",
        "avatars",
        "avatars/backups",
      ]) {
        const refused = await call(dashboard, "PATCH", "/api/settings/backups", {
          body: { prefix, currentPassword: OWNER.password },
        });
        expect([prefix, refused.statusCode, refused.json().error]).toEqual([
          prefix,
          400,
          "folder_overlaps_objects",
        ]);
      }
      // Another bucket, or a folder of its own, is fine.
      for (const body of [
        { bucket: "other-bucket", prefix: "replays" },
        { bucket: store.bucket, prefix: "replays-backups" },
      ]) {
        const fine = await call(dashboard, "PATCH", "/api/settings/backups", {
          body: { ...body, currentPassword: OWNER.password },
        });
        expect(fine.statusCode).toBe(200);
      }
    } finally {
      await dashboard.close();
    }
  });

  test("a host name that resolves to loopback or a metadata address is refused on connection", async () => {
    // The real rules (private addresses refused), with names resolved by a stand-in resolver.
    const names: Record<string, string> = {
      "internal.example": "127.0.0.1",
      "metadata.example": "169.254.169.254",
    };
    const dashboard = await signedInDashboard({
      backups: {
        objectStore: null,
        stackGarage: false,
        authSecret: TEST_AUTH_SECRET,
        rules: {
          policy: addressPolicy({ allowPrivate: false }),
          lookup: async (host) => [{ address: names[host] ?? "203.0.113.9", family: 4 }],
        },
      },
    });
    try {
      for (const host of Object.keys(names)) {
        const response = await call(dashboard, "POST", "/api/settings/backups/test-connection", {
          body: {
            endpoint: `http://${host}:3900`,
            region: "auto",
            bucket: "backups",
            prefix: "x",
            accessKeyId: "AKIA1",
            secretAccessKey: "secret-for-the-test",
          },
        });
        expect(response.statusCode).toBe(200);
        const [put] = response.json().steps;
        expect(put).toEqual({
          step: "put",
          status: "failed",
          error: `${host} resolves to an address backups may not reach.`,
        });
      }
    } finally {
      await dashboard.close();
    }
  });

  test("the stack's own Garage is the same disk: a separate destination, saying why", async () => {
    const dashboard = await signedInDashboard({
      backups: { objectStore: LOCAL_OBJECT_STORE, stackGarage: true, authSecret: TEST_AUTH_SECRET },
    });
    try {
      const body = (await call(dashboard, "GET", "/api/settings/backups")).json();
      expect(body.destination).toEqual({
        mode: "separate",
        reason: "stack_garage",
        objectStore: null,
      });
    } finally {
      await dashboard.close();
    }
  });
});

/**
 * A stand-in S3 endpoint that answers PutObject, ListObjectsV2, and
 * GetObject, and refuses `refuse` (a method) with AccessDenied, as S3 does
 * for a key without that permission.
 */
async function startRefusingS3(
  refuse: string,
): Promise<{ url: string; close: () => Promise<void> }> {
  const objects = new Map<string, Buffer>();
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const url = new URL(request.url ?? "/", "http://s3");
      if (request.method === refuse) {
        response.writeHead(403, { "content-type": "application/xml" });
        response.end(
          '<?xml version="1.0" encoding="UTF-8"?><Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>',
        );
        return;
      }
      const [, bucket = "", ...rest] = url.pathname.split("/");
      const key = decodeURIComponent(rest.join("/"));
      if (request.method === "PUT") {
        objects.set(key, Buffer.concat(chunks));
        response.writeHead(200, { etag: '"etag"' });
        response.end();
      } else if (request.method === "GET" && key === "") {
        const prefix = url.searchParams.get("prefix") ?? "";
        const contents = [...objects.keys()]
          .filter((name) => name.startsWith(prefix))
          .map(
            (name) =>
              `<Contents><Key>${name}</Key><Size>${objects.get(name)?.length ?? 0}</Size></Contents>`,
          )
          .join("");
        response.writeHead(200, { "content-type": "application/xml" });
        response.end(
          `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>${bucket}</Name><Prefix>${prefix}</Prefix><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`,
        );
      } else if (request.method === "GET") {
        const body = objects.get(key);
        if (body === undefined) {
          response.writeHead(404, { "content-type": "application/xml" });
          response.end("<Error><Code>NoSuchKey</Code><Message>No such key</Message></Error>");
        } else {
          response.writeHead(200, { "content-length": body.length, "content-type": "text/plain" });
          response.end(body);
        }
      } else if (request.method === "DELETE") {
        objects.delete(key);
        response.writeHead(204);
        response.end();
      } else {
        response.writeHead(405);
        response.end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
