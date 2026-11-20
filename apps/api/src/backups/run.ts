import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createReadStream, createWriteStream } from "node:fs";
import { rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { buffer as readAll } from "node:stream/consumers";
import { setTimeout as sleep } from "node:timers/promises";

import {
  GetObjectCommand,
  ListObjectsV2Command,
  NoSuchKey,
  type S3Client,
} from "@aws-sdk/client-s3";
import { z } from "zod";

import { type ClickHouseClient, identifier } from "../clickhouse/clickhouse.ts";
import type { ObjectStoreConfig } from "../config.ts";
import {
  MANIFEST_FILE,
  OBJECTS_FORMAT,
  type ObjectManifest,
  objectManifestSchema,
} from "../storage/object-backup.ts";
import { s3Client } from "../storage/object-store.ts";
import { sizeText } from "../storage/warnings.ts";
import {
  decrypted,
  type Digest,
  encrypted,
  measured,
  type TarEntry,
  tarStream,
} from "./archive.ts";
import {
  backupName,
  deleteBackup,
  getStream,
  listBackups,
  MANIFEST_KEY,
  putObject,
  s3ErrorText,
  uploadStream,
} from "./s3.ts";
import type { Destination } from "./settings.ts";

/**
 * One backup (docs/deployment.md, "Backups"), in backup.sh's order, each
 * part encrypted with age and streamed to the destination under
 * `<folder>/<UTC time>/`:
 *
 * 1. `postgres.dump.age`: `pg_dump -Fc`, first, so every project in it has
 *    its events in ClickHouse's backup, taken after (docs/clickhouse.md).
 * 2. `clickhouse.zip.age`: ClickHouse's own `BACKUP DATABASE … TO
 *    File(…)`, written into its backups folder, which the worker shares
 *    (deploy/compose.yaml), read from there, and deleted after.
 * 3. `objects.tar.age`: the object store's objects (source maps and
 *    session replays) with their manifest, the tar backup.sh makes.
 * 4. `manifest.json`, last, not encrypted: the backup's version and time,
 *    the instance's version, and each part's size and SHA-256 before and
 *    after encryption. A folder without it is not a whole backup.
 *
 * A run that fails deletes what it uploaded, and its local file.
 */

export const PARTS = {
  postgres: "postgres.dump.age",
  clickhouse: "clickhouse.zip.age",
  objects: "objects.tar.age",
} as const;

export type PartName = keyof typeof PARTS;

export const BACKUP_FORMAT = "ottertrail-backup";

const digestSchema = z.object({
  bytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

export const manifestSchema = z.object({
  format: z.literal(BACKUP_FORMAT),
  version: z.literal(1),
  name: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{6}Z$/),
  startedAt: z.string(),
  finishedAt: z.string(),
  instance: z.object({ version: z.string() }),
  encryption: z.object({ format: z.literal("age"), recipient: z.string().startsWith("age1") }),
  clickhouseDatabase: z.string(),
  parts: z.array(
    z.object({
      name: z.enum(["postgres", "clickhouse", "objects"]),
      file: z.enum([PARTS.postgres, PARTS.clickhouse, PARTS.objects]),
      plain: digestSchema,
      encrypted: digestSchema,
    }),
  ),
  objects: z.object({
    bucket: z.string().nullable(),
    count: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative(),
    gone: z.number().int().nonnegative(),
  }),
});

export type BackupManifest = z.infer<typeof manifestSchema>;

/** A failure in words for the Backups tab: what failed, why, and what to do. */
export class BackupError extends Error {
  override name = "BackupError";
}

/** pg_dump running, with its output. */
export interface PostgresDump {
  stdout: AsyncIterable<Uint8Array>;
  /** Resolves when it exits cleanly; rejects with its error otherwise. */
  done: Promise<void>;
  kill(): void;
}

/** Where ClickHouse's BACKUP writes its file, as the worker reads it. */
export interface ClickHouseBackupFiles {
  read(name: string): Promise<{ stream: AsyncIterable<Uint8Array>; size: number }>;
  remove(name: string): Promise<void>;
}

/** What a backup reads from. */
export interface BackupSources {
  /** Starts `pg_dump -Fc` of the instance's database. */
  dumpPostgres(): PostgresDump;
  clickhouse: ClickHouseClient;
  clickhouseDatabase: string;
  clickhouseFiles: ClickHouseBackupFiles;
  objectStore: ObjectStoreConfig | null;
  /** Only objects whose keys start with this: tests keep to their own. */
  objectPrefix?: string;
  /** The disk ClickHouse writes to: its size and free space. */
  readDisk(): Promise<{ totalBytes: number; freeBytes: number }>;
  /** What ClickHouse's backup will take: its active parts' bytes. */
  clickhouseBytes(): Promise<number>;
}

/** The share of the disk that must stay free while ClickHouse's backup file is on it. */
export const BACKUP_FREE_RATIO = 0.07;

/**
 * Refuses a backup that would fill the disk. ClickHouse writes its backup
 * file next to its data first, about as large as its active parts; with
 * the file on the disk, BACKUP_FREE_RATIO of it must still be free, past
 * the 5% under which ClickHouse refuses events (docs/deployment.md, "ClickHouse
 * keeps 5% of the disk free").
 */
export async function checkSpace(sources: BackupSources): Promise<void> {
  let disk: { totalBytes: number; freeBytes: number };
  let need: number;
  try {
    [disk, need] = await Promise.all([sources.readDisk(), sources.clickhouseBytes()]);
  } catch (error) {
    throw new BackupError(
      `The free disk space could not be measured, so the backup did not start: ClickHouse did not answer (${error instanceof Error ? error.message : String(error)}). Check that ClickHouse runs, then back up again.`,
    );
  }
  const keep = disk.totalBytes * BACKUP_FREE_RATIO;
  if (disk.freeBytes - need < keep) {
    throw new BackupError(
      `Not enough free disk space, so the backup did not start: ClickHouse's backup needs about ${sizeText(need)} on the server's disk, which has ${sizeText(disk.freeBytes)} free, and ${sizeText(keep)} (7%) must stay free so ClickHouse keeps taking events. Free space on the disk (Settings, Storage shows what fills it), then back up again.`,
    );
  }
}

/** A step's failure: which step, and the cause in plain words. */
function failedStep(step: string, error: unknown): BackupError {
  if (error instanceof BackupError) return error;
  const detail =
    error instanceof Error && error.name === "AbortError"
      ? "the worker was stopped"
      : s3ErrorText(error, "write");
  return new BackupError(`${step} failed: ${detail}`);
}

/** Encrypts `source` to `recipient` and uploads it as `key`; both digests once done. */
async function encryptAndUpload(
  client: S3Client,
  bucket: string,
  key: string,
  source: AsyncIterable<Uint8Array>,
  recipient: string,
  signal: AbortSignal,
): Promise<{ plain: Digest; encrypted: Digest }> {
  const plain = measured(source);
  const sealed = measured(await encrypted(plain.stream, recipient));
  await uploadStream(client, bucket, key, sealed.stream, signal);
  return { plain: plain.digest(), encrypted: sealed.digest() };
}

/** Lines of pg_dump's error output kept for the message. */
const STDERR_BYTES = 2000;

/**
 * pg_dump of `databaseUrl`, custom format. The password goes in
 * PGPASSWORD, never on the command line; `schema` keeps it to one
 * schema (tests).
 */
export function spawnPgDump(
  databaseUrl: string,
  { schema }: { schema?: string } = {},
): PostgresDump {
  const url = new URL(databaseUrl);
  const password = decodeURIComponent(url.password);
  url.password = "";
  const child = spawn(
    "pg_dump",
    [
      "--format=custom",
      "--no-password",
      `--dbname=${url.href}`,
      ...(schema === undefined ? [] : [`--schema=${schema}`]),
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        PGPASSWORD: password,
        PGCONNECT_TIMEOUT: "10",
      },
    },
  );
  return pgDumpOf(child, "pg_dump");
}

/** A running pg_dump (or a stand-in that runs it elsewhere), as a PostgresDump. */
export function pgDumpOf(
  child: import("node:child_process").ChildProcessByStdio<null, Readable, Readable>,
  command: string,
): PostgresDump {
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString("utf8")}`.slice(-STDERR_BYTES);
  });
  const done = new Promise<void>((resolve, reject) => {
    child.once("error", (error: NodeJS.ErrnoException) => {
      reject(
        new BackupError(
          error.code === "ENOENT"
            ? `${command} is not installed where the worker runs. The image from the Dockerfile has it; a worker run another way needs PostgreSQL 18's client tools.`
            : `${command} could not start: ${error.message}`,
        ),
      );
    });
    child.once("close", (code) => {
      if (code === 0) resolve();
      else {
        const last = stderr.trim().split("\n").slice(-2).join(" ").trim();
        reject(
          new BackupError(`${command} failed (exit ${code ?? "signal"}): ${last || "no message"}`),
        );
      }
    });
  });
  // An unheard rejection while the upload runs would end the process.
  done.catch(() => undefined);
  return { stdout: child.stdout, done, kill: () => child.kill("SIGTERM") };
}

