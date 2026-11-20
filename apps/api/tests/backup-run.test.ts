import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import { decrypted } from "../src/backups/archive.ts";
import { BackupJob, RETRY_AFTER_MS } from "../src/backups/job.ts";
import {
  applyRetention,
  BackupError,
  type BackupSources,
  manifestSchema,
  runBackup,
  testRestore,
} from "../src/backups/run.ts";
import { backupClient, listBackups } from "../src/backups/s3.ts";
import { BackupSecrets, makeBackupKey } from "../src/backups/secrets.ts";
import type { Destination } from "../src/backups/settings.ts";
import { clickHouseDataBytes } from "../src/backups/sources.ts";
import { identifier } from "../src/clickhouse/clickhouse.ts";
import { LOCAL_OBJECT_STORE } from "../src/config.ts";
import { addressPolicy, systemLookup } from "../src/outbound/addresses.ts";
import { checkObjectBackup } from "../src/storage/object-backup.ts";
import { s3Client, s3ObjectStore } from "../src/storage/object-store.ts";
import { storageSourcesOf } from "../src/storage/usage.ts";
import { StorageWarningJob } from "../src/storage/warning-job.ts";
import { OTTERTRAIL_VERSION } from "../src/version.ts";
import {
  clickHouseFileExists,
  containerClickHouseFiles,
  containerPgDump,
  type DevContainers,
  requireDevContainers,
} from "./helpers/containers.ts";
import { signedInDashboard, TEST_AUTH_SECRET } from "./helpers/dashboard.ts";
import { insertProject } from "./helpers/projects.ts";
import { testName } from "./helpers/test-names.ts";

/**
 * Scheduled backups end to end (backups/run.ts, job.ts): a whole backup of
 * a test's own PostgreSQL schema, ClickHouse database, and objects, to the
 * development Garage, which stands in for an off-site S3 destination;
 * decrypting it with the key and checking its checksums; restoring it into
 * fresh databases, as restore.sh does; Test restore catching a damaged
 * part; retention; the free-space check; and the worker's schedule,
 * retry, and alert.
 */

type Dashboard = Awaited<ReturnType<typeof signedInDashboard>>;

const GiB = 1024 ** 3;
const RULES = { policy: addressPolicy({ allowPrivate: true }), lookup: systemLookup };
const run = testName();

let dashboard: Dashboard;
let containers: DevContainers;
let key: { identity: string; recipient: string };
let projectId: string;
const objectPrefix = `${run}-objects/`;
const store = s3ObjectStore(LOCAL_OBJECT_STORE);
const s3 = s3Client(LOCAL_OBJECT_STORE);

function destination(prefix: string): Destination {
  return {
    url: LOCAL_OBJECT_STORE.url,
    region: LOCAL_OBJECT_STORE.region,
    bucket: LOCAL_OBJECT_STORE.bucket,
    prefix,
    accessKeyId: LOCAL_OBJECT_STORE.accessKeyId,
    secretAccessKey: LOCAL_OBJECT_STORE.secretAccessKey,
    fromDashboard: true,
    objectStoreBucket: null,
  };
}

/** What the test's backups read: its own schema, database, and objects. */
function sources(disk = { totalBytes: 100 * GiB, freeBytes: 60 * GiB }): BackupSources {
  return {
    dumpPostgres: () => containerPgDump(containers, testSchema),
    clickhouse: dashboard.reader.client,
    clickhouseDatabase: dashboard.clickhouseDatabase,
    clickhouseFiles: containerClickHouseFiles(containers),
    objectStore: LOCAL_OBJECT_STORE,
    objectPrefix,
    readDisk: async () => disk,
    clickhouseBytes: () => clickHouseDataBytes(dashboard.reader.client),
  };
}

let testSchema = "";

