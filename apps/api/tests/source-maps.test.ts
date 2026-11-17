import { randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";

import { TraceMap } from "@jridgewell/trace-mapping";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import { purgeDeletedProjects } from "../src/clickhouse/delete-events.ts";
import type { NewEvent } from "../src/collection/event-store.ts";
import { LOCAL_OBJECT_STORE } from "../src/config.ts";
import { fingerprint } from "../src/errors/fingerprint.ts";
import { SourceMapCache } from "../src/source-maps/resolve.ts";
import { MAX_MAP_LINES, MAX_MAP_SEGMENTS, objectKeyOf } from "../src/source-maps/source-maps.ts";
import { s3ObjectStore } from "../src/storage/object-store.ts";
import { PUBLIC_URL, signedInDashboard } from "./helpers/dashboard.ts";
import { insertProject } from "./helpers/projects.ts";

/** Noon on 17 November 2026 in UTC, the organization's timezone. */
const NOW = new Date("2026-11-17T12:00:00.000Z");

/**
 * src/cart.ts, minified to one line:
 *   function a(t){const e=t.items;return t.total.toFixed(2)}
 * A map written by hand: generated column 0 is the original's line 1,
 * column 0; column 37 ("t.total") is line 3, column 9 ("cart.total"), named
 * "cart". VLQ: "AAAA" for the first, "qCAESA" for the second (37 columns
 * on, the same source, 2 lines down, 9 columns on, name 0).
 */
const ORIGINAL = `export function renderCart(cart) {
  const items = cart.items;
  return cart.total.toFixed(2);
}
`;
const MAP = JSON.stringify({
  version: 3,
  file: "index-abc123.js",
  sources: ["webpack://shop/./src/cart.ts"],
  sourcesContent: [ORIGINAL],
  names: ["cart"],
  mappings: "AAAA,qCAESA",
});
const RELEASE = "1.4.2";
const FILE = "/assets/index-abc123.js";
/** The browser's frame: line 1, column 40 (from 1), inside "t.total". */
const STACK = `TypeError: Cannot read properties of undefined (reading 'toFixed')
    at a (https://shop.example${FILE}:1:40)
    at https://cdn.vendor.example/lib.js:3:7`;

// The development Garage from compose.yaml.
const store = s3ObjectStore(LOCAL_OBJECT_STORE);
let dashboard: Awaited<ReturnType<typeof signedInDashboard>>;
const projects: string[] = [];

async function newProject(name: string): Promise<{ id: string; secretKey: string }> {
  const { id } = await insertProject(dashboard.db, {
    organization_id: dashboard.organizationId,
    name,
  });
  projects.push(id);
  const { secret_key: secretKey } = await dashboard.db
    .selectFrom("projects")
    .select("secret_key")
    .where("id", "=", id)
    .executeTakeFirstOrThrow();
  return { id, secretKey };
}

interface UploadOptions {
  release?: string;
  path?: string;
  headers?: Record<string, string>;
}

function upload(
  secretKey: string,
  body: string | Buffer,
  { release = RELEASE, path = FILE, headers = {} }: UploadOptions = {},
) {
  return dashboard.app.inject({
    method: "PUT",
    url: `/api/source-maps?release=${encodeURIComponent(release)}&path=${encodeURIComponent(path)}`,
    headers: {
      authorization: `Bearer ${secretKey}`,
      "content-type": "application/json",
      ...headers,
    },
    payload: body,
  });
}

const dashboardGet = (projectId: string, path: string) =>
  dashboard.app.inject({
    url: `/api/projects/${projectId}${path}`,
    headers: { cookie: dashboard.cookie },
  });

function anError(stack: string, release: string | undefined): NewEvent {
  const error = { type: "TypeError", message: "Cannot read properties of undefined", stack };
  return {
    eventId: randomUUID(),
    name: "error",
    occurredAt: new Date(NOW.getTime() - 3_600_000),
    path: "/cart",
    visitorId: "1",
    ...(release === undefined ? {} : { release }),
    error: { ...error, handled: false, fingerprint: fingerprint(error) },
  };
}

/** The error detail's frames and source map status, for an error stored now. */
async function detailOf(projectId: string, event: NewEvent) {
  await dashboard.store(projectId, [event]);
  const group = event.error?.fingerprint ?? "";
  const response = await dashboardGet(projectId, `/errors/${group}?period=today`);
  expect(response.statusCode).toBe(200);
  return response.json();
}

beforeAll(async () => {
  dashboard = await signedInDashboard({
    now: () => NOW,
    sourceMaps: { store, limitBytes: 1024 ** 2 },
  });
});

afterAll(async () => {
  for (const id of projects) await store.deletePrefix(`source-maps/${id}/`);
  store.close();
  await dashboard?.close();
});

describe("uploading a source map", () => {
  test("stores it, compressed, under the project, and replaces it on a new upload", async () => {
    const project = await newProject("Uploads");
    const first = await upload(project.secretKey, MAP);
    expect(first.statusCode).toBe(201);
    expect(first.json().sourceMap).toMatchObject({ release: RELEASE, path: FILE });

    const stored = await store.get(objectKeyOf(project.id, RELEASE, FILE));
    expect(stored).not.toBeNull();

    // Again, gzip-compressed as a build tool may send it: replaced, 200.
    const again = await upload(project.secretKey, gzipSync(MAP), {
      headers: { "content-encoding": "gzip" },
    });
    expect(again.statusCode).toBe(200);

    const list = (await dashboardGet(project.id, "/source-maps")).json();
    expect(list.configured).toBe(true);
    expect(list.releases).toMatchObject([{ release: RELEASE, files: 1 }]);
    expect(list.organization.limitBytes).toBe(1024 ** 2);
    const files = (await dashboardGet(project.id, `/source-maps/files?release=${RELEASE}`)).json();
    expect(files.files).toMatchObject([{ path: FILE }]);
  });

  test("needs the project's secret key, never a public one", async () => {
    const project = await newProject("Keys");
    const { public_key: publicKey } = await dashboard.db
      .selectFrom("projects")
      .select("public_key")
      .where("id", "=", project.id)
      .executeTakeFirstOrThrow();
    for (const [authorization, error] of [
      [undefined, "unauthorized"],
      [`Bearer ${publicKey}`, "unauthorized"],
      [`Bearer sk_${"0".repeat(32)}`, "unknown_key"],
    ] as const) {
      const response = await dashboard.app.inject({
        method: "PUT",
        url: `/api/source-maps?release=${RELEASE}&path=${FILE}`,
        headers: {
          "content-type": "application/json",
          ...(authorization === undefined ? {} : { authorization }),
        },
        payload: MAP,
      });
      expect({ status: response.statusCode, error: response.json().error }).toEqual({
        status: 401,
        error,
      });
    }
  });

  test("refuses what is not a source map, or not for a file the browser loads", async () => {
    const project = await newProject("Refused");
    const cases: [string | Buffer, UploadOptions, number, string][] = [
      [MAP, { path: "assets/index.js" }, 400, "invalid_path"],
      [MAP, { path: "/assets/index.js?v=2" }, 400, "invalid_path"],
      [MAP, { path: "https://shop.example/assets/index.js" }, 400, "invalid_path"],
      // Not as a browser reports it: it would be stored, and never matched.
      [MAP, { path: "/assets/café.js" }, 400, "invalid_path"],
      [MAP, { path: "/assets/../index.js" }, 400, "invalid_path"],
      [MAP, { path: "//cdn.example/index.js" }, 400, "invalid_path"],
      // An index map: its offsets alone could take any amount of memory to read.
      [
        JSON.stringify({
          version: 3,
          sections: [
            {
              offset: { line: 5_000_000, column: 0 },
              map: { version: 3, sources: ["a"], names: [], mappings: "AAAA" },
            },
          ],
        }),
        {},
        400,
        "invalid_source_map",
      ],
      // Short, but each line and segment is an array once read.
      [
        JSON.stringify({ version: 3, sources: ["a"], mappings: ";".repeat(MAX_MAP_LINES) }),
        {},
        400,
        "invalid_source_map",
      ],
      [
        JSON.stringify({ version: 3, sources: ["a"], mappings: "A,".repeat(MAX_MAP_SEGMENTS) }),
        {},
        400,
        "invalid_source_map",
      ],
      ["", {}, 400, "invalid_source_map"],
      ["not json", {}, 400, "invalid_source_map"],
      [JSON.stringify({ version: 2, mappings: "", sources: [] }), {}, 400, "invalid_source_map"],
      [JSON.stringify({ version: 3, sources: [] }), {}, 400, "invalid_source_map"],
      [
        JSON.stringify({ version: 3, sources: ["a.ts"], mappings: "!!!!" }),
        {},
        400,
        "invalid_source_map",
      ],
      ["not gzip", { headers: { "content-encoding": "gzip" } }, 400, "invalid_gzip"],
      [MAP, { headers: { "content-encoding": "br" } }, 415, "unsupported_encoding"],
      // 26 MiB once unpacked, from a few kilobytes: refused while unpacking.
      [
        gzipSync(Buffer.alloc(26 * 1024 ** 2, 32)),
        { headers: { "content-encoding": "gzip" } },
        413,
        "too_large",
      ],
    ];
    for (const [body, options, status, error] of cases) {
      const response = await upload(project.secretKey, body, options);
      expect({ options, status: response.statusCode, error: response.json().error }).toEqual({
        options,
        status,
        error,
      });
    }
    const badRelease = await upload(project.secretKey, MAP, { release: "has space" });
    expect(badRelease.statusCode).toBe(400);
    const longPath = await upload(project.secretKey, MAP, { path: `/${"a".repeat(1024)}` });
    expect(longPath.statusCode).toBe(400);
    // No body, and no Content-Type: refused, not an error of the server.
    const empty = await dashboard.app.inject({
      method: "PUT",
      url: `/api/source-maps?release=${RELEASE}&path=${FILE}`,
      headers: { authorization: `Bearer ${project.secretKey}` },
    });
    expect([empty.statusCode, empty.json().error]).toEqual([400, "invalid_source_map"]);
    expect((await dashboardGet(project.id, "/source-maps")).json().releases).toEqual([]);
  });

  test("checks the key before reading the body", async () => {
    // Were the 26 MiB body read first, its size would be refused (413), not the key.
    const response = await upload(`sk_${"0".repeat(32)}`, Buffer.alloc(26 * 1024 ** 2, 32));
    expect([response.statusCode, response.json().error]).toEqual([401, "unknown_key"]);
  });

  test("keeps nothing for a project deleted while its key was still known", async () => {
    const project = await newProject("Deleted meanwhile");
    // The key is looked up and remembered, as for any upload.
    expect((await upload(project.secretKey, MAP, { path: "/first.js" })).statusCode).toBe(201);
    await dashboard.db.deleteFrom("projects").where("id", "=", project.id).execute();

    const late = await upload(project.secretKey, MAP, { path: "/second.js" });
    expect([late.statusCode, late.json().error]).toEqual([401, "unknown_key"]);
    expect(await store.get(objectKeyOf(project.id, RELEASE, "/second.js"))).toBeNull();
  });

  test("works on a few uploads at once, and asks the rest to try again", async () => {
    const busy = await signedInDashboard({
      now: () => NOW,
      sourceMaps: { store, limitBytes: 1024 ** 3, maxInFlight: 1 },
    });
    try {
      const { id } = await insertProject(busy.db, {
        organization_id: busy.organizationId,
        name: "Busy",
      });
      projects.push(id);
      const { secret_key: secretKey } = await busy.db
        .selectFrom("projects")
        .select("secret_key")
        .where("id", "=", id)
        .executeTakeFirstOrThrow();
      const responses = await Promise.all(
        ["/a.js", "/b.js", "/c.js"].map((path) =>
          busy.app.inject({
            method: "PUT",
            url: `/api/source-maps?release=${RELEASE}&path=${path}`,
            headers: { authorization: `Bearer ${secretKey}`, "content-type": "application/json" },
            payload: MAP,
          }),
        ),
      );
      const statuses = responses.map((response) => response.statusCode);
      expect(statuses).toContain(201);
      const refused = responses.find((response) => response.statusCode === 503);
      expect(refused?.json().error).toBe("busy");
      expect(refused?.headers["retry-after"]).toBe("2");
    } finally {
      await busy.close();
    }
  });

  test("stops at the organization's limit, but a replacement only counts once", async () => {
    const project = await newProject("Full");
    // Random hex: gzip halves it at best, so about 600 KB stored, and a
    // second file passes the 1 MiB limit.
    const big = JSON.stringify({
      version: 3,
      sources: ["a.ts"],
      sourcesContent: [randomHex(1_200_000)],
      names: [],
      mappings: "AAAA",
    });
    expect((await upload(project.secretKey, big, { path: "/a.js" })).statusCode).toBe(201);
    expect((await upload(project.secretKey, big, { path: "/a.js" })).statusCode).toBe(200);
    const over = await upload(project.secretKey, big, { path: "/b.js" });
    expect([over.statusCode, over.json().error]).toEqual([409, "storage_limit"]);
    // Refused before anything was stored.
    expect(await store.get(objectKeyOf(project.id, RELEASE, "/b.js"))).toBeNull();
  });
});

describe("the dashboard's list of a project's maps", () => {
  test("lists releases newest or oldest first, and how many there are in all", async () => {
    const project = await newProject("Releases");
    for (const release of ["1.0.0", "1.1.0", "1.2.0"]) {
      expect((await upload(project.secretKey, MAP, { release })).statusCode).toBe(201);
    }
    const newest = (await dashboardGet(project.id, "/source-maps")).json();
    expect(newest.releases.map((item: { release: string }) => item.release)).toEqual([
      "1.2.0",
      "1.1.0",
      "1.0.0",
    ]);
    expect(newest.totalReleases).toBe(3);
    const oldest = (await dashboardGet(project.id, "/source-maps?order=oldest")).json();
    expect(oldest.order).toBe("oldest");
    expect(oldest.releases[0].release).toBe("1.0.0");
  });
});

/** Text that gzip cannot shrink much: random hex. */
function randomHex(length: number): string {
  let text = "";
  while (text.length < length) text += randomUUID().replaceAll("-", "");
  return text.slice(0, length);
}

describe("an error's stack with source maps", () => {
  test("shows each frame a map covers at its original file, line, and code", async () => {
    const project = await newProject("Mapped");
    expect((await upload(project.secretKey, MAP)).statusCode).toBe(201);

    const body = await detailOf(project.id, anError(STACK, RELEASE));
    expect(body.sourceMaps).toEqual({ status: "applied", release: RELEASE, paths: [] });
    expect(body.frames).toEqual([
      {
        function: "a",
        file: `https://shop.example${FILE}`,
        line: 1,
        column: 40,
        original: {
          source: "src/cart.ts",
          line: 3,
          column: 10,
          name: "cart",
          context: {
            firstLine: 1,
            lines: [
              "export function renderCart(cart) {",
              "  const items = cart.items;",
              "  return cart.total.toFixed(2);",
              "}",
              "",
            ],
          },
        },
      },
      // Another site's script: no map of this project covers it.
      {
        function: "",
        file: "https://cdn.vendor.example/lib.js",
        line: 3,
        column: 7,
        original: null,
      },
    ]);
    // The stack as the browser wrote it stays.
    expect(body.stack).toBe(STACK);
  });

  test("says why when no map applies: no release, or none for its files", async () => {
    // Each its own project: the two errors would otherwise be one group.
    const [first, second] = [await newProject("No release"), await newProject("Other release")];
    expect((await upload(first.secretKey, MAP)).statusCode).toBe(201);
    expect((await upload(second.secretKey, MAP)).statusCode).toBe(201);

    const noRelease = await detailOf(first.id, anError(STACK, undefined));
    expect(noRelease.sourceMaps).toEqual({ status: "no_release", release: null, paths: [] });
    expect(noRelease.frames[0].original).toBeNull();

    const otherRelease = await detailOf(second.id, anError(STACK, "1.4.3"));
    expect(otherRelease.sourceMaps).toEqual({
      status: "no_maps",
      release: "1.4.3",
      paths: [FILE, "/lib.js"],
    });
  });

  test("says so when no frame is in a file, or the maps cover none of the frames", async () => {
    const [first, second] = [await newProject("Inline"), await newProject("Other build")];
    expect((await upload(second.secretKey, MAP)).statusCode).toBe(201);

    // Only a script written into the page, and the browser's own code.
    const inline = await detailOf(
      first.id,
      anError("Error: boom\n    at <anonymous>:1:5\n    at native", RELEASE),
    );
    expect(inline.sourceMaps).toEqual({ status: "no_files", release: RELEASE, paths: [] });

    // Line 7 of a file whose map has one line: a map of another build.
    const elsewhere = await detailOf(
      second.id,
      anError(`TypeError: x\n    at a (https://shop.example${FILE}:7:3)`, RELEASE),
    );
    expect(elsewhere.sourceMaps).toEqual({ status: "not_mapped", release: RELEASE, paths: [FILE] });
  });

  test("an install without an object store says so", async () => {
    const plain = await signedInDashboard({ now: () => NOW });
    try {
      const { id } = await insertProject(plain.db, {
        organization_id: plain.organizationId,
        name: "Plain",
      });
      const event = anError(STACK, RELEASE);
      await plain.store(id, [event]);
      const body = (
        await plain.app.inject({
          url: `/api/projects/${id}/errors/${event.error?.fingerprint ?? ""}?period=today`,
          headers: { cookie: plain.cookie },
        })
      ).json();
      expect(body.sourceMaps.status).toBe("not_configured");
      const list = await plain.app.inject({
        url: `/api/projects/${id}/source-maps`,
        headers: { cookie: plain.cookie },
      });
      expect(list.json().configured).toBe(false);
    } finally {
      await plain.close();
    }
  });
});

describe("deleting source maps", () => {
  test("deletes a release's maps from the store, from the dashboard only", async () => {
    const project = await newProject("Deleted");
    expect((await upload(project.secretKey, MAP)).statusCode).toBe(201);
    const remove = (origin: string) =>
      dashboard.app.inject({
        method: "DELETE",
        url: `/api/projects/${project.id}/source-maps?release=${RELEASE}`,
        headers: { cookie: dashboard.cookie, origin },
      });

    expect((await remove("https://evil.example")).statusCode).toBe(403);
    expect((await remove(PUBLIC_URL)).statusCode).toBe(204);
    expect(await store.get(objectKeyOf(project.id, RELEASE, FILE))).toBeNull();
    expect((await dashboardGet(project.id, "/source-maps")).json().releases).toEqual([]);
    const again = await remove(PUBLIC_URL);
    expect([again.statusCode, again.json().error]).toEqual([404, "no_source_maps"]);
  });

  test("a deleted project's maps leave the store with its events", async () => {
    const project = await newProject("Gone");
    expect((await upload(project.secretKey, MAP)).statusCode).toBe(201);
    await dashboard.db.deleteFrom("projects").where("id", "=", project.id).execute();

    // While the object store is down, the deletion waits for the next run.
    const unreachable = s3ObjectStore({ ...LOCAL_OBJECT_STORE, url: "http://127.0.0.1:1" });
    try {
      await expect(
        purgeDeletedProjects(dashboard.db, dashboard.reader.client, unreachable),
      ).rejects.toThrow(/ECONNREFUSED/);
    } finally {
      unreachable.close();
    }
    const pending = await dashboard.db
      .selectFrom("project_deletions")
      .select("project_id")
      .execute();
    expect(pending.map((row) => row.project_id)).toContain(project.id);

    const purged = await purgeDeletedProjects(dashboard.db, dashboard.reader.client, store);
    // Its map, and any of other projects deleted in these tests.
    expect(purged.files).toBeGreaterThanOrEqual(1);
    expect(await store.get(objectKeyOf(project.id, RELEASE, FILE))).toBeNull();
  });
});

/** A cache entry of `bytes`, around an empty map. */
const entry = (bytes: number) => ({
  map: new TraceMap({ version: 3, sources: [], names: [], mappings: "" }),
  bytes,
  lines: new Map<string, string[]>(),
});

describe("the cache of maps read", () => {
  test("counts a map stored twice under one key once", () => {
    const cache = new SourceMapCache(100);
    cache.set("a", entry(40));
    // Two pages that missed the same map at once both store it.
    cache.set("a", entry(40));
    expect(cache.bytes).toBe(40);
    cache.set("b", entry(50));
    expect(cache.get("a")).toBeDefined();
    expect(cache.get("b")).toBeDefined();
  });

  test("lets the least recently used maps go past its size, and keeps none too large", () => {
    const cache = new SourceMapCache(100);
    cache.set("a", entry(40));
    cache.set("b", entry(40));
    cache.get("a");
    cache.set("c", entry(40));
    expect([cache.get("a"), cache.get("b"), cache.get("c")].map(Boolean)).toEqual([
      true,
      false,
      true,
    ]);
    cache.set("huge", entry(101));
    expect(cache.get("huge")).toBeUndefined();
    expect(cache.bytes).toBe(80);
  });
});