/** ClickHouse's backup files in `dir`, the folder it shares with the worker; null when unset. */
export function localClickHouseFiles(dir: string | null): ClickHouseBackupFiles {
  const file = (name: string) => {
    if (dir === null) {
      throw new BackupError(
        "The worker can't read ClickHouse's backups: CLICKHOUSE_BACKUP_PATH is not set. deploy/compose.yaml shares ClickHouse's backups folder with the worker and sets it; a worker run another way needs the same folder.",
      );
    }
    if (!/^[A-Za-z0-9-]+\.zip$/.test(name)) throw new Error(`not a backup file name: ${name}`);
    return path.join(dir, name);
  };
  return {
    async read(name) {
      const where = file(name);
      let info;
      try {
        info = await stat(where);
      } catch (error) {
        throw new BackupError(
          `ClickHouse wrote its backup, but the worker can't find it in ${dir ?? ""} (${error instanceof Error ? error.message : String(error)}). Check that the worker and ClickHouse share the backups folder (the clickhouse-backups volume in deploy/compose.yaml).`,
        );
      }
      return { stream: createReadStream(where), size: info.size };
    },
    async remove(name) {
      await rm(file(name), { force: true });
    },
  };
}

/** How often the worker asks ClickHouse whether its backup is done. */
const CLICKHOUSE_POLL_MS = 2000;
/** The longest ClickHouse's backup may take. */
const CLICKHOUSE_BACKUP_MS = 12 * 60 * 60 * 1000;

