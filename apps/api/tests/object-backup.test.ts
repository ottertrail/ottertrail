import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import { HeadObjectCommand } from "@aws-sdk/client-s3";
import { afterAll, afterEach, describe, expect, test, vi } from "vite-plus/test";

import { LOCAL_OBJECT_STORE, type ObjectStoreConfig } from "../src/config.ts";
import {
  backupObjects,
  checkObjectBackup,
  MANIFEST_FILE,
  type ObjectManifest,
  restoreObjects,
  uploadObject,
} from "../src/storage/object-backup.ts";
import { s3Client, s3ObjectStore } from "../src/storage/object-store.ts";

// The development Garage from compose.yaml, as the API's tests use it. The
// bucket is shared with the dev server and other test files, so each test
// backs up only a prefix of its own.
const config = LOCAL_OBJECT_STORE;
const store = s3ObjectStore(config);
const client = s3Client(config);
const run = `tests/${randomUUID()}/`;
const folders: string[] = [];
/** A store nothing listens on: every request fails at once. */
const unreachable: ObjectStoreConfig = { ...config, url: "http://127.0.0.1:9" };
const bytes = (text: string) => new TextEncoder().encode(text);

async function folder(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "ottertrail-objects-"));
  folders.push(dir);
  return dir;
}

async function manifestOf(dir: string): Promise<ObjectManifest> {
  return JSON.parse(await readFile(path.join(dir, MANIFEST_FILE), "utf8")) as ObjectManifest;
}

async function contentTypeOf(key: string): Promise<string | undefined> {
  const head = await client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: key }));
  return head.ContentType;
}