async function getBytes(keyName: string): Promise<Buffer> {
  const response = await s3.send(
    new GetObjectCommand({ Bucket: LOCAL_OBJECT_STORE.bucket, Key: keyName }),
  );
  if (response.Body === undefined) throw new Error(`${keyName} has no body`);
  return Buffer.from(await response.Body.transformToByteArray());
}

/** Puts a one-byte object, "x". */
const put = (keyName: string) =>
  s3.send(new PutObjectCommand({ Bucket: LOCAL_OBJECT_STORE.bucket, Key: keyName, Body: "x" }));

/** The test's backups, oldest first. */
const runs = () =>
  dashboard.db
    .selectFrom("backup_runs")
    .select(["trigger", "status", "started_at", "error", "folder"])
    .where("kind", "=", "backup")
    .orderBy("started_at")
    .execute();

/** An age file's plain bytes, decrypted with `identity`. */
async function decryptAll(sealed: Buffer, identity: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const source = (async function* () {
    yield sealed;
  })();
  for await (const chunk of await decrypted(source, identity)) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

beforeAll(async () => {
  containers = requireDevContainers();
  dashboard = await signedInDashboard({ timeZone: "Europe/Berlin" });
  const { rows } = await sql<{ schema: string }>`select current_schema() as schema`.execute(
    dashboard.db,
  );
  testSchema = rows[0]?.schema ?? "";
  key = await makeBackupKey();
  projectId = (await insertProject(dashboard.db, { name: "Backed-up shop" })).id;
  await dashboard.store(
    projectId,
    Array.from({ length: 25 }, (_, index) => ({
      eventId: randomUUID(),
      name: "pageview",
      occurredAt: new Date(Date.now() - index * 60_000),
      path: `/page/${index}`,
    })),
  );
  await store.put(
    `${objectPrefix}maps/app.js.map`,
    Buffer.from('{"version":3}'),
    "application/json",
  );
  await store.put(
    `${objectPrefix}replays/one`,
    Buffer.alloc(70_000, 7),
    "application/octet-stream",
  );
  await store.put(`${objectPrefix}empty`, new Uint8Array(), "text/plain");
}, 60_000);

afterAll(async () => {
  await store.deletePrefix(objectPrefix);
  await store.deletePrefix(`test-backups/${run}/`);
  store.close();
  s3.destroy();
  await dashboard?.close();
});

describe("a whole backup to an S3 destination", () => {
  const prefix = `test-backups/${run}/whole`;
  let name = "";

  test("uploads the three parts and the manifest, each encrypted, and leaves no local file", async () => {
    const client = backupClient(destination(prefix), RULES);
    const steps: string[] = [];
    try {
      const result = await runBackup({
        sources: sources(),
        destination: destination(prefix),
        client,
        recipient: key.recipient,
        version: OTTERTRAIL_VERSION,
        onStep: (step) => void steps.push(step),
      });
      name = result.name;
      expect(steps).toEqual([
        "checking free disk space",
        "dumping PostgreSQL",
        "backing up ClickHouse",
        "backing up the object store",
        "writing the manifest",
      ]);
      const listed = await listBackups(client, LOCAL_OBJECT_STORE.bucket, prefix);
      expect(listed).toHaveLength(1);
      expect(listed[0]?.name).toBe(name);
      expect(listed[0]?.complete).toBe(true);
      expect(listed[0]?.files.toSorted()).toEqual([
        "clickhouse.zip.age",
        "manifest.json",
        "objects.tar.age",
        "postgres.dump.age",
      ]);
      expect(listed[0]?.bytes).toBe(result.bytes);
    } finally {
      client.destroy();
    }
    expect(clickHouseFileExists(containers, `ottertrail-worker-${name}.zip`)).toBe(false);
  }, 120_000);

  test("the manifest names the version, the key, and each part's sizes and SHA-256", async () => {
    const manifest = manifestSchema.parse(
      JSON.parse((await getBytes(`${prefix}/${name}/manifest.json`)).toString("utf8")),
    );
    expect(manifest).toMatchObject({
      format: "ottertrail-backup",
      version: 1,
      name,
      instance: { version: OTTERTRAIL_VERSION },
      encryption: { format: "age", recipient: key.recipient },
      clickhouseDatabase: dashboard.clickhouseDatabase,
      objects: { bucket: LOCAL_OBJECT_STORE.bucket, count: 3, gone: 0 },
    });
    expect(manifest.parts.map((part) => part.name)).toEqual(["postgres", "clickhouse", "objects"]);
    for (const part of manifest.parts) {
      const sealed = await getBytes(`${prefix}/${name}/${part.file}`);
      expect(sealed.length).toBe(part.encrypted.bytes);
      expect(sha256(sealed)).toBe(part.encrypted.sha256);
      // An age file, which the key decrypts: back to the plain bytes the manifest describes.
      expect(sealed.subarray(0, 21).toString("ascii")).toBe("age-encryption.org/v1");
      const plain = await decryptAll(sealed, key.identity);
      expect(plain.length).toBe(part.plain.bytes);
      expect(sha256(plain)).toBe(part.plain.sha256);
      expect(plain.equals(sealed)).toBe(false);
    }
  });

  test("restores into fresh databases, as restore.sh does, and its objects check out", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ottertrail-backup-restore-"));
    const database = `zz_restore_${run}`.toLowerCase();
    const restoredClickHouse = `${dashboard.clickhouseDatabase}_restored`;
    try {
      for (const file of ["postgres.dump", "clickhouse.zip", "objects.tar"]) {
        const sealed = await getBytes(`${prefix}/${name}/${file}.age`);
        const plain = await decryptAll(sealed, key.identity);
        await writeFile(join(dir, file), plain);
      }
      // PostgreSQL: pg_restore into a new database, then read the project back.
      execFileSync(containers.cli, [
        "exec",
        containers.postgres,
        "createdb",
        "-U",
        "ottertrail",
        database,
      ]);
      try {
        const restored = spawnSync(
          containers.cli,
          [
            "exec",
            "-i",
            containers.postgres,
            "pg_restore",
            "-U",
            "ottertrail",
            "-d",
            database,
            "--no-owner",
            "--single-transaction",
            "--exit-on-error",
          ],
          { input: await readFile(join(dir, "postgres.dump")) },
        );
        expect({ status: restored.status, stderr: restored.stderr.toString() }).toEqual({
          status: 0,
          stderr: expect.any(String),
        });
        const names = execFileSync(
          containers.cli,
          [
            "exec",
            containers.postgres,
            "psql",
            "-U",
            "ottertrail",
            "-d",
            database,
            "-Atc",
            `select name from ${testSchema}.projects`,
          ],
          { encoding: "utf8" },
        );
        expect(names.trim()).toBe("Backed-up shop");
      } finally {
        execFileSync(containers.cli, [
          "exec",
          containers.postgres,
          "dropdb",
          "-U",
          "ottertrail",
          database,
        ]);
      }

      // ClickHouse: its own RESTORE from the zip in its backups folder, into a new database.
      const zip = `restore-${run}.zip`.replaceAll("_", "-");
      spawnSync(
        containers.cli,
        [
          "exec",
          "-i",
          containers.clickhouse,
          "sh",
          "-c",
          `cat > /var/lib/clickhouse/backups/${zip}`,
        ],
        { input: await readFile(join(dir, "clickhouse.zip")) },
      );
      try {
        await dashboard.reader.client.command({
          query: `RESTORE DATABASE ${identifier(dashboard.clickhouseDatabase)} AS ${identifier(restoredClickHouse)} FROM File('${zip}')`,
        });
        const result = await dashboard.reader.client.query({
          query: `SELECT count() AS n FROM ${identifier(restoredClickHouse)}.events FINAL WHERE project_id = {id:UUID}`,
          query_params: { id: projectId },
          format: "JSONEachRow",
        });
        expect(await result.json()).toEqual([{ n: "25" }]);
      } finally {
        await dashboard.reader.client.command({
          query: `DROP DATABASE IF EXISTS ${identifier(restoredClickHouse)}`,
        });
        execFileSync(containers.cli, [
          "exec",
          containers.clickhouse,
          "rm",
          "-f",
          `/var/lib/clickhouse/backups/${zip}`,
        ]);
      }

      // The objects: the tar backup.sh makes, which restore-objects checks file by file.
      const objects = join(dir, "objects");
      execFileSync("mkdir", [objects]);
      execFileSync("tar", ["-xf", join(dir, "objects.tar"), "-C", objects]);
      const { manifest, checked } = await checkObjectBackup(LOCAL_OBJECT_STORE, objects);
      expect(manifest.bucket).toBe(LOCAL_OBJECT_STORE.bucket);
      expect(checked.map((entry) => entry.key).toSorted()).toEqual([
        `${objectPrefix}empty`,
        `${objectPrefix}maps/app.js.map`,
        `${objectPrefix}replays/one`,
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 120_000);

  test("restore.sh --from-s3 lists, downloads, decrypts, checks, and restores it", async () => {
    const folder = await mkdtemp(join(tmpdir(), "ottertrail-restore-sh-"));
    try {
      await copyFile(join(DEPLOY, "restore.sh"), join(folder, "restore.sh"));
      const keyFile = join(folder, "ottertrail-backup-key.txt");
      await writeFile(keyFile, `# a test key\n${key.identity}\n`);
      const log = join(folder, "compose.log");
      // Stands in for `docker compose`: runs the image's scripts from source,
      // with the bind mounts mapped to this folder, and hashes what the
      // database restores would read. The databases themselves are restored
      // in the test above.
      const fake = join(folder, "fake-compose.mjs");
      await writeFile(fake, fakeCompose(log));
      const manifest = manifestSchema.parse(
        JSON.parse((await getBytes(`${prefix}/${name}/manifest.json`)).toString("utf8")),
      );
      const plainOf = (part: string) =>
        manifest.parts.find((entry) => entry.name === part)?.plain.sha256;

      const result = spawnSync("sh", [join(folder, "restore.sh"), "--from-s3", "--key", keyFile], {
        encoding: "utf8",
        input: "",
        env: {
          ...process.env,
          COMPOSE: `${process.execPath} ${fake}`,
          BACKUP_S3_ENDPOINT: LOCAL_OBJECT_STORE.url,
          BACKUP_S3_REGION: LOCAL_OBJECT_STORE.region,
          BACKUP_S3_BUCKET: LOCAL_OBJECT_STORE.bucket,
          BACKUP_S3_PREFIX: prefix,
          BACKUP_S3_ACCESS_KEY_ID: LOCAL_OBJECT_STORE.accessKeyId,
          BACKUP_S3_SECRET_ACCESS_KEY: LOCAL_OBJECT_STORE.secretAccessKey,
        },
      });
      expect({ status: result.status, failed: /failed/i.test(result.stderr) }).toEqual({
        status: 0,
        failed: false,
      });
      expect(result.stdout).toContain(
        `Backups in ${LOCAL_OBJECT_STORE.bucket}/${prefix}, newest first:`,
      );
      expect(result.stdout).toMatch(new RegExp(`^${name} .* whole$`, "m"));
      expect(result.stderr).toContain(`Downloaded ${name}`);
      expect(result.stdout).toContain(
        `Restored ottertrail-${name} from ${LOCAL_OBJECT_STORE.bucket}/${prefix}, and deleted the downloaded files.`,
      );
      const calls = (await readFile(log, "utf8")).split("\n");
      // PostgreSQL and ClickHouse got the decrypted dump and zip; the objects were checked, then restored.
      expect(calls).toContain(`stdin pg_restore ${plainOf("postgres")}`);
      expect(calls).toContain(`stdin clickhouse ${plainOf("clickhouse")}`);
      const objectRuns = calls.filter((line) => line.startsWith("run dist/restore-objects.mjs"));
      expect(objectRuns).toHaveLength(2);
      expect(objectRuns[0]).toMatch(/--check/);
      // The secret never went on a command line.
      expect(calls.join("\n")).not.toContain(LOCAL_OBJECT_STORE.secretAccessKey);
      // The plain copies are gone; the backup stays in the bucket.
      expect(await readdir(join(folder, "backups"))).toEqual([]);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  }, 120_000);

  test("Test restore checks every checksum, and catches a damaged part", async () => {
    const client = backupClient(destination(prefix), RULES);
    try {
      const checked = await testRestore({
        client,
        destination: destination(prefix),
        identity: key.identity,
      });
      expect(checked).toMatchObject({ name, objects: 3 });
      expect(checked.parts.map((part) => part.name)).toEqual(["postgres", "clickhouse", "objects"]);

      // Another key cannot read it.
      const other = await makeBackupKey();
      await expect(
        testRestore({ client, destination: destination(prefix), identity: other.identity }),
      ).rejects.toThrow(/can't be decrypted with this instance's backup key/);

      // One byte changed in the middle of ClickHouse's part, the size the same.
      const partKey = `${prefix}/${name}/clickhouse.zip.age`;
      const sealed = await getBytes(partKey);
      const damaged = Buffer.from(sealed);
      const at = Math.floor(damaged.length / 2);
      damaged[at] = (damaged[at] ?? 0) ^ 0xff;
      await s3.send(
        new PutObjectCommand({ Bucket: LOCAL_OBJECT_STORE.bucket, Key: partKey, Body: damaged }),
      );
      await expect(
        testRestore({ client, destination: destination(prefix), identity: key.identity }),
      ).rejects.toThrow(`clickhouse.zip.age of ${name} doesn't match its checksum`);
    } finally {
      client.destroy();
    }
  }, 120_000);
});

describe("before a backup", () => {
  test("too little free disk refuses it, saying how much it needs, and uploads nothing", async () => {
    const prefix = `test-backups/${run}/full-disk`;
    const client = backupClient(destination(prefix), RULES);
    try {
      const attempt = runBackup({
        // 6 GiB free of 100: under 7% would be left.
        sources: sources({ totalBytes: 100 * GiB, freeBytes: 6 * GiB }),
        destination: destination(prefix),
        client,
        recipient: key.recipient,
        version: OTTERTRAIL_VERSION,
      });
      await expect(attempt).rejects.toBeInstanceOf(BackupError);
      await expect(attempt).rejects.toThrow(
        /^Not enough free disk space, so the backup did not start: ClickHouse's backup needs about .+ on the server's disk, which has 6 GB free, and 7 GB \(7%\) must stay free/,
      );
      expect(await listBackups(client, LOCAL_OBJECT_STORE.bucket, prefix)).toEqual([]);
    } finally {
      client.destroy();
    }
  });
});

describe("retention", () => {
  test("deletes only old backups, only in the folder, and always keeps the newest whole one", async () => {
    const prefix = `test-backups/${run}/retention`;
    const now = new Date("2026-11-20T03:00:00Z");
    // Old whole backups, a recent one, and one cut off a while ago.
    for (const old of ["2026-11-01T030000Z", "2026-11-05T030000Z", "2026-11-18T030000Z"]) {
      await put(`${prefix}/${old}/postgres.dump.age`);
      await put(`${prefix}/${old}/manifest.json`);
    }
    await put(`${prefix}/2026-11-17T030000Z/postgres.dump.age`);
    // Neither a backup's folder nor outside the folder: never touched.
    await put(`${prefix}/notes.txt`);
    await put(`${prefix}/2026-11-01T030000Z-copy/manifest.json`);
    await put(`${prefix}-other/2026-11-01T030000Z/manifest.json`);
    await put(`test-backups/${run}/2026-11-01T030000Z/manifest.json`);

    const client = backupClient(destination(prefix), RULES);
    try {
      const deleted = await applyRetention(client, destination(prefix), 7, now);
      expect(deleted.toSorted()).toEqual([
        "2026-11-01T030000Z",
        "2026-11-05T030000Z",
        "2026-11-17T030000Z",
      ]);
      const left = await listBackups(client, LOCAL_OBJECT_STORE.bucket, prefix);
      expect(left.map((backup) => backup.name)).toEqual(["2026-11-18T030000Z"]);
      for (const kept of [
        `${prefix}/notes.txt`,
        `${prefix}/2026-11-01T030000Z-copy/manifest.json`,
        `${prefix}-other/2026-11-01T030000Z/manifest.json`,
        `test-backups/${run}/2026-11-01T030000Z/manifest.json`,
      ]) {
        expect((await getBytes(kept)).toString()).toBe("x");
      }

      // Long after: the newest whole backup stays, however old, so failures never leave none.
      expect(
        await applyRetention(client, destination(prefix), 7, new Date("2027-06-01T00:00:00Z")),
      ).toEqual([]);
      await store.deletePrefix(`${prefix}-other/`);
    } finally {
      client.destroy();
    }
  });
});

describe("the worker's backups", () => {
  const prefix = `test-backups/${run}/job`;
  const secrets = new BackupSecrets(TEST_AUTH_SECRET);
  let clock = new Date("2026-03-28T12:00:00Z");
  const logs: { level: string; msg: string }[] = [];

  function job(jobSources: BackupSources = sources()) {
    return new BackupJob({
      db: dashboard.db,
      objectStore: null,
      stackGarage: false,
      secrets,
      rules: RULES,
      sources: jobSources,
      version: OTTERTRAIL_VERSION,
      log: (level, msg) => void logs.push({ level, msg }),
      now: () => clock,
    });
  }

  beforeAll(async () => {
    await dashboard.db
      .updateTable("backup_settings")
      .set({
        enabled: true,
        time_of_day: "02:30",
        prefix,
        endpoint: LOCAL_OBJECT_STORE.url,
        region: LOCAL_OBJECT_STORE.region,
        bucket: LOCAL_OBJECT_STORE.bucket,
        access_key_id: LOCAL_OBJECT_STORE.accessKeyId,
        secret_sealed: secrets.sealSecret(LOCAL_OBJECT_STORE.secretAccessKey),
        key_sealed: secrets.sealKey(key.identity),
        key_recipient: key.recipient,
        key_created_at: clock,
        schedule_from: clock,
        last_slot: null,
      })
      .execute();
  });

  test("runs at the daily time in the instance's timezone, across the spring change", async () => {
    // Berlin skips 02:00 to 03:00 on 29 March 2026: 02:30 does not exist, so it runs at 03:30 CEST, 01:30 UTC.
    // A low disk makes each run fail at once, without uploading.
    const quick = job(sources({ totalBytes: 100 * GiB, freeBytes: 1 * GiB }));
    clock = new Date("2026-03-29T01:29:00Z");
    expect(await quick.tick()).toBeNull();
    clock = new Date("2026-03-29T01:30:00Z");
    expect(await quick.tick()).toEqual({ kind: "backup", trigger: "schedule" });
    // Taken: not again that day.
    clock = new Date("2026-03-29T01:31:00Z");
    expect(await quick.tick()).toBeNull();
    const [first] = await runs();
    expect(first).toMatchObject({ trigger: "schedule", status: "failed" });
    expect(first?.started_at.toISOString()).toBe("2026-03-29T01:30:00.000Z");
    expect(first?.error).toMatch(/^Not enough free disk space/);
  });

  test("a failed backup is tried once more an hour later, and not again", async () => {
    const quick = job(sources({ totalBytes: 100 * GiB, freeBytes: 1 * GiB }));
    const settings = await dashboard.db
      .selectFrom("backup_settings")
      .select("retry_at")
      .executeTakeFirstOrThrow();
    expect(settings.retry_at?.getTime()).toBe(Date.parse("2026-03-29T01:30:00Z") + RETRY_AFTER_MS);
    clock = new Date("2026-03-29T02:29:00Z");
    expect(await quick.tick()).toBeNull();
    clock = new Date("2026-03-29T02:30:00Z");
    expect(await quick.tick()).toEqual({ kind: "backup", trigger: "retry" });
    // The retry failed too: no third try before the next daily time.
    const after = await dashboard.db
      .selectFrom("backup_settings")
      .select("retry_at")
      .executeTakeFirstOrThrow();
    expect(after.retry_at).toBeNull();
    clock = new Date("2026-03-29T05:00:00Z");
    expect(await quick.tick()).toBeNull();
    expect((await runs()).map((row) => row.trigger)).toEqual(["schedule", "retry"]);
  });

  test("a failure is a storage warning, and alerts the channels chosen for them", async () => {
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
    const check = new StorageWarningJob({
      db: dashboard.db,
      sources: {
        ...storageSourcesOf(
          {
            objectStore: null,
            garage: null,
            replayStorageBytes: GiB,
            sourceMapStorageBytes: GiB,
            telemetryRetentionDays: 30,
          },
          dashboard.db,
          dashboard.reader.client,
        ),
        readDisk: async () => ({
          totalBytes: 100 * GiB,
          freeBytes: 60 * GiB,
          readOnly: false,
          broken: false,
        }),
      },
      publicUrl: "https://analytics.example.com",
      log: () => undefined,
      now: () => clock,
    });
    const result = await check.tick();
    expect(result?.started).toContain("backup_failed");
    const delivery = await dashboard.db
      .selectFrom("notification_deliveries")
      .select(["event_type", "payload"])
      .executeTakeFirstOrThrow();
    expect(delivery.event_type).toBe("storage.low");
    expect(delivery.payload).toMatchObject({
      type: "storage.low",
      subject: { type: "storage", warning: "backup_failed", level: "warning" },
      url: "https://analytics.example.com/settings?tab=backups",
    });
    expect((delivery.payload as { message: string }).message).toMatch(
      /^The last backup failed\. The backup that ended 29 Mar 2026, 02:30 UTC failed: Not enough free disk space/,
    );
    // The Storage tab shows it too.
    const warnings = await dashboard.db.selectFrom("storage_warnings").select("warning").execute();
    expect(warnings.map((row) => row.warning)).toContain("backup_failed");
  });

  test("Back up now runs a whole backup, and its success ends the warning", async () => {
    clock = new Date();
    await dashboard.db.updateTable("backup_settings").set({ backup_requested_at: clock }).execute();
    const worker = job();
    expect(await worker.tick()).toEqual({ kind: "backup", trigger: "manual" });
    const last = (await runs()).at(-1);
    expect(last).toMatchObject({ trigger: "manual", status: "succeeded", error: null });
    const row = await dashboard.db
      .selectFrom("backup_settings")
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(row.backup_requested_at).toBeNull();

    // Test restore, asked for on the tab, checks it.
    await dashboard.db
      .updateTable("backup_settings")
      .set({ test_restore_requested_at: clock })
      .execute();
    expect(await worker.tick()).toEqual({ kind: "test_restore", trigger: "manual" });
    const restore = await dashboard.db
      .selectFrom("backup_runs")
      .select(["status", "folder", "error"])
      .where("kind", "=", "test_restore")
      .executeTakeFirstOrThrow();
    expect(restore).toEqual({ status: "succeeded", folder: last?.folder, error: null });

    const health = await import("../src/backups/state.ts").then((state) =>
      state.readBackupHealth(dashboard.db, clock),
    );
    expect(health.failed).toBeNull();
  }, 120_000);

  test("across the autumn change, a repeated time runs once, at the first", async () => {
    await dashboard.db
      .updateTable("backup_settings")
      .set({ schedule_from: new Date("2026-10-20T00:00:00Z"), last_slot: null, retry_at: null })
      .execute();
    // Berlin goes from 03:00 back to 02:00 on 25 October 2026: 02:30 CEST is 00:30 UTC, then 02:30 CET is 01:30 UTC.
    const quick = job(sources({ totalBytes: 100 * GiB, freeBytes: 1 * GiB }));
    clock = new Date("2026-10-25T00:29:00Z");
    // The day before is due first: the worker catches it up.
    expect(await quick.tick()).toEqual({ kind: "backup", trigger: "schedule" });
    await dashboard.db.updateTable("backup_settings").set({ retry_at: null }).execute();
    expect(await quick.tick()).toBeNull();
    clock = new Date("2026-10-25T00:30:00Z");
    expect(await quick.tick()).toEqual({ kind: "backup", trigger: "schedule" });
    await dashboard.db.updateTable("backup_settings").set({ retry_at: null }).execute();
    clock = new Date("2026-10-25T01:30:00Z");
    expect(await quick.tick()).toBeNull();
    const row = await dashboard.db
      .selectFrom("backup_settings")
      .select("last_slot")
      .executeTakeFirstOrThrow();
    expect(row.last_slot).toBe("2026-10-25");
  });

  test("a run whose worker stopped is marked failed, and frees the next", async () => {
    const stale = new Date(clock.getTime() - 20 * 60_000);
    await dashboard.db
      .insertInto("backup_runs")
      .values({
        kind: "backup",
        trigger: "manual",
        status: "running",
        started_at: stale,
        heartbeat_at: stale,
      })
      .execute();
    await job().tick();
    const row = await dashboard.db
      .selectFrom("backup_runs")
      .select(["status", "error"])
      .where("started_at", "=", stale)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe("failed");
    expect(row.error).toMatch(/^The worker stopped while this ran/);
  });
});

const API = join(import.meta.dirname, "..");
const DEPLOY = join(API, "..", "..", "deploy");

/**
 * A stand-in for `docker compose` (as a Node.js script), for restore.sh:
 * `run` runs the image's command from its source with the bind mounts
 * mapped to the host's folders; `exec` answers the readiness checks and
 * hashes what pg_restore and ClickHouse's file would read; the rest only
 * succeeds. Every call goes to `log`, with its arguments.
 */
function fakeCompose(log: string): string {
  return `import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
const API = ${JSON.stringify(API)};
const args = process.argv.slice(2);
const note = (line) => appendFileSync(${JSON.stringify(log)}, line + "\\n");
const joined = args.join(" ");
if (args[0] === "run") {
  const mounts = [];
  for (let i = 0; i < args.length; i++) if (args[i] === "-v") mounts.push(args[i + 1].split(":"));
  const at = args.indexOf("node");
  const script = args[at + 1];
  const rest = args.slice(at + 2).map((arg) => {
    for (const [host, inside] of mounts) {
      if (arg === inside || arg.startsWith(inside + "/")) return host + arg.slice(inside.length);
    }
    return arg;
  });
  note("run " + script + " " + rest.join(" "));
  const source = script.replace("dist/", "scripts/").replace(".mjs", ".ts");
  const result = spawnSync(process.execPath, [join(API, source), ...rest], { stdio: "inherit", cwd: API });
  process.exit(result.status ?? 1);
}
if (args[0] === "exec") {
  if (joined.includes("/proc/1/comm")) process.stdout.write("clickhouse-serv\\n");
  if (joined.includes("pg_restore") || joined.includes("cat >")) {
    const input = readFileSync(0);
    note("stdin " + (joined.includes("pg_restore") ? "pg_restore" : "clickhouse") + " " + createHash("sha256").update(input).digest("hex"));
  } else {
    note("exec " + joined);
  }
  process.exit(0);
}
note(joined);
process.exit(0);
`;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