/** Runs ClickHouse's BACKUP into `file` and waits for it. */
async function backupClickHouse(
  client: ClickHouseClient,
  database: string,
  file: string,
  signal: AbortSignal,
): Promise<void> {
  if (!/^[A-Za-z0-9-]+\.zip$/.test(file)) throw new Error(`not a backup file name: ${file}`);
  // ASYNC: the request returns at once, and a long backup needs no long-lived HTTP request.
  const started = await client.query({
    query: `BACKUP DATABASE ${identifier(database)} TO File('${file}') ASYNC`,
    format: "JSONEachRow",
  });
  const [row] = await started.json<{ id: string; status: string }>();
  if (row === undefined) throw new Error("ClickHouse started no backup");
  const deadline = Date.now() + CLICKHOUSE_BACKUP_MS;
  for (;;) {
    const result = await client.query({
      query: "SELECT status, error FROM system.backups WHERE id = {id:String}",
      query_params: { id: row.id },
      format: "JSONEachRow",
    });
    const [state] = await result.json<{ status: string; error: string }>();
    if (state?.status === "BACKUP_CREATED") return;
    if (state !== undefined && state.status !== "CREATING_BACKUP") {
      const reason = state.error.split("\n")[0]?.slice(0, 400) ?? "";
      throw new BackupError(
        `ClickHouse's backup failed (${state.status}): ${reason || "no message"}`,
      );
    }
    if (Date.now() > deadline)
      throw new BackupError("ClickHouse's backup took more than 12 hours.");
    await sleep(CLICKHOUSE_POLL_MS, undefined, { signal });
  }
}

