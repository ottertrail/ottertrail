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
 * Generate keys internally and group them by project so project deletion
 * can remove its files together.
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

/** Share client settings with backup commands (object-backup.ts). */
export function s3Client(config: ObjectStoreConfig): S3Client {
  return new S3Client({
    endpoint: config.url,
    region: config.region,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    // Path-style buckets avoid needing DNS names per bucket.
    forcePathStyle: true,
    // Some S3-compatible stores do not support the SDK's newer optional checksums.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    // Bound stalled requests so error pages can show unmapped stacks promptly.
    // throwOnRequestTimeout is required; otherwise the SDK only logs timeouts.
    requestHandler: {
      connectionTimeout: 3000,
      requestTimeout: 30_000,
      throwOnRequestTimeout: true,
    },
    maxAttempts: 2,
  });
}

export function s3ObjectStore(config: ObjectStoreConfig): ObjectStore {
  const client = s3Client(config);
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
