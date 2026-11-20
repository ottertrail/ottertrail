import { createHash, randomUUID } from "node:crypto";
import type { LookupAddress, LookupOptions } from "node:dns";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import { buffer } from "node:stream/consumers";

import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
  UploadPartCommand,
} from "@aws-sdk/client-s3";

import {
  type AddressPolicy,
  AddressNotAllowedError,
  type Lookup,
  refusedKind,
  resolveTarget,
} from "../outbound/addresses.ts";
import { codeOf } from "../outbound/request.ts";
import type { Destination } from "./settings.ts";

/**
 * Backups' S3 calls (docs/deployment.md, "Backups"): uploads streamed in
 * parts, the listing of the backups in their folder, deleting one backup's
 * folder, and Test connection. Every call stays under the destination's
 * folder: a backup is `<folder>/<UTC time>/<file>`, and nothing else is
 * listed or deleted.
 */

/** A backup's folder name: its UTC start time, "2026-11-20T030000Z". */
export const BACKUP_NAME = /^\d{4}-\d{2}-\d{2}T\d{6}Z$/;

export const MANIFEST_KEY = "manifest.json";

/** The folder name of a backup that starts at `at`. */
export function backupName(at: Date): string {
  return at
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z")
    .replaceAll(":", "");
}

/** The moment a folder name stands for; null when it is not one. */
export function backupTime(name: string): Date | null {
  if (!BACKUP_NAME.test(name)) return null;
  // "2026-11-20T030000Z" is "2026-11-20T03:00:00Z".
  const at = new Date(`${name.slice(0, 13)}:${name.slice(13, 15)}:${name.slice(15, 17)}Z`);
  return Number.isNaN(at.getTime()) ? null : at;
}

/**
 * Upload parts: 16 MiB each, the last one shorter. Every part but the last
 * has the same size, as Cloudflare R2 requires. S3 takes at most 10,000
 * parts, so one file may be up to 156 GiB.
 */
export const PART_BYTES = 16 * 1024 * 1024;
export const MAX_PARTS = 10_000;

/** The outbound address rules and the resolver, for an endpoint typed on the dashboard. */
export interface OutboundRules {
  policy: AddressPolicy;
  lookup: Lookup;
}

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

/**
 * A connection lookup that resolves the endpoint's host with the outbound
 * resolver and refuses an address the rules refuse (loopback, private,
 * metadata services, UPTIME_DENY_ADDRESSES), as webhooks do, checked on
 * every connection the client opens.
 */
function guardedLookup({ policy, lookup }: OutboundRules) {
  return (hostname: string, options: LookupOptions, callback: LookupCallback) => {
    const host = isIP(hostname) === 6 ? `[${hostname}]` : hostname;
    resolveTarget(new URL(`http://${host}/`), { lookup, policy, who: "backups" }).then(
      (target) => {
        if (options.all === true) callback(null, [target]);
        else callback(null, target.address, target.family);
      },
      (error: NodeJS.ErrnoException) => callback(error, ""),
    );
  };
}

/**
 * The S3 client for a destination. One typed on the dashboard follows the
 * outbound address rules: an IP address the rules refuse is refused here,
 * and a host name is checked on each connection.
 */
export function backupClient(destination: Destination, rules: OutboundRules): S3Client {
  const agents: { httpAgent?: http.Agent; httpsAgent?: https.Agent } = {};
  if (destination.fromDashboard) {
    const host = new URL(destination.url).hostname.replace(/^\[|\]$/g, "");
    if (isIP(host) !== 0) {
      const kind = refusedKind(host, rules.policy);
      if (kind !== null) throw new AddressNotAllowedError(host, host, kind, "backups");
    }
    const lookup = guardedLookup(rules);
    agents.httpAgent = new http.Agent({ keepAlive: true, lookup });
    agents.httpsAgent = new https.Agent({ keepAlive: true, lookup });
  }
  return new S3Client({
    endpoint: destination.url,
    region: destination.region,
    credentials: {
      accessKeyId: destination.accessKeyId,
      secretAccessKey: destination.secretAccessKey,
    },
    // The bucket in the path, as the object store's client does (storage/object-store.ts).
    forcePathStyle: true,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    requestHandler: {
      connectionTimeout: 5000,
      // Between bytes, not for the whole request: a large part may take minutes.
      requestTimeout: 120_000,
      throwOnRequestTimeout: true,
      ...agents,
    },
    // Parts are buffers, so the SDK can send one again.
    maxAttempts: 4,
  });
}