/** The objects of the store as tar entries, with their manifest last. */
async function* objectEntries(
  store: ObjectStoreConfig,
  {
    skipPrefix,
    onlyPrefix,
    summary,
  }: {
    skipPrefix: string | null;
    onlyPrefix: string | undefined;
    summary: { count: number; bytes: number; gone: number };
  },
  startedAt: Date,
): AsyncIterable<TarEntry> {
  const client = s3Client(store);
  const listed: ObjectManifest["objects"] = [];
  let next = 0;
  try {
    let token: string | undefined;
    do {
      const page = await client.send(
        new ListObjectsV2Command({
          Bucket: store.bucket,
          Prefix: onlyPrefix,
          ContinuationToken: token,
        }),
      );
      for (const item of page.Contents ?? []) {
        const key = item.Key;
        // Never the backups themselves, when they share the store's bucket.
        if (key === undefined || (skipPrefix !== null && key.startsWith(skipPrefix))) continue;
        let response;
        try {
          response = await client.send(new GetObjectCommand({ Bucket: store.bucket, Key: key }));
        } catch (error) {
          // Deleted after it was listed (expired, or its project deleted): as if gone before.
          if (error instanceof NoSuchKey) {
            summary.gone += 1;
            continue;
          }
          throw error;
        }
        if (!(response.Body instanceof Readable) || response.ContentLength === undefined) {
          throw new Error(`could not read ${key}: no body or length`);
        }
        const file = `objects/${String(++next).padStart(6, "0")}`;
        const hash = createHash("sha256");
        const body = response.Body;
        const length = response.ContentLength;
        const contentType = response.ContentType ?? "application/octet-stream";
        yield {
          name: file,
          size: length,
          body: (async function* () {
            for await (const chunk of body as AsyncIterable<Buffer>) {
              hash.update(chunk);
              yield chunk;
            }
            listed.push({ key, file, size: length, contentType, sha256: hash.digest("hex") });
          })(),
        };
        summary.count += 1;
        summary.bytes += length;
      }
      token = page.IsTruncated === true ? page.NextContinuationToken : undefined;
      if (page.IsTruncated === true && (token === undefined || token === "")) {
        throw new Error("the store said the listing goes on, but gave no token to continue");
      }
    } while (token !== undefined);
  } finally {
    client.destroy();
  }
  const manifest: ObjectManifest = {
    format: OBJECTS_FORMAT,
    version: 1,
    bucket: store.bucket,
    createdAt: startedAt.toISOString(),
    objects: listed,
  };
  const text = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  yield { name: MANIFEST_FILE, size: text.length, body: [text] };
}

/** The tar of an instance without an object store: a manifest that says so. */
async function* noObjects(startedAt: Date): AsyncIterable<TarEntry> {
  const manifest: ObjectManifest = {
    format: OBJECTS_FORMAT,
    version: 1,
    bucket: null,
    createdAt: startedAt.toISOString(),
    objects: [],
  };
  const text = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  yield { name: MANIFEST_FILE, size: text.length, body: [text] };
}

export interface BackupResult {
  name: string;
  /** Encrypted bytes uploaded, all parts and the manifest together. */
  bytes: number;
  manifest: BackupManifest;
}

