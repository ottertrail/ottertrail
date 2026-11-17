import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

import type { ObjectStoreConfig } from "../config.ts";

/**
 * Files too large for the databases, such as source maps: in an
 * S3-compatible object store (Garage locally and when self-hosting,
 * Cloudflare R2 or Amazon S3 when hosted). Only the basic calls, which
 * every one of them answers alike. Keys are made by Ottertrail, never
 * taken from a request, and start with the project's ID, so a project's
 * files can be deleted together.
 */
export interface ObjectStore {
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  /** The object's bytes; null when there is none. */
  get(key: string): Promise<Uint8Array | null>;
  /** Deletes these objects; one that is not there is no error. */
  delete(keys: readonly string[]): Promise<void>;
  /** Deletes every object whose key starts with `prefix`; how many there were. */
  deletePrefix(prefix: string): Promise<number>;
  close(): void;
}

/** DeleteObjects takes at most this many keys. */
const DELETE_BATCH = 1000;

export function s3ObjectStore(config: ObjectStoreConfig): ObjectStore {
  const client = new S3Client({
    endpoint: config.url,
    region: config.region,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    // The bucket in the path, not in a host name: no DNS name per bucket.
    forcePathStyle: true,
    // Checksums only where S3 requires them: not every compatible store
    // checks the newer ones the SDK would add to every request.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    // A store that stops answering fails a request in seconds, not when the
    // system gives up on the connection: an error page then shows its stack
    // unmapped instead of waiting. Without throwOnRequestTimeout, a request
    // past its time is only logged.
    requestHandler: {
      connectionTimeout: 3000,
      requestTimeout: 30_000,
      throwOnRequestTimeout: true,
    },
    maxAttempts: 2,
  });
  const { bucket } = config;

  async function deleteKeys(keys: readonly string[]): Promise<void> {
    for (let start = 0; start < keys.length; start += DELETE_BATCH) {
      const batch = keys.slice(start, start + DELETE_BATCH);
      const result = await client.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: batch.map((key) => ({ Key: key })), Quiet: true },
        }),
      );
      const failed = result.Errors?.[0];
      if (failed !== undefined) {
        throw new Error(
          `could not delete ${failed.Key ?? "an object"}: ${failed.Code ?? "error"} ${failed.Message ?? ""}`,
        );
      }
    }
  }

  return {
    async put(key, body, contentType) {
      await client.send(
        new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }),
      );
    },

    async get(key) {
      try {
        const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        return result.Body === undefined ? null : await result.Body.transformToByteArray();
      } catch (error) {
        if (error instanceof NoSuchKey) return null;
        throw error;
      }
    },

    delete: deleteKeys,

    async deletePrefix(prefix) {
      let deleted = 0;
      let token: string | undefined;
      do {
        const page = await client.send(
          new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }),
        );
        const keys = (page.Contents ?? []).flatMap((item) =>
          item.Key === undefined ? [] : [item.Key],
        );
        await deleteKeys(keys);
        deleted += keys.length;
        token = page.IsTruncated === true ? page.NextContinuationToken : undefined;
      } while (token !== undefined);
      return deleted;
    },

    close() {
      client.destroy();
    },
  };
}