const md5 = (bytes: Uint8Array) => createHash("md5").update(bytes).digest("base64");

/** Puts a small object whole (the manifest, a connection test). */
export async function putObject(
  client: S3Client,
  bucket: string,
  key: string,
  body: Uint8Array,
  contentType: string,
  signal?: AbortSignal,
): Promise<void> {
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentLength: body.length,
      ContentType: contentType,
      ContentMD5: md5(body),
    }),
    { abortSignal: signal },
  );
}

/**
 * Uploads a stream of unknown length under `key`: one PutObject when it
 * fits in a part, else a multipart upload of PART_BYTES parts, each held
 * in memory only while it is sent. Each part carries its MD5, so the
 * store refuses bytes that changed on the way. A failure aborts the
 * multipart upload, so no part is left behind.
 */
export async function uploadStream(
  client: S3Client,
  bucket: string,
  key: string,
  source: AsyncIterable<Uint8Array>,
  signal?: AbortSignal,
): Promise<void> {
  let uploadId: string | undefined;
  const parts: { ETag: string; PartNumber: number }[] = [];
  let pending: Buffer[] = [];
  let pendingBytes = 0;

  async function sendPart(body: Buffer): Promise<void> {
    if (uploadId === undefined) {
      const created = await client.send(
        new CreateMultipartUploadCommand({
          Bucket: bucket,
          Key: key,
          ContentType: "application/octet-stream",
        }),
        { abortSignal: signal },
      );
      if (created.UploadId === undefined) throw new Error("the store started no upload");
      uploadId = created.UploadId;
    }
    const number = parts.length + 1;
    if (number > MAX_PARTS) {
      throw new Error(
        `file exceeds the S3 limit: ${MAX_PARTS} parts of ${PART_BYTES / 1024 ** 2} MiB`,
      );
    }
    const sent = await client.send(
      new UploadPartCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: number,
        Body: body,
        ContentLength: body.length,
        ContentMD5: md5(body),
      }),
      { abortSignal: signal },
    );
    if (sent.ETag === undefined) throw new Error(`the store did not confirm part ${number}`);
    parts.push({ ETag: sent.ETag, PartNumber: number });
  }

  try {
    for await (const chunk of source) {
      signal?.throwIfAborted();
      pending.push(Buffer.from(chunk));
      pendingBytes += chunk.length;
      while (pendingBytes >= PART_BYTES) {
        const joined = Buffer.concat(pending, pendingBytes);
        await sendPart(joined.subarray(0, PART_BYTES));
        pending = pendingBytes > PART_BYTES ? [joined.subarray(PART_BYTES)] : [];
        pendingBytes -= PART_BYTES;
      }
    }
    const rest = Buffer.concat(pending, pendingBytes);
    if (uploadId === undefined) {
      await putObject(client, bucket, key, rest, "application/octet-stream", signal);
      return;
    }
    if (rest.length > 0) await sendPart(rest);
    await client.send(
      new CompleteMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: { Parts: parts },
      }),
      { abortSignal: signal },
    );
  } catch (error) {
    if (uploadId !== undefined) {
      await client
        .send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId }))
        .catch(() => undefined);
    }
    throw error;
  }
}

/** An object's bytes as a stream; throws when it is missing. */
export async function getStream(
  client: S3Client,
  bucket: string,
  key: string,
  signal?: AbortSignal,
): Promise<{ body: Readable; size: number | null }> {
  const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }), {
    abortSignal: signal,
  });
  if (!(response.Body instanceof Readable)) throw new Error(`${key} has no body`);
  return { body: response.Body, size: response.ContentLength ?? null };
}