/** Runs one backup to `destination`; throws a BackupError that says what failed. */
export async function runBackup({
  sources,
  destination,
  client,
  recipient,
  version,
  now = () => new Date(),
  signal = new AbortController().signal,
  onStep = () => undefined,
}: {
  sources: BackupSources;
  destination: Destination;
  client: S3Client;
  /** The backup key's public half, "age1…". */
  recipient: string;
  /** The instance's version (version.ts). */
  version: string;
  now?: () => Date;
  signal?: AbortSignal;
  /** Hears each step as it starts, for the log. */
  onStep?: (step: string) => void;
}): Promise<BackupResult> {
  onStep("checking free disk space");
  await checkSpace(sources);
  const startedAt = now();
  const name = backupName(startedAt);
  const folder = `${destination.prefix}/${name}`;
  const parts: BackupManifest["parts"] = [];
  const zip = `ottertrail-worker-${name}.zip`;
  const objects = { count: 0, bytes: 0, gone: 0 };
  let uploaded = false;

  try {
    onStep("dumping PostgreSQL");
    const dump = sources.dumpPostgres();
    uploaded = true;
    let dumped;
    try {
      dumped = await encryptAndUpload(
        client,
        destination.bucket,
        `${folder}/${PARTS.postgres}`,
        dump.stdout,
        recipient,
        signal,
      );
    } catch (error) {
      dump.kill();
      throw failedStep("Uploading PostgreSQL's dump", error);
    }
    // A pg_dump that fails ends its output early: the upload succeeds, and its exit says why.
    try {
      await dump.done;
    } catch (error) {
      throw failedStep("Dumping PostgreSQL", error);
    }
    parts.push({ name: "postgres", file: PARTS.postgres, ...dumped });

    onStep("backing up ClickHouse");
    try {
      await backupClickHouse(sources.clickhouse, sources.clickhouseDatabase, zip, signal);
      const file = await sources.clickhouseFiles.read(zip);
      const digests = await encryptAndUpload(
        client,
        destination.bucket,
        `${folder}/${PARTS.clickhouse}`,
        file.stream,
        recipient,
        signal,
      );
      if (digests.plain.bytes !== file.size) {
        throw new BackupError(
          `ClickHouse's backup file changed while it was read (${digests.plain.bytes} of ${file.size} bytes).`,
        );
      }
      parts.push({ name: "clickhouse", file: PARTS.clickhouse, ...digests });
    } catch (error) {
      throw failedStep("Backing up ClickHouse", error);
    } finally {
      await sources.clickhouseFiles.remove(zip).catch(() => undefined);
    }

    onStep("backing up the object store");
    try {
      const store = sources.objectStore;
      const shared =
        store !== null && store.url === destination.url && store.bucket === destination.bucket;
      const entries =
        store === null
          ? noObjects(startedAt)
          : objectEntries(
              store,
              {
                skipPrefix: shared ? `${destination.prefix}/` : null,
                onlyPrefix: sources.objectPrefix,
                summary: objects,
              },
              startedAt,
            );
      const digests = await encryptAndUpload(
        client,
        destination.bucket,
        `${folder}/${PARTS.objects}`,
        tarStream(store === null ? [] : ["objects"], entries, startedAt),
        recipient,
        signal,
      );
      parts.push({ name: "objects", file: PARTS.objects, ...digests });
    } catch (error) {
      throw failedStep("Backing up the object store (source maps and session replays)", error);
    }

    onStep("writing the manifest");
    const manifest: BackupManifest = {
      format: BACKUP_FORMAT,
      version: 1,
      name,
      startedAt: startedAt.toISOString(),
      finishedAt: now().toISOString(),
      instance: { version },
      encryption: { format: "age", recipient },
      clickhouseDatabase: sources.clickhouseDatabase,
      parts,
      objects: { bucket: sources.objectStore?.bucket ?? null, ...objects },
    };
    const text = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    try {
      await putObject(
        client,
        destination.bucket,
        `${folder}/${MANIFEST_KEY}`,
        text,
        "application/json",
        signal,
      );
    } catch (error) {
      throw failedStep("Writing the backup's manifest", error);
    }
    const bytes = parts.reduce((sum, part) => sum + part.encrypted.bytes, 0) + text.length;
    return { name, bytes, manifest };
  } catch (error) {
    if (uploaded) {
      // A folder without its manifest is no backup: leave nothing that looks like part of one.
      await deleteBackup(client, destination.bucket, destination.prefix, name).catch(
        () => undefined,
      );
    }
    throw error;
  }
}

/**
 * Deletes backups older than `keepDays`, only in the destination's folder,
 * and never the newest whole one, however old: a run of failures never
 * leaves no backup at all. A folder without a manifest (a run cut off
 * before it could clean up) goes once it is a day old.
 */
export async function applyRetention(
  client: S3Client,
  destination: Destination,
  keepDays: number,
  now: Date,
): Promise<string[]> {
  if (destination.prefix === "") throw new Error("backups need a folder");
  const backups = await listBackups(client, destination.bucket, destination.prefix);
  const newestWhole = backups.find((backup) => backup.complete)?.name;
  const cutOff = now.getTime() - keepDays * 86_400_000;
  const dayAgo = now.getTime() - 86_400_000;
  const deleted: string[] = [];
  for (const backup of backups) {
    if (backup.name === newestWhole) continue;
    const old = backup.complete ? backup.at.getTime() < cutOff : backup.at.getTime() < dayAgo;
    if (!old) continue;
    await deleteBackup(client, destination.bucket, destination.prefix, backup.name);
    deleted.push(backup.name);
  }
  return deleted;
}

/** What Test restore checked. */
export interface RestoreCheck {
  name: string;
  /** Encrypted bytes downloaded and checked. */
  bytes: number;
  parts: { name: PartName; plainBytes: number }[];
  objects: number;
}

/** What restore.sh calls each part's file, after `ottertrail-<name>`, as backup.sh names them. */
export const LOCAL_ENDINGS: Record<PartName, string> = {
  postgres: ".dump",
  clickhouse: ".zip",
  objects: "-objects.tar",
};

/** Passes `source` through, writing each chunk to `file` first. */
async function* written(
  source: AsyncIterable<Uint8Array>,
  file: import("node:fs").WriteStream,
): AsyncIterable<Uint8Array> {
  for await (const chunk of source) {
    if (!file.write(chunk)) await once(file, "drain");
    yield chunk;
  }
}