/** Two objects under a prefix of their own, backed up, then deleted from the store. */
async function backedUp(name: string): Promise<{ dir: string; prefix: string }> {
  const prefix = `${run}${name}/`;
  await store.put(`${prefix}a.txt`, bytes("first file"), "text/plain");
  await store.put(`${prefix}b.txt`, bytes("second file"), "text/plain");
  const dir = await folder();
  await backupObjects(config, dir, { prefix });
  await store.deletePrefix(prefix);
  return { dir, prefix };
}

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await store.deletePrefix(run);
  store.close();
  client.destroy();
  await Promise.all(folders.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("backing up the object store", () => {
  test("round trip: every object comes back with its bytes and content type", async () => {
    const prefix = `${run}round-trip/`;
    const objects = [
      {
        key: `${prefix}replays/a.json.gz`,
        body: randomBytes(1024 ** 2 + 7),
        type: "application/gzip",
      },
      { key: `${prefix}maps/app.min.js.map`, body: randomBytes(300), type: "application/json" },
      { key: `${prefix}empty`, body: new Uint8Array(), type: "text/plain" },
      { key: `${prefix}odd name/ü ?#%.txt`, body: randomBytes(10), type: "text/plain" },
    ];
    for (const object of objects) await store.put(object.key, object.body, object.type);

    const dir = await folder();
    const summary = await backupObjects(config, dir, { prefix });
    expect(summary).toEqual({
      bucket: config.bucket,
      count: 4,
      bytes: objects.reduce((total, object) => total + object.body.length, 0),
      gone: [],
    });
    const manifest = await manifestOf(dir);
    expect(manifest.bucket).toBe(config.bucket);
    expect(manifest.objects.map((entry) => entry.key).toSorted()).toEqual(
      objects.map((object) => object.key).toSorted(),
    );
    for (const entry of manifest.objects) {
      expect(entry.file).toMatch(/^objects\/[0-9]+$/);
      const info = await stat(path.join(dir, entry.file));
      expect(info.size).toBe(entry.size);
      // Readable by the owner only: the objects, the folder, and the manifest.
      expect(info.mode & 0o777).toBe(0o600);
    }
    expect((await stat(path.join(dir, "objects"))).mode & 0o777).toBe(0o700);
    expect((await stat(path.join(dir, MANIFEST_FILE))).mode & 0o777).toBe(0o600);

    await store.deletePrefix(prefix);
    expect(await restoreObjects(config, dir)).toEqual({
      count: 4,
      bytes: summary.bytes,
      backupBucket: config.bucket,
    });
    for (const object of objects) {
      expect(Buffer.from((await store.get(object.key)) ?? [])).toEqual(Buffer.from(object.body));
      expect(await contentTypeOf(object.key)).toBe(object.type);
    }
  });

  test("lists past one page", async () => {
    const prefix = `${run}pages/`;
    const keys = Array.from({ length: 7 }, (_, index) => `${prefix}${index}.txt`);
    await Promise.all(keys.map((key) => store.put(key, bytes(key), "text/plain")));

    const dir = await folder();
    // Two keys per page: four pages.
    const summary = await backupObjects(config, dir, { prefix, pageSize: 2 });
    expect(summary.count).toBe(7);
    const manifest = await manifestOf(dir);
    expect(manifest.objects.map((entry) => entry.key)).toEqual(keys);
    expect(new Set(manifest.objects.map((entry) => entry.file)).size).toBe(7);
    expect(await readdir(path.join(dir, "objects"))).toHaveLength(7);
  });

  test("leaves out an object deleted between the listing and its read", async () => {
    const prefix = `${run}gone/`;
    await store.put(`${prefix}kept.txt`, bytes("kept"), "text/plain");
    await store.put(`${prefix}expired.txt`, bytes("expired"), "text/plain");

    const dir = await folder();
    const summary = await backupObjects(config, dir, {
      prefix,
      afterList: async () => store.delete([`${prefix}expired.txt`]),
    });
    expect(summary.count).toBe(1);
    expect(summary.gone).toEqual([`${prefix}expired.txt`]);
    expect((await manifestOf(dir)).objects.map((entry) => entry.key)).toEqual([
      `${prefix}kept.txt`,
    ]);
  });

  test("an empty bucket gives an empty manifest, which restores nothing", async () => {
    const dir = await folder();
    expect(await backupObjects(config, dir, { prefix: `${run}nothing/` })).toEqual({
      bucket: config.bucket,
      count: 0,
      bytes: 0,
      gone: [],
    });
    expect((await manifestOf(dir)).objects).toEqual([]);
    expect(await restoreObjects(config, dir)).toEqual({
      count: 0,
      bytes: 0,
      backupBucket: config.bucket,
    });
  });

  test("without an object store, the manifest says so, and restores nothing anywhere", async () => {
    const dir = await folder();
    expect(await backupObjects(null, dir)).toEqual({ bucket: null, count: 0, bytes: 0, gone: [] });
    const manifest = await manifestOf(dir);
    expect(manifest.bucket).toBeNull();
    expect(manifest.objects).toEqual([]);
    // Into an instance with a store, or without one: nothing to do either way.
    expect(await restoreObjects(config, dir)).toEqual({ count: 0, bytes: 0, backupBucket: null });
    expect(await restoreObjects(null, dir)).toEqual({ count: 0, bytes: 0, backupBucket: null });
  });

  test("a failed backup leaves no manifest", async () => {
    const dir = await folder();
    await expect(backupObjects(unreachable, dir)).rejects.toThrow("ECONNREFUSED");
    await expect(stat(path.join(dir, MANIFEST_FILE))).rejects.toThrow("ENOENT");
  });

  test("a listing that says it goes on, without a token, is an error", async () => {
    // A store that answers every listing so: no store does on purpose.
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "application/xml");
      response.end(
        '<?xml version="1.0" encoding="UTF-8"?>' +
          '<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">' +
          "<Name>ottertrail</Name><KeyCount>0</KeyCount><MaxKeys>1000</MaxKeys>" +
          "<IsTruncated>true</IsTruncated></ListBucketResult>",
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    try {
      const dir = await folder();
      await expect(
        backupObjects({ ...config, url: `http://127.0.0.1:${port}` }, dir),
      ).rejects.toThrow("gave no token to continue");
      await expect(stat(path.join(dir, MANIFEST_FILE))).rejects.toThrow("ENOENT");
    } finally {
      server.close();
    }
  });

  test("refuses a folder that is not empty", async () => {
    const dir = await folder();
    await writeFile(path.join(dir, "other.txt"), "x");
    await expect(backupObjects(config, dir, { prefix: `${run}nothing/` })).rejects.toThrow(
      "is not empty",
    );
  });
});

describe("restoring the object store", () => {
  test("refuses a folder without a manifest", async () => {
    const { dir } = await backedUp("no-manifest");
    await rm(path.join(dir, MANIFEST_FILE));
    await expect(restoreObjects(config, dir)).rejects.toThrow(
      `has no ${MANIFEST_FILE}: not a complete object backup`,
    );
  });

  test("checks every file against the manifest, and uploads nothing when one is wrong", async () => {
    const { dir, prefix } = await backedUp("checked");
    const [first, second] = (await manifestOf(dir)).objects;
    // Same size, other bytes: only the checksum tells.
    await writeFile(path.join(dir, second?.file ?? ""), "SECOND FILE");
    await expect(restoreObjects(config, dir)).rejects.toThrow("does not match its checksum");
    expect(await store.get(first?.key ?? "")).toBeNull();
    expect(await store.get(`${prefix}b.txt`)).toBeNull();

    await writeFile(path.join(dir, second?.file ?? ""), "longer than it was");
    await expect(restoreObjects(config, dir)).rejects.toThrow("has 18 bytes, not 11");

    await rm(path.join(dir, second?.file ?? ""));
    await expect(restoreObjects(config, dir)).rejects.toThrow("is missing");
  });

  test("refuses a link in place of a file, even to the right bytes", async () => {
    const { dir } = await backedUp("link");
    const [first] = (await manifestOf(dir)).objects;
    const file = path.join(dir, first?.file ?? "");
    const elsewhere = path.join(await folder(), "same bytes");
    await writeFile(elsewhere, await readFile(file));
    await rm(file);
    await symlink(elsewhere, file);
    await expect(restoreObjects(config, dir)).rejects.toThrow("is not a regular file");
  });

  test("refuses a manifest naming files outside its folder", async () => {
    const { dir } = await backedUp("outside");
    const manifest = await manifestOf(dir);
    const [first] = manifest.objects;
    if (first !== undefined) first.file = "../../etc/passwd";
    await writeFile(path.join(dir, MANIFEST_FILE), JSON.stringify(manifest));
    await expect(restoreObjects(config, dir)).rejects.toThrow("not an object backup manifest");
  });

  test("refuses objects when the instance has no object store", async () => {
    const { dir } = await backedUp("no-store");
    await expect(checkObjectBackup(null, dir)).rejects.toThrow(
      "the backup holds 2 objects (source maps and session replays), but no object store is set up",
    );
  });

  test("the check fails when the bucket does not answer", async () => {
    const { dir } = await backedUp("unreachable");
    await expect(checkObjectBackup(unreachable, dir, { bucketWaitMs: 500 })).rejects.toThrow(
      `the bucket ${config.bucket} at ${unreachable.url} did not answer`,
    );
  });

  test("the store refuses bytes that do not match the checked file's MD5", async () => {
    const { dir, prefix } = await backedUp("digest");
    const { checked } = await checkObjectBackup(config, dir);
    const [first] = checked;
    if (first === undefined) throw new Error("no object");
    const wrong = { ...first, md5: createHash("md5").update("other bytes").digest("base64") };
    // The store's own refusal (Garage: InvalidDigest, S3: BadDigest), not tried again.
    const send = vi.spyOn(client, "send");
    await expect(uploadObject(client, config.bucket, dir, wrong, 10)).rejects.toThrow(
      /could not write .*Digest/,
    );
    expect(send).toHaveBeenCalledTimes(1);
    send.mockRestore();
    expect(await store.get(`${prefix}a.txt`)).toBeNull();
    // The right one goes through.
    await uploadObject(client, config.bucket, dir, first, 10);
    expect(new TextDecoder().decode((await store.get(first.key)) ?? undefined)).toBe("first file");
  });

  test("tries an upload again, from the file, when the store does not answer", async () => {
    const { dir } = await backedUp("retried");
    const { checked } = await checkObjectBackup(config, dir);
    const [first] = checked;
    if (first === undefined) throw new Error("no object");
    const away = s3Client(unreachable);
    const send = vi.spyOn(away, "send");
    try {
      await expect(uploadObject(away, config.bucket, dir, first, 10)).rejects.toThrow(
        `could not write ${first.key}`,
      );
      expect(send).toHaveBeenCalledTimes(4);
    } finally {
      away.destroy();
    }
  });
});
