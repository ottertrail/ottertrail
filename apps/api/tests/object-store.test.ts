import { randomUUID } from "node:crypto";

import { afterAll, describe, expect, test } from "vite-plus/test";

import { LOCAL_OBJECT_STORE } from "../src/config.ts";
import { s3ObjectStore } from "../src/storage/object-store.ts";

// The development Garage from compose.yaml, as the API's tests use it.
const store = s3ObjectStore(LOCAL_OBJECT_STORE);
/** A prefix of this run's own, so runs and files do not meet. */
const run = `tests/${randomUUID()}/`;
const bytes = (text: string) => new TextEncoder().encode(text);
const text = (data: Uint8Array | null) => (data === null ? null : new TextDecoder().decode(data));

afterAll(async () => {
  await store.deletePrefix(run);
  store.close();
});

describe("the object store", () => {
  test("keeps what is put, and has nothing for an unknown key", async () => {
    await store.put(`${run}a.txt`, bytes("first"), "text/plain");
    expect(text(await store.get(`${run}a.txt`))).toBe("first");
    // Put again: replaced.
    await store.put(`${run}a.txt`, bytes("second"), "text/plain");
    expect(text(await store.get(`${run}a.txt`))).toBe("second");
    expect(await store.get(`${run}missing.txt`)).toBeNull();
  });

  test("deletes objects, and a missing one is no error", async () => {
    await store.put(`${run}b.txt`, bytes("b"), "text/plain");
    await store.delete([`${run}b.txt`, `${run}never-there.txt`]);
    expect(await store.get(`${run}b.txt`)).toBeNull();
  });

  test("deletes everything under a prefix, past one page of the listing", async () => {
    const prefix = `${run}many/`;
    const keys = Array.from({ length: 1005 }, (_, index) => `${prefix}${index}.txt`);
    // In groups, so the store is not asked a thousand things at once.
    for (let start = 0; start < keys.length; start += 100) {
      await Promise.all(
        keys.slice(start, start + 100).map((key) => store.put(key, bytes(key), "text/plain")),
      );
    }
    await store.put(`${run}kept.txt`, bytes("kept"), "text/plain");

    expect(await store.deletePrefix(prefix)).toBe(1005);
    expect(await store.get(keys[1004] ?? "")).toBeNull();
    expect(text(await store.get(`${run}kept.txt`))).toBe("kept");
  });
});