/** The first bytes each part's plain file starts with. */
const MAGIC: Record<PartName, Buffer | null> = {
  postgres: Buffer.from("PGDMP"),
  clickhouse: Buffer.from("PK"),
  objects: null,
};

/**
 * Reads a tar as it streams by: each file's SHA-256 and size, and the
 * object manifest's text, to check the objects against it.
 */
async function readTar(
  source: AsyncIterable<Uint8Array>,
): Promise<{ files: Map<string, { size: number; sha256: string }>; manifest: string | null }> {
  const files = new Map<string, { size: number; sha256: string }>();
  let manifest: string | null = null;
  let buffer = Buffer.alloc(0);
  let current: {
    name: string;
    left: number;
    pad: number;
    hash: ReturnType<typeof createHash>;
    text: Buffer[] | null;
  } | null = null;
  let ended = false;
  for await (const chunk of source) {
    buffer = buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([buffer, chunk]);
    for (;;) {
      if (ended) break;
      if (current === null) {
        if (buffer.length < 512) break;
        const header = buffer.subarray(0, 512);
        buffer = buffer.subarray(512);
        if (header.every((byte) => byte === 0)) {
          ended = true;
          break;
        }
        const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/s, "");
        const size = Number.parseInt(
          header.subarray(124, 136).toString("ascii").replace(/\0.*$/s, ""),
          8,
        );
        const type = String.fromCharCode(header[156] ?? 48);
        if (!Number.isFinite(size)) throw new Error("the object tar has a damaged header");
        if (type === "5") continue;
        current = {
          name,
          left: size,
          pad: (512 - (size % 512)) % 512,
          hash: createHash("sha256"),
          text: name === MANIFEST_FILE ? [] : null,
        };
        files.set(name, { size, sha256: "" });
      }
      if (current.left > 0) {
        if (buffer.length === 0) break;
        const take = buffer.subarray(0, Math.min(current.left, buffer.length));
        buffer = buffer.subarray(take.length);
        current.hash.update(take);
        current.text?.push(Buffer.from(take));
        current.left -= take.length;
        if (current.left > 0) break;
      }
      if (buffer.length < current.pad) break;
      buffer = buffer.subarray(current.pad);
      const entry = files.get(current.name);
      if (entry !== undefined) entry.sha256 = current.hash.digest("hex");
      if (current.text !== null) manifest = Buffer.concat(current.text).toString("utf8");
      current = null;
    }
  }
  if (current !== null) throw new Error("the object tar ends in the middle of a file");
  return { files, manifest };
}

/**
 * Test restore: downloads the newest whole backup's manifest and parts,
 * decrypts each with the backup key as it streams in, and checks every
 * size and SHA-256, before and after decryption, and each object in the
 * object tar against its own manifest. Restores nothing.
 */
