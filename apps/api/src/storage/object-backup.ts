import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as sleep } from "node:timers/promises";

import {
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  NoSuchKey,
  PutObjectCommand,
  S3ServiceException,
  type S3Client,
} from "@aws-sdk/client-s3";
import { z } from "zod";

import type { ObjectStoreConfig } from "../config.ts";
import { s3Client } from "./object-store.ts";

/**
 * Backs up the object store (source maps and session replays) into a
 * folder, and puts such a folder back (deploy/backup.sh and restore.sh,
 * docs/deployment.md). Each object is streamed to or from its own file,
 * never held whole in memory. The folder holds:
 *
 * - `objects/<number>`: one file per object, numbered, since keys can hold
 *   characters a file name cannot;
 * - `manifest.json`: each object's key, file, size, content type, and
 *   SHA-256, written last, so a folder without it is not a whole backup.
 *   An instance without an object store gets one too, with no bucket and
 *   no objects, so every backup has the same three files.
 */

export const MANIFEST_FILE = "manifest.json";
const OBJECTS_FOLDER = "objects";
export const OBJECTS_FORMAT = "ottertrail-objects";
/** Objects copied at the same time: enough to hide a store's latency. */
const CONCURRENCY = 8;
/** Tries of each upload: the SDK never retries a request whose body is a stream. */
const UPLOAD_ATTEMPTS = 4;
/** How long a restore waits for the bucket to answer: a store just started creates it. */
const BUCKET_WAIT_MS = 60_000;

export const objectManifestSchema = z.object({
  format: z.literal(OBJECTS_FORMAT),
  version: z.literal(1),
  /** Null when the instance had no object store. */
  bucket: z.string().nullable(),
  createdAt: z.string(),
  objects: z.array(
    z.object({
      key: z.string().min(1),
      // Only names this module writes: nothing outside the folder.
      file: z.string().regex(/^objects\/[0-9]+$/),
      size: z.number().int().nonnegative(),
      contentType: z.string(),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
    }),
  ),
});

export type ObjectManifest = z.infer<typeof objectManifestSchema>;
type ManifestEntry = ObjectManifest["objects"][number];
/** A manifest entry whose file was checked, with its MD5 for the upload (base64). */
export type CheckedEntry = ManifestEntry & { md5: string };

export interface ObjectBackupOptions {
  /** Only keys that start with this; tests use it to keep to their own objects. */
  prefix?: string;
  /** Keys asked for per listing page; S3's most, 1,000, unless a test needs pages. */
  pageSize?: number;
  /** Called with each page's keys before they are read: tests delete one in between. */
  afterList?: (keys: readonly string[]) => Promise<void>;
}

export interface ObjectBackupSummary {
  /** Null when there is no object store: the manifest says so, and holds nothing. */
  bucket: string | null;
  count: number;
  bytes: number;
  /** Listed but deleted before they were read: expired, or their project deleted. */
  gone: string[];
}

export interface ObjectRestoreOptions {
  /** How long to wait for the bucket to answer. */
  bucketWaitMs?: number;
  /** The first pause between tries of an upload; doubled each time. */
  retryDelayMs?: number;
}

export interface ObjectRestoreSummary {
  count: number;
  bytes: number;
  /** The bucket the backup was made from; null when that instance had no object store. */
  backupBucket: string | null;
}

/**
 * Copies every object of the store into `dir`, which must be empty or not
 * exist yet. Without a store (`config` null), writes a manifest that says so.
 */
export async function backupObjects(
  config: ObjectStoreConfig | null,
  dir: string,
  options: ObjectBackupOptions = {},
): Promise<ObjectBackupSummary> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if ((await readdir(dir)).length > 0) throw new Error(`${dir} is not empty`);
  await mkdir(path.join(dir, OBJECTS_FOLDER), { mode: 0o700 });

  const entries: ManifestEntry[] = [];
  const gone: string[] = [];
  if (config !== null) {
    const client = s3Client(config);
    let next = 0;
    try {
      let token: string | undefined;
      do {
        const page = await client.send(
          new ListObjectsV2Command({
            Bucket: config.bucket,
            Prefix: options.prefix,
            MaxKeys: options.pageSize,
            ContinuationToken: token,
          }),
        );
        const keys = (page.Contents ?? []).flatMap((item) =>
          item.Key === undefined ? [] : [item.Key],
        );
        await options.afterList?.(keys);
        const files = keys.map(() => `${OBJECTS_FOLDER}/${String(++next).padStart(6, "0")}`);
        const results = await mapLimit(keys, CONCURRENCY, (key, index) =>
          downloadObject(client, config.bucket, key, dir, files[index] ?? ""),
        );
        results.forEach((entry, index) => {
          if (entry === null) gone.push(keys[index] ?? "");
          else entries.push(entry);
        });
        if (page.IsTruncated === true) {
          // More to list, but no way to ask for it: never a backup that looks whole.
          if (page.NextContinuationToken === undefined || page.NextContinuationToken === "") {
            throw new Error("the store said the listing goes on, but gave no token to continue");
          }
          token = page.NextContinuationToken;
        } else {
          token = undefined;
        }
      } while (token !== undefined);
    } finally {
      client.destroy();
    }
  }

  const manifest: ObjectManifest = {
    format: OBJECTS_FORMAT,
    version: 1,
    bucket: config?.bucket ?? null,
    createdAt: new Date().toISOString(),
    objects: entries,
  };
  // Under another name until complete: a manifest means a whole backup.
  const partial = path.join(dir, `${MANIFEST_FILE}.partial`);
  await writeFile(partial, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  await rename(partial, path.join(dir, MANIFEST_FILE));

  return { bucket: manifest.bucket, count: entries.length, bytes: sum(entries), gone };
}