/** One backup in the destination's folder. */
export interface ListedBackup {
  /** Its folder name, the UTC start time. */
  name: string;
  at: Date;
  /** Its files' bytes together. */
  bytes: number;
  files: string[];
  /** It has its manifest, which is written last: a whole backup. */
  complete: boolean;
}

/** The longest listing read: 50 pages of 1,000 keys. */
const MAX_LIST_PAGES = 50;

/** The backups under `prefix`, newest first. Keys that are not a backup's are left alone. */
export async function listBackups(
  client: S3Client,
  bucket: string,
  prefix: string,
  signal?: AbortSignal,
): Promise<ListedBackup[]> {
  if (prefix === "") throw new Error("backups need a folder");
  const folder = `${prefix}/`;
  const found = new Map<string, ListedBackup>();
  let token: string | undefined;
  let pages = 0;
  do {
    const page = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: folder, ContinuationToken: token }),
      { abortSignal: signal },
    );
    for (const item of page.Contents ?? []) {
      const rest = item.Key?.slice(folder.length) ?? "";
      const slash = rest.indexOf("/");
      if (slash < 0) continue;
      const name = rest.slice(0, slash);
      const file = rest.slice(slash + 1);
      const at = backupTime(name);
      if (at === null || file === "" || file.includes("/")) continue;
      const backup = found.get(name) ?? { name, at, bytes: 0, files: [], complete: false };
      backup.bytes += item.Size ?? 0;
      backup.files.push(file);
      if (file === MANIFEST_KEY) backup.complete = true;
      found.set(name, backup);
    }
    token = page.IsTruncated === true ? page.NextContinuationToken : undefined;
    pages += 1;
  } while (token !== undefined && pages < MAX_LIST_PAGES);
  return [...found.values()].toSorted((a, b) => b.at.getTime() - a.at.getTime());
}

/**
 * Deletes one backup's files: only keys under `<prefix>/<name>/`, for a
 * name that is a backup's. Returns how many were deleted.
 */
export async function deleteBackup(
  client: S3Client,
  bucket: string,
  prefix: string,
  name: string,
  signal?: AbortSignal,
): Promise<number> {
  if (prefix === "" || !BACKUP_NAME.test(name)) {
    throw new Error(`refusing to delete outside the backups' folder: ${prefix}/${name}`);
  }
  const folder = `${prefix}/${name}/`;
  let deleted = 0;
  for (;;) {
    const page = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: folder, MaxKeys: 1000 }),
      { abortSignal: signal },
    );
    const keys = (page.Contents ?? []).flatMap((item) =>
      item.Key !== undefined && item.Key.startsWith(folder) ? [item.Key] : [],
    );
    if (keys.length === 0) return deleted;
    const result = await client.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: keys.map((key) => ({ Key: key })), Quiet: true },
      }),
      { abortSignal: signal },
    );
    const failed = result.Errors?.[0];
    if (failed !== undefined) {
      throw new Error(`could not delete ${failed.Key ?? "a file"}: ${failed.Code ?? "error"}`);
    }
    deleted += keys.length;
    if (page.IsTruncated !== true) return deleted;
  }
}

/** What each step of Test connection does, in the words of its refusal. */
const VERBS = { put: "write", list: "list", get: "read", delete: "delete" } as const;

export type ConnectionStep = keyof typeof VERBS;

export interface StepResult {
  step: ConnectionStep;
  status: "ok" | "failed" | "skipped";
  /** Why it failed, in plain words. */
  error?: string;
}

/**
 * Test connection: writes a small file under the folder, lists the
 * folder and finds it, reads it back, and deletes it. Each step says
 * whether it worked, and why not; steps after a failed write are skipped.
 */
