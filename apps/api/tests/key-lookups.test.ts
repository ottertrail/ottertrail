import { describe, expect, test } from "vite-plus/test";

import type { CollectingProject, ProjectKeyCache } from "../src/collection/project-keys.ts";
import { BUSY, SecretKeyLookups } from "../src/telemetry/key-lookups.ts";

/**
 * The queue for secret-key lookups the cache lacks (telemetry/key-lookups.ts;
 * docs/telemetry.md, "Answers"), with a fake cache whose lookups wait
 * until the test lets them finish.
 */
function fakeCache(cached: Record<string, CollectingProject | null> = {}) {
  const held: { key: string; finish: (project: CollectingProject | null) => void }[] = [];
  let queries = 0;
  const projects = {
    peekSecret: (key: string) => cached[key],
    findBySecret: async (key: string) => {
      queries += 1;
      return new Promise<CollectingProject | null>((resolve) => {
        held.push({ key, finish: resolve });
      });
    },
  } as unknown as ProjectKeyCache;
  return { projects, held, queries: () => queries };
}

const PROJECT = { id: "0b0e5f1e-8a4e-4e43-9b0a-1f0c5d3e7a11" } as CollectingProject;

describe("secret-key lookups", () => {
  test("a key the cache holds is answered at once, a project's or none", async () => {
    const { projects, queries } = fakeCache({ sk_real: PROJECT, sk_none: null });
    const lookups = new SecretKeyLookups({ max: 0, maxWaiting: 0 });
    expect(await lookups.find(projects, "sk_real", "a")).toBe(PROJECT);
    expect(await lookups.find(projects, "sk_none", "a")).toBeNull();
    expect(queries()).toBe(0);
  });

  test("two lookups an address, and requests with the same key share one", async () => {
    const { projects, held, queries } = fakeCache();
    const lookups = new SecretKeyLookups({ max: 4 });
    const first = lookups.find(projects, "sk_1", "192.0.2.1");
    const shared = lookups.find(projects, "sk_1", "192.0.2.1");
    const second = lookups.find(projects, "sk_2", "192.0.2.1");
    expect(await lookups.find(projects, "sk_3", "192.0.2.1")).toBe(BUSY);
    expect(queries()).toBe(2);
    for (const { finish } of held) finish(null);
    expect(await Promise.all([first, shared, second])).toEqual([null, null, null]);
    // Given back.
    const third = lookups.find(projects, "sk_3", "192.0.2.1");
    held.at(-1)?.finish(PROJECT);
    expect(await third).toBe(PROJECT);
  });

  test("a lookup waits at most its limit for a place, then is BUSY", async () => {
    const { projects, held } = fakeCache();
    const lookups = new SecretKeyLookups({ max: 1, maxWaitMs: 20 });
    const running = lookups.find(projects, "sk_1", "a");
    const waiting = lookups.find(projects, "sk_2", "b");
    expect(lookups.waiting).toBe(1);
    expect(await waiting).toBe(BUSY);
    expect(lookups.waiting).toBe(0);
    held[0]?.finish(null);
    expect(await running).toBeNull();
    // Its address is free again, and the place too.
    const again = lookups.find(projects, "sk_2", "b");
    held.at(-1)?.finish(PROJECT);
    expect(await again).toBe(PROJECT);
  });

  test("a waiting lookup whose requests all disconnected gives up its turn; a shared one does not", async () => {
    const { projects, held, queries } = fakeCache();
    const lookups = new SecretKeyLookups({ max: 1, maxPerAddress: 1 });
    const running = lookups.find(projects, "sk_1", "a");
    const alone = new AbortController();
    const left = lookups.find(projects, "sk_2", "b", alone.signal);
    const goes = new AbortController();
    const shared = lookups.find(projects, "sk_3", "c", goes.signal);
    const stays = lookups.find(projects, "sk_3", "d");
    expect(lookups.waiting).toBe(2);
    alone.abort();
    goes.abort();
    expect(await left).toBe(BUSY);
    expect(lookups.waiting).toBe(1);
    // Its address can look up again at once.
    const retry = lookups.find(projects, "sk_2", "b");
    expect(lookups.waiting).toBe(2);
    held[0]?.finish(null);
    expect(await running).toBeNull();
    await expect.poll(() => held.length).toBe(2);
    held[1]?.finish(PROJECT);
    expect(await Promise.all([shared, stays])).toEqual([PROJECT, PROJECT]);
    await expect.poll(() => held.length).toBe(3);
    held[2]?.finish(null);
    expect(await retry).toBeNull();
    expect(queries()).toBe(3);
  });
});