export async function testRestore({
  client,
  destination,
  identity,
  name,
  writeTo,
  signal = new AbortController().signal,
}: {
  client: S3Client;
  destination: Destination;
  /** The backup key, "AGE-SECRET-KEY-1…". */
  identity: string;
  /** This backup rather than the newest whole one. */
  name?: string;
  /**
   * Also writes each decrypted part into this folder, as backup.sh names its
   * files (`ottertrail-<name>.dump`, `.zip`, `-objects.tar`), for restore.sh:
   * each under a `.partial` name until it checks out.
   */
  writeTo?: string;
  signal?: AbortSignal;
}): Promise<RestoreCheck> {
  let backups;
  try {
    backups = await listBackups(client, destination.bucket, destination.prefix, signal);
  } catch (error) {
    throw new BackupError(`Listing the backups failed: ${s3ErrorText(error, "list")}`);
  }
  const newest = backups.find((backup) =>
    name === undefined ? backup.complete : backup.name === name,
  );
  if (newest === undefined || !newest.complete) {
    throw new BackupError(
      name === undefined
        ? `There is no whole backup in ${destination.bucket}/${destination.prefix} to check yet. Back up first, then test the restore.`
        : `${destination.bucket}/${destination.prefix} holds no whole backup named ${name}.`,
    );
  }
  const folder = `${destination.prefix}/${newest.name}`;
  let manifest: BackupManifest;
  try {
    const { body } = await getStream(
      client,
      destination.bucket,
      `${folder}/${MANIFEST_KEY}`,
      signal,
    );
    const parsed = manifestSchema.safeParse(JSON.parse((await readAll(body)).toString("utf8")));
    if (!parsed.success)
      throw new BackupError(`The manifest of ${newest.name} is not one Ottertrail wrote.`);
    manifest = parsed.data;
  } catch (error) {
    if (error instanceof BackupError) throw error;
    throw new BackupError(
      `Reading the manifest of ${newest.name} failed: ${error instanceof SyntaxError ? "it is not JSON" : s3ErrorText(error, "read")}`,
    );
  }

  const checked: RestoreCheck["parts"] = [];
  let bytes = 0;
  let objectCount = 0;
  for (const part of manifest.parts) {
    const label = `${part.file} of ${newest.name}`;
    let body;
    try {
      ({ body } = await getStream(client, destination.bucket, `${folder}/${part.file}`, signal));
    } catch (error) {
      throw new BackupError(`Downloading ${label} failed: ${s3ErrorText(error, "read")}`);
    }
    const sealed = measured(body);
    let plain;
    try {
      plain = measured(await decrypted(sealed.stream, identity));
    } catch (error) {
      throw new BackupError(
        `${label} can't be decrypted with this instance's backup key (${error instanceof Error ? error.message : String(error)}). It was made with another key, or the file is damaged.`,
      );
    }
    const magic = MAGIC[part.name];
    let head = Buffer.alloc(0);
    let tar: Awaited<ReturnType<typeof readTar>> | null = null;
    const output =
      writeTo === undefined
        ? null
        : path.join(writeTo, `ottertrail-${newest.name}${LOCAL_ENDINGS[part.name]}`);
    const file =
      output === null ? null : createWriteStream(`${output}.partial`, { flags: "w", mode: 0o600 });
    const kept = file === null ? plain.stream : written(plain.stream, file);
    try {
      if (part.name === "objects") {
        tar = await readTar(kept);
      } else {
        for await (const chunk of kept) {
          if (head.length < 8) head = Buffer.concat([head, chunk]).subarray(0, 8);
        }
      }
      if (file !== null)
        await new Promise<void>((resolve, reject) =>
          file.end((error?: Error | null) => (error ? reject(error) : resolve())),
        );
    } catch (error) {
      file?.destroy();
      throw new BackupError(
        `${label} doesn't match its checksum: decrypting it failed part way (${error instanceof Error ? error.message : String(error)}). The file in the bucket is damaged or was changed, so this backup can't be restored as it is. The next backup makes a new one.`,
      );
    }
    const enc = sealed.digest();
    const dec = plain.digest();
    if (
      enc.bytes !== part.encrypted.bytes ||
      enc.sha256 !== part.encrypted.sha256 ||
      dec.bytes !== part.plain.bytes ||
      dec.sha256 !== part.plain.sha256
    ) {
      throw new BackupError(
        `${label} doesn't match its checksum in the manifest. The file in the bucket is damaged or was changed, so this backup can't be restored as it is. The next backup makes a new one.`,
      );
    }
    if (magic !== null && !head.subarray(0, magic.length).equals(magic)) {
      throw new BackupError(`${label} decrypts, but is not the file it should be.`);
    }
    if (tar !== null) {
      let parsed: unknown = null;
      try {
        parsed = tar.manifest === null ? null : JSON.parse(tar.manifest);
      } catch {
        // Not JSON: refused below.
      }
      const checkedManifest = objectManifestSchema.safeParse(parsed);
      if (!checkedManifest.success) throw new BackupError(`${label} has no object manifest.`);
      const objectManifest = checkedManifest.data;
      for (const entry of objectManifest.objects) {
        const found = tar.files.get(entry.file);
        if (found === undefined || found.size !== entry.size || found.sha256 !== entry.sha256) {
          throw new BackupError(
            `${label}: the object ${entry.key} doesn't match its checksum. The file in the bucket is damaged.`,
          );
        }
      }
      objectCount = objectManifest.objects.length;
    }
    if (output !== null) await rename(`${output}.partial`, output);
    checked.push({ name: part.name, plainBytes: dec.bytes });
    bytes += enc.bytes;
  }
  for (const required of ["postgres", "clickhouse", "objects"] as const) {
    if (!checked.some((part) => part.name === required)) {
      throw new BackupError(`The manifest of ${newest.name} lists no ${PARTS[required]}.`);
    }
  }
  return { name: newest.name, bytes, parts: checked, objects: objectCount };
}
