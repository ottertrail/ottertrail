import { randomBytes } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import { ProjectKeyCache } from "../src/collection/project-keys.ts";
import { insertProject } from "./helpers/projects.ts";
import { createTestDatabase, type TestDatabase } from "./helpers/test-database.ts";

let testDb: TestDatabase | undefined;

beforeAll(async () => {
  testDb = await createTestDatabase();
});

afterAll(async () => {
  await testDb?.destroy();
});

function db() {
  if (testDb === undefined) throw new Error("The test database was not created");
  return testDb.db;
}

/** The database, counting the queries the cache makes. */
function counting() {
  const counted = { queries: 0 };
  const proxy = new Proxy(db(), {
    get(target, property) {
      if (property === "selectFrom") counted.queries += 1;
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db: proxy, counted };
}

const madeUpKey = () => `pk_${randomBytes(16).toString("hex")}`;

async function newProject() {
  return insertProject(db(), { name: "Cached", allowed_hostnames: ["example.com"] });
}

async function moveTo(projectId: string, hostname: string) {
  await db()
    .updateTable("projects")
    .set({ allowed_hostnames: [hostname] })
    .where("id", "=", projectId)
    .execute();
}

describe("ProjectKeyCache", () => {
  test("keeps the most recently used keys: a hit refreshes its entry", async () => {
    const [a, b, c] = [await newProject(), await newProject(), await newProject()];
    const { db: database, counted } = counting();
    const cache = new ProjectKeyCache(database, { maxEntries: 2 });
    await cache.find(a.public_key);
    await cache.find(b.public_key);
    await cache.find(a.public_key);
    // c pushes out b, the least recently used, not a, the first in.
    await cache.find(c.public_key);
    expect(counted.queries).toBe(3);
    await cache.find(a.public_key);
    expect(counted.queries).toBe(3);
    await cache.find(b.public_key);
    expect(counted.queries).toBe(4);
  });

  test("keys no project has cannot push real projects out", async () => {
    const project = await newProject();
    const cache = new ProjectKeyCache(db(), { maxEntries: 2, maxUnknown: 5 });
    await cache.find(project.public_key);
    for (let i = 0; i < 50; i += 1) await cache.find(madeUpKey());
    await moveTo(project.id, "moved.example");
    expect((await cache.find(project.public_key))?.allowedHostnames).toEqual(["example.com"]);
  });

  test("remembers a key no project has for a shorter time than a known one", async () => {
    let now = 1_000_000;
    const { db: database, counted } = counting();
    const cache = new ProjectKeyCache(database, { now: () => now });
    const project = await newProject();
    const unknown = madeUpKey();
    await cache.find(unknown);
    await cache.find(project.public_key);
    expect(counted.queries).toBe(2);
    now += 5_000;
    await cache.find(unknown);
    expect(counted.queries).toBe(2);
    now += 6_000;
    await cache.find(unknown);
    await cache.find(project.public_key);
    // The unknown key was looked up again; the project was still cached.
    expect(counted.queries).toBe(3);
  });

  test("peekSecret answers from the cache alone: a project, null, or undefined when unknown", async () => {
    let now = 1_000_000;
    const { db: database, counted } = counting();
    const cache = new ProjectKeyCache(database, { now: () => now });
    const project = await newProject();
    const secret = (
      await db()
        .selectFrom("projects")
        .select("secret_key")
        .where("id", "=", project.id)
        .executeTakeFirstOrThrow()
    ).secret_key;
    const unknown = `sk_${randomBytes(16).toString("hex")}`;
    expect(cache.peekSecret(secret)).toBeUndefined();
    expect(cache.peekSecret(unknown)).toBeUndefined();
    await cache.findBySecret(secret);
    await cache.findBySecret(unknown);
    expect(cache.peekSecret(secret)?.id).toBe(project.id);
    expect(cache.peekSecret(unknown)).toBeNull();
    // Peeking never queries, and expired entries are not answered.
    expect(counted.queries).toBe(2);
    now += 61_000;
    expect(cache.peekSecret(secret)).toBeUndefined();
    expect(cache.peekSecret(unknown)).toBeUndefined();
  });

  test("concurrent misses for one key make one query", async () => {
    const project = await newProject();
    const { db: database, counted } = counting();
    const cache = new ProjectKeyCache(database);
    const found = await Promise.all(
      Array.from({ length: 5 }, () => cache.find(project.public_key)),
    );
    expect(found.map((entry) => entry?.id)).toEqual(Array.from({ length: 5 }, () => project.id));
    const unknown = madeUpKey();
    expect(await Promise.all([cache.find(unknown), cache.find(unknown)])).toEqual([null, null]);
    expect(counted.queries).toBe(2);
  });

  test("a failed lookup fails every request that shared it, caches nothing, and is tried again", async () => {
    const project = await newProject();
    let failing = true;
    let queries = 0;
    const flaky = new Proxy(db(), {
      get(target, property) {
        if (property === "selectFrom") {
          queries += 1;
          if (failing) {
            let fail!: (error: Error) => void;
            const result = new Promise((_resolve, reject) => {
              fail = reject;
            });
            // Fails once both requests wait on it.
            setTimeout(() => fail(new Error("the database is down")), 20);
            const chain = {
              select: () => chain,
              where: () => chain,
              executeTakeFirst: () => result,
            };
            return () => chain;
          }
        }
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const cache = new ProjectKeyCache(flaky);
    const results = await Promise.allSettled([
      cache.find(project.public_key),
      cache.find(project.public_key),
    ]);
    expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
    expect(queries).toBe(1);
    failing = false;
    expect((await cache.find(project.public_key))?.id).toBe(project.id);
    expect(queries).toBe(2);
  });

  test("a request after forgetProject does not share a lookup that was under way", async () => {
    const project = await newProject();
    const { db: database, counted } = counting();
    const cache = new ProjectKeyCache(database);
    const before = cache.find(project.public_key);
    cache.forgetProject(project.id);
    await moveTo(project.id, "moved.example");
    const after = cache.find(project.public_key);
    await before;
    expect((await after)?.allowedHostnames).toEqual(["moved.example"]);
    expect(counted.queries).toBe(2);
  });
});