/** The object's file and manifest entry; null when it was deleted after it was listed. */
async function downloadObject(
  client: S3Client,
  bucket: string,
  key: string,
  dir: string,
  file: string,
): Promise<ManifestEntry | null> {
  let response;
  try {
    response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  } catch (error) {
    if (error instanceof NoSuchKey) return null;
    throw new Error(`could not read ${key}: ${message(error)}`, { cause: error });
  }
  if (!(response.Body instanceof Readable)) throw new Error(`could not read ${key}: no body`);
  const hash = createHash("sha256");
  let size = 0;
  try {
    await pipeline(
      response.Body,
      async function* (source: AsyncIterable<Buffer>) {
        for await (const chunk of source) {
          hash.update(chunk);
          size += chunk.length;
          yield chunk;
        }
      },
      // wx: never over a file that is already there.
      createWriteStream(path.join(dir, file), { flags: "wx", mode: 0o600 }),
    );
  } catch (error) {
    throw new Error(`could not read ${key}: ${message(error)}`, { cause: error });
  }
  if (response.ContentLength !== undefined && response.ContentLength !== size) {
    throw new Error(`could not read ${key}: got ${size} of ${response.ContentLength} bytes`);
  }
  return {
    key,
    file,
    size,
    contentType: response.ContentType ?? "application/octet-stream",
    sha256: hash.digest("hex"),
  };
}

/** Reads `dir`'s manifest; refuses a folder without one, or with one it cannot use. */
export async function readObjectManifest(dir: string): Promise<ObjectManifest> {
  let text: string;
  try {
    text = await readFile(path.join(dir, MANIFEST_FILE), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new Error(`${dir} has no ${MANIFEST_FILE}: not a complete object backup`, {
        cause: error,
      });
    }
    throw error;
  }
  let parsed;
  try {
    parsed = objectManifestSchema.safeParse(JSON.parse(text));
  } catch (error) {
    throw new Error(`${dir}/${MANIFEST_FILE} is not JSON`, { cause: error });
  }
  if (!parsed.success) throw new Error(`${dir}/${MANIFEST_FILE} is not an object backup manifest`);
  const keys = new Set<string>();
  for (const entry of parsed.data.objects) {
    if (keys.has(entry.key)) throw new Error(`${dir}/${MANIFEST_FILE} lists ${entry.key} twice`);
    keys.add(entry.key);
  }
  return parsed.data;
}

/**
 * Everything a restore can check before it changes anything: the
 * manifest, every file against it (a regular file, its size, its SHA-256),
 * that the instance has an object store when the backup holds objects, and
 * that the bucket answers. deploy/restore.sh runs it before it touches the
 * databases; restoreObjects runs it again.
 */
export async function checkObjectBackup(
  config: ObjectStoreConfig | null,
  dir: string,
  options: ObjectRestoreOptions = {},
): Promise<{ manifest: ObjectManifest; checked: CheckedEntry[] }> {
  const manifest = await readObjectManifest(dir);
  if (manifest.objects.length > 0 && config === null) {
    throw new Error(
      `the backup holds ${manifest.objects.length} objects (source maps and session replays), ` +
        "but no object store is set up (OBJECT_STORE_URL)",
    );
  }
  const checked = await mapLimit(manifest.objects, CONCURRENCY, (entry) => checkFile(dir, entry));
  if (config !== null && checked.length > 0) {
    await waitForBucket(config, options.bucketWaitMs ?? BUCKET_WAIT_MS);
  }
  return { manifest, checked };
}

/**
 * Puts every object of `dir`'s manifest back under its key and content
 * type, after checkObjectBackup, so a damaged backup changes nothing. An
 * object already in the store under the same key is replaced.
 */