export async function testConnection(
  client: S3Client,
  bucket: string,
  prefix: string,
  signal?: AbortSignal,
): Promise<StepResult[]> {
  const key = `${prefix}/ottertrail-connection-test-${randomUUID()}`;
  const body = Buffer.from(`Ottertrail connection test ${new Date().toISOString()}\n`);
  const results: StepResult[] = [];
  const failed = (step: ConnectionStep, error: unknown) =>
    results.push({ step, status: "failed", error: s3ErrorText(error, VERBS[step]) });

  try {
    await putObject(client, bucket, key, body, "text/plain", signal);
    results.push({ step: "put", status: "ok" });
  } catch (error) {
    failed("put", error);
    for (const step of ["list", "get", "delete"] as const)
      results.push({ step, status: "skipped" });
    return results;
  }
  try {
    const page = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: `${prefix}/`, MaxKeys: 1000 }),
      { abortSignal: signal },
    );
    const seen = (page.Contents ?? []).some((item) => item.Key === key);
    // A long folder may list the test file on a later page: a listing that answered is enough.
    if (!seen && page.IsTruncated !== true) {
      results.push({
        step: "list",
        status: "failed",
        error: "Test file missing from listing.",
      });
    } else {
      results.push({ step: "list", status: "ok" });
    }
  } catch (error) {
    failed("list", error);
  }
  try {
    const { body: stream } = await getStream(client, bucket, key, signal);
    if (!(await buffer(stream)).equals(body)) {
      results.push({
        step: "get",
        status: "failed",
        error: "Test file contents changed.",
      });
    } else {
      results.push({ step: "get", status: "ok" });
    }
  } catch (error) {
    failed("get", error);
  }
  try {
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }), {
      abortSignal: signal,
    });
    results.push({ step: "delete", status: "ok" });
  } catch (error) {
    failed("delete", error);
  }
  return results;
}

const DNS_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "ENODATA", "ESERVFAIL", "ECONNREFUSED_DNS"]);

/**
 * An S3 call's failure in plain words: what the store said, and what to
 * check. `verb` names what was refused ("write", "list"). Never holds a
 * key: S3's errors name none.
 */
export function s3ErrorText(error: unknown, verb = "use"): string {
  if (error instanceof AddressNotAllowedError) return error.message;
  if (error instanceof S3ServiceException) {
    const status = error.$metadata.httpStatusCode;
    const code = error.name;
    switch (code) {
      case "AccessDenied":
      case "Forbidden":
      case "AllAccessDisabled":
        return `Access denied (${code}). Give this key permission to ${verb} objects in the backup folder.`;
      case "NoSuchBucket":
        return "Bucket not found (NoSuchBucket). Check the name or create it.";
      case "InvalidAccessKeyId":
        return "Unknown access key ID (InvalidAccessKeyId). Check it.";
      case "SignatureDoesNotMatch":
        return "Secret access key mismatch (SignatureDoesNotMatch). Enter it again.";
      case "AuthorizationHeaderMalformed":
      case "PermanentRedirect":
      case "IllegalLocationConstraintException":
        return `Region mismatch (${code}). Check the region.`;
      case "InvalidBucketName":
        return "Invalid bucket name (InvalidBucketName).";
      case "NoSuchKey":
        return "File not found (NoSuchKey).";
      default: {
        const detail = error.message !== "" && error.message !== code ? `: ${error.message}` : "";
        return `Storage returned ${code}${status === undefined ? "" : ` (HTTP ${status})`}${detail}.`;
      }
    }
  }
  const code = codeOf(error);
  const name = error instanceof Error ? error.name : "";
  if (DNS_CODES.has(code)) {
    return `Can't resolve endpoint (${code}). Check the address.`;
  }
  if (code === "ECONNREFUSED") {
    return "Connection refused (ECONNREFUSED). Check the endpoint and port.";
  }
  if (code === "ETIMEDOUT" || name === "TimeoutError" || code === "ECONNRESET") {
    return `Endpoint timed out (${code || name}). Check the address and server connectivity.`;
  }
  if (code.startsWith("CERT_") || code.includes("SELF_SIGNED") || code.startsWith("UNABLE_TO_")) {
    return `Untrusted endpoint TLS certificate (${code}).`;
  }
  return error instanceof Error ? error.message : String(error);
}