export async function restoreObjects(
  config: ObjectStoreConfig | null,
  dir: string,
  options: ObjectRestoreOptions = {},
): Promise<ObjectRestoreSummary> {
  const { manifest, checked } = await checkObjectBackup(config, dir, options);
  if (config !== null && checked.length > 0) {
    const client = s3Client(config);
    try {
      await mapLimit(checked, CONCURRENCY, (entry) =>
        uploadObject(client, config.bucket, dir, entry, options.retryDelayMs),
      );
    } finally {
      client.destroy();
    }
  }
  return { count: checked.length, bytes: sum(checked), backupBucket: manifest.bucket };
}

async function checkFile(dir: string, entry: ManifestEntry): Promise<CheckedEntry> {
  const file = path.join(dir, entry.file);
  let info;
  try {
    info = await lstat(file);
  } catch (error) {
    throw new Error(`${entry.file} (${entry.key}) is missing`, { cause: error });
  }
  // lstat: a link is refused, never followed out of the folder.
  if (!info.isFile()) throw new Error(`${entry.file} (${entry.key}) is not a regular file`);
  if (info.size !== entry.size) {
    throw new Error(`${entry.file} (${entry.key}) has ${info.size} bytes, not ${entry.size}`);
  }
  const sha256 = createHash("sha256");
  const md5 = createHash("md5");
  for await (const chunk of createReadStream(file)) {
    sha256.update(chunk);
    md5.update(chunk);
  }
  if (sha256.digest("hex") !== entry.sha256) {
    throw new Error(`${entry.file} (${entry.key}) does not match its checksum`);
  }
  return { ...entry, md5: md5.digest("base64") };
}

/** Waits until the bucket answers, up to `waitMs`. */
async function waitForBucket(config: ObjectStoreConfig, waitMs: number): Promise<void> {
  const client = s3Client(config);
  const deadline = Date.now() + waitMs;
  try {
    for (;;) {
      try {
        await client.send(new HeadBucketCommand({ Bucket: config.bucket }));
        return;
      } catch (error) {
        if (Date.now() >= deadline) {
          throw new Error(
            `the bucket ${config.bucket} at ${config.url} did not answer: ${message(error)}`,
            { cause: error },
          );
        }
        await sleep(Math.min(2000, Math.max(0, deadline - Date.now())));
      }
    }
  } finally {
    client.destroy();
  }
}

/**
 * Uploads one checked file, streamed. Content-MD5 makes the store refuse
 * bytes that differ from the file that was checked (Amazon S3 and
 * Cloudflare R2 both document it on PutObject; R2 does not document
 * x-amz-checksum-sha256 there). A failure the store or the network may
 * not repeat is tried again, from a newly opened file; exported for tests.
 */
export async function uploadObject(
  client: S3Client,
  bucket: string,
  dir: string,
  entry: CheckedEntry,
  retryDelayMs = 500,
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await putFile(client, bucket, dir, entry);
      return;
    } catch (error) {
      if (attempt >= UPLOAD_ATTEMPTS || !retryable(error)) {
        throw new Error(`could not write ${entry.key}: ${message(error)}`, { cause: error });
      }
      await sleep(retryDelayMs * 2 ** (attempt - 1));
    }
  }
}

async function putFile(
  client: S3Client,
  bucket: string,
  dir: string,
  entry: CheckedEntry,
): Promise<void> {
  const put = (body: Uint8Array | PassThrough) =>
    client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: entry.key,
        Body: body,
        // A stream's length must be given: S3 does not take one without.
        ContentLength: entry.size,
        ContentType: entry.contentType,
        ContentMD5: entry.md5,
      }),
    );
  if (entry.size === 0) {
    await put(new Uint8Array());
    return;
  }
  // pipeline, so a read error ends the upload with that error.
  const body = new PassThrough();
  const reading = pipeline(createReadStream(path.join(dir, entry.file)), body);
  try {
    await Promise.all([put(body), reading]);
  } finally {
    body.destroy();
  }
}

/** Whether trying again may help: no answer, a server error, or too many requests. */
function retryable(error: unknown): boolean {
  if (!(error instanceof S3ServiceException)) return true;
  const status = error.$metadata.httpStatusCode;
  return status === undefined || status >= 500 || status === 429;
}

/** Runs `run` on every item, at most `limit` at a time; the results in order. */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = Array.from<R>({ length: items.length });
  // One iterator for all the workers: each item goes to one of them.
  const queue = items.entries();
  let failed = false;
  async function worker(): Promise<void> {
    for (const [index, item] of queue) {
      // After a failure, start nothing more.
      if (failed) return;
      try {
        results[index] = await run(item, index);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function sum(entries: readonly { size: number }[]): number {
  return entries.reduce((total, entry) => total + entry.size, 0);
}

function message(error: unknown): string {
  if (error instanceof S3ServiceException) {
    const status = error.$metadata.httpStatusCode;
    return `${error.name}${status === undefined ? "" : ` (${status})`}: ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}
