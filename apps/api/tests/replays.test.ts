import { randomBytes, randomUUID } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";

import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import { purgeDeletedProjects } from "../src/clickhouse/delete-events.ts";
import { LOCAL_OBJECT_STORE } from "../src/config.ts";
import { fingerprint } from "../src/errors/fingerprint.ts";
import {
  closeRecording,
  deleteExpiredReplays,
  deleteJoinedChunks,
  deleteProjectReplays,
  joinReplays,
  MAX_CHUNKS,
  MAX_REPLAY_BYTES,
  replayKeyOf,
} from "../src/replays/replays.ts";
import { type ObjectStore, s3ObjectStore } from "../src/storage/object-store.ts";
import { PUBLIC_URL, signedInDashboard } from "./helpers/dashboard.ts";
import { insertProject } from "./helpers/projects.ts";

// The development Garage from compose.yaml.
const store = s3ObjectStore(LOCAL_OBJECT_STORE);
const ORIGIN = "https://shop.example";
const CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";

let dashboard: Awaited<ReturnType<typeof signedInDashboard>>;
const projects: string[] = [];

/** A recording as the recorder sends it, joined: a full snapshot, then a click. */
const RECORDING = JSON.stringify({
  v: 1,
  events: [
    {
      type: 4,
      timestamp: 1_000,
      data: { href: "https://shop.example/cart", width: 800, height: 600 },
    },
    { type: 2, timestamp: 1_001, data: { node: { type: 0, childNodes: [], id: 1 } } },
    { type: 3, timestamp: 1_500, data: { source: 2, type: 2, id: 1 } },
  ],
});

/** The recording cut into `pieces` pieces of text, each one gzip member, as the recorder sends them. */
function chunksOf(text: string, pieces: number): Buffer[] {
  const size = Math.ceil(text.length / pieces);
  return Array.from({ length: pieces }, (_, index) =>
    gzipSync(text.slice(index * size, (index + 1) * size)),
  );
}

async function newProject(
  name: string,
  replayMode: "off" | "errors" = "errors",
  db = dashboard.db,
) {
  const project = await insertProject(db, {
    name,
    allowed_hostnames: ["shop.example"],
    replay_mode: replayMode,
  });
  projects.push(project.id);
  return project;
}

interface SendOptions {
  last?: boolean;
  cut?: boolean;
  headers?: Record<string, string>;
  app?: typeof dashboard.app;
}

function send(
  key: string,
  replay: string,
  seq: number,
  body: Buffer | string,
  { last = false, cut = false, headers = {}, app = dashboard.app }: SendOptions = {},
) {
  return app.inject({
    method: "POST",
    url: `/api/replays?key=${key}&replay=${replay}&seq=${seq}&last=${last ? 1 : 0}&cut=${cut ? 1 : 0}`,
    headers: {
      "content-type": "text/plain;charset=UTF-8",
      origin: ORIGIN,
      "user-agent": CHROME,
      ...headers,
    },
    payload: body,
  });
}

/** Sends a whole recording, as chunks, and returns their statuses. */
async function sendRecording(key: string, replay: string, text = RECORDING, pieces = 3) {
  const chunks = chunksOf(text, pieces);
  const statuses = [];
  for (const [seq, chunk] of chunks.entries()) {
    statuses.push(
      (await send(key, replay, seq, chunk, { last: seq === chunks.length - 1 })).statusCode,
    );
  }
  return statuses;
}

const chunkCount = async (projectId: string, replayId: string) =>
  (
    await dashboard.db
      .selectFrom("replay_chunks")
      .select((eb) => eb.fn.countAll<string>().as("count"))
      .where("project_id", "=", projectId)
      .where("replay_id", "=", replayId)
      .executeTakeFirstOrThrow()
  ).count;

beforeAll(async () => {
  dashboard = await signedInDashboard({
    objectStore: store,
    replays: { limitBytes: 1024 ** 3 },
  });
});

afterAll(async () => {
  for (const id of projects) await store.deletePrefix(`replays/${id}/`);
  store.close();
  await dashboard?.close();
});

describe("collecting a replay's chunks", () => {
  test("keeps each chunk once, for a project that takes replays", async () => {
    const project = await newProject("Shop");
    const replay = randomUUID();
    expect(await sendRecording(project.public_key, replay)).toEqual([202, 202, 202]);
    // A retry: kept once.
    const again = await send(project.public_key, replay, 0, chunksOf(RECORDING, 3)[0] ?? "");
    expect([again.statusCode, again.json()]).toEqual([202, { stored: 0 }]);
    expect(await chunkCount(project.id, replay)).toBe("3");
    // The page may read every answer.
    expect(again.headers["access-control-allow-origin"]).toBe(ORIGIN);
  });

  test("is off until the project takes replays, and without an object store", async () => {
    const off = await newProject("Off", "off");
    const refused = await send(off.public_key, randomUUID(), 0, gzipSync("x"));
    expect([refused.statusCode, refused.json().error]).toEqual([403, "replay_off"]);

    const plain = await signedInDashboard();
    try {
      const project = await insertProject(plain.db, {
        name: "No store",
        allowed_hostnames: ["shop.example"],
        replay_mode: "errors",
      });
      const noStore = await send(project.public_key, randomUUID(), 0, gzipSync("x"), {
        app: plain.app,
      });
      expect([noStore.statusCode, noStore.json().error]).toEqual([403, "replay_off"]);
    } finally {
      await plain.close();
    }
  });

  test("turning replays on is a project setting, from the dashboard", async () => {
    const project = await newProject("Setting", "off");
    const patch = (body: object) =>
      dashboard.app.inject({
        method: "PATCH",
        url: `/api/projects/${project.id}`,
        headers: { cookie: dashboard.cookie, origin: PUBLIC_URL },
        payload: body,
      });
    expect((await patch({ replayMode: "always" })).statusCode).toBe(400);
    const on = await patch({ replayMode: "errors" });
    expect(on.json().project.replayMode).toBe("errors");
    // At once: collection forgets the project's cached settings.
    expect((await send(project.public_key, randomUUID(), 0, gzipSync("x"))).statusCode).toBe(202);
  });

  test("refuses what is not a chunk, or not from the project's sites", async () => {
    const project = await newProject("Refusals");
    const replay = randomUUID();
    const cases: [
      Promise<{ statusCode: number; json: () => { error: string } }>,
      number,
      string,
    ][] = [
      [send(`pk_${"0".repeat(32)}`, replay, 0, gzipSync("x")), 403, "unknown_key"],
      [
        send(project.public_key, replay, 0, gzipSync("x"), {
          headers: { origin: "https://evil.example" },
        }),
        403,
        "origin_not_allowed",
      ],
      [send(project.public_key, replay, 0, "not gzip"), 400, "invalid_request"],
      [send(project.public_key, replay, 0, ""), 400, "invalid_request"],
      [send(project.public_key, replay, MAX_CHUNKS, gzipSync("x")), 400, "invalid_request"],
      // A few kilobytes that unpack to 2 MiB.
      [
        send(project.public_key, replay, 0, gzipSync(Buffer.alloc(2 * 1024 ** 2, 32))),
        413,
        "payload_too_large",
      ],
      [send(project.public_key, replay, 0, randomBytes(70 * 1024)), 413, "payload_too_large"],
    ];
    for (const [response, status, error] of cases) {
      const answered = await response;
      expect({ status: answered.statusCode, error: answered.json().error }).toEqual({
        status,
        error,
      });
    }
    // The last number a chunk may have is stored: the table's check agrees with MAX_CHUNKS.
    const lastAllowed = randomUUID();
    expect(
      (await send(project.public_key, lastAllowed, MAX_CHUNKS - 1, gzipSync("x"))).statusCode,
    ).toBe(202);
    expect(await chunkCount(project.id, lastAllowed)).toBe("1");
    expect(await chunkCount(project.id, replay)).toBe("0");
  });

  test("accepts and ignores a bot's", async () => {
    const project = await newProject("Bots");
    const replay = randomUUID();
    const bot = await send(project.public_key, replay, 0, gzipSync("x"), {
      headers: { "user-agent": "Googlebot/2.1 (+http://www.google.com/bot.html)" },
    });
    expect([bot.statusCode, bot.json()]).toEqual([202, { stored: 0 }]);
    expect(await chunkCount(project.id, replay)).toBe("0");
  });

  test("stops a replay past 2 MB, and a new one past the instance's storage", async () => {
    const project = await newProject("Large");
    const replay = randomUUID();
    // Random bytes do not shrink: each chunk about 60 KB.
    let status = 202;
    let seq = 0;
    for (; status === 202 && seq < 49; seq += 1) {
      status = (await send(project.public_key, replay, seq, gzipSync(randomBytes(60_000))))
        .statusCode;
    }
    expect(status).toBe(413);
    // What was kept stays within the limit; the chunk that would pass it was refused.
    const kept = await dashboard.db
      .selectFrom("replay_chunks")
      .select((eb) => eb.fn.sum<string>(eb.fn("octet_length", ["data"])).as("bytes"))
      .where("project_id", "=", project.id)
      .where("replay_id", "=", replay)
      .executeTakeFirstOrThrow();
    expect(Number(kept.bytes)).toBeLessThanOrEqual(MAX_REPLAY_BYTES);
    expect(Number(kept.bytes)).toBeGreaterThan(MAX_REPLAY_BYTES - 61_000);
    expect(seq).toBeLessThan(49);

    const full = await signedInDashboard({ objectStore: store, replays: { limitBytes: 1024 } });
    try {
      const small = await newProject("Full", "errors", full.db);
      const first = await send(small.public_key, randomUUID(), 0, gzipSync(randomBytes(2000)), {
        app: full.app,
      });
      expect(first.statusCode).toBe(202);
      // The limit is passed: a new replay is refused, so the page stops sending it.
      const second = await send(small.public_key, randomUUID(), 0, gzipSync("x"), {
        app: full.app,
      });
      expect([second.statusCode, second.json().error]).toEqual([403, "replay_storage_full"]);
    } finally {
      await full.close();
    }
  });

  test("spends the project's own budget, in bytes, apart from events'", async () => {
    const tight = await signedInDashboard({
      objectStore: store,
      replays: { limitBytes: 1024 ** 3, projectLimit: { capacity: 100, refillPerSecond: 1 } },
    });
    try {
      const project = await newProject("Budget", "errors", tight.db);
      const replay = randomUUID();
      const statuses = [];
      for (let seq = 0; seq < 3; seq += 1) {
        statuses.push(
          (
            await send(project.public_key, replay, seq, gzipSync(randomBytes(60_000)), {
              app: tight.app,
            })
          ).statusCode,
        );
      }
      expect(statuses).toContain(429);
    } finally {
      await tight.close();
    }
  });
});

describe("joining a replay's chunks", () => {
  test("a replay the store refuses waits for the next run; the rest of the batch is joined", async () => {
    const project = await newProject("Refused");
    const refusedReplay = randomUUID();
    const otherReplay = randomUUID();
    await sendRecording(project.public_key, refusedReplay);
    await sendRecording(project.public_key, otherReplay);
    // As Garage refuses a write past the bucket's quota.
    const refusing: ObjectStore = {
      put: async (objectKey, body, contentType) => {
        if (objectKey.includes(refusedReplay)) throw new Error("Bucket size quota is reached");
        await store.put(objectKey, body, contentType);
      },
      get: (objectKey) => store.get(objectKey),
      delete: (keys) => store.delete(keys),
      deletePrefix: (prefix) => store.deletePrefix(prefix),
      close: () => undefined,
    };
    const joinedOf = () =>
      dashboard.db
        .selectFrom("replays")
        .select("replay_id")
        .where("project_id", "=", project.id)
        .execute()
        .then((rows) => rows.map((row) => row.replay_id));

    const first = await joinReplays(dashboard.db, refusing, { onlyProjectId: project.id });
    expect(first).toMatchObject({ joined: 1, failed: 1 });
    expect(String(first.firstError)).toContain("Bucket size quota is reached");
    expect(await joinedOf()).toEqual([otherReplay]);
    // Its chunks wait.
    const waiting = await dashboard.db
      .selectFrom("replay_chunks")
      .select("seq")
      .where("replay_id", "=", refusedReplay)
      .execute();
    expect(waiting.length).toBeGreaterThan(0);

    // Once the store takes it again.
    expect(await joinReplays(dashboard.db, store, { onlyProjectId: project.id })).toEqual({
      joined: 1,
      dropped: 0,
      failed: 0,
    });
    expect((await joinedOf()).toSorted()).toEqual([refusedReplay, otherReplay].toSorted());
  });

  test("joins a complete replay into one object, and deletes its chunks later", async () => {
    const project = await newProject("Joined");
    const replay = randomUUID();
    await sendRecording(project.public_key, replay);

    const result = await joinReplays(dashboard.db, store);
    expect(result.joined).toBeGreaterThanOrEqual(1);
    const row = await dashboard.db
      .selectFrom("replays")
      .selectAll()
      .where("project_id", "=", project.id)
      .where("replay_id", "=", replay)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({ object_key: replayKeyOf(project.id, replay), cut: false });
    const object = await store.get(row.object_key);
    expect(gunzipSync(object ?? Buffer.alloc(0)).toString()).toBe(RECORDING);

    // Kept an hour, for retries; a late one is a duplicate.
    expect(await deleteJoinedChunks(dashboard.db)).toBe(0);
    const late = await send(project.public_key, replay, 1, chunksOf(RECORDING, 3)[1] ?? "");
    expect(late.json()).toEqual({ stored: 0 });
    expect(
      await deleteJoinedChunks(dashboard.db, { now: new Date(Date.now() + 2 * 3_600_000) }),
    ).toBeGreaterThanOrEqual(3);
    expect(await chunkCount(project.id, replay)).toBe("0");
  });

  test("keeps the start of a replay whose end never came, and waits for a late chunk", async () => {
    const project = await newProject("Partial");
    const [gap, quiet, notJson] = [randomUUID(), randomUUID(), randomUUID()];
    // Each piece ends just inside an event: what came is cut to its last whole event.
    const [second, third] = [RECORDING.indexOf('{"type":2'), RECORDING.indexOf('{"type":3')];
    const pieces = [
      RECORDING.slice(0, second + 5),
      RECORDING.slice(second + 5, third + 5),
      RECORDING.slice(third + 5),
    ].map((piece) => gzipSync(piece));
    // Chunk 1 has not come yet, though the last has.
    await send(project.public_key, gap, 0, pieces[0] ?? "");
    await send(project.public_key, gap, 2, pieces[2] ?? "", { last: true });
    // Only the first chunk: the visitor left at once.
    await send(project.public_key, quiet, 0, pieces[0] ?? "");
    // Gzip, but not a recording.
    await send(project.public_key, notJson, 0, gzipSync('{"v":1,"events":"no"}'), { last: true });

    // Soon after: the missing chunk may still come, so nothing is joined or dropped.
    await joinReplays(dashboard.db, store);
    expect(await chunkCount(project.id, gap)).toBe("2");
    expect(await store.get(replayKeyOf(project.id, gap))).toBeNull();

    // Quiet for longer than a replay waits: what came in order is kept, cut.
    await joinReplays(dashboard.db, store, { now: new Date(Date.now() + 10 * 60_000) });
    for (const replay of [gap, quiet]) {
      const row = await dashboard.db
        .selectFrom("replays")
        .select("cut")
        .where("project_id", "=", project.id)
        .where("replay_id", "=", replay)
        .executeTakeFirstOrThrow();
      expect(row.cut).toBe(true);
      const object = await store.get(replayKeyOf(project.id, replay));
      const kept = JSON.parse(gunzipSync(object ?? Buffer.alloc(0)).toString());
      // The Meta event, the first: whole in the first piece.
      expect(kept).toEqual({ v: 1, events: [JSON.parse(RECORDING).events[0]] });
    }
    // Not a recording: given up.
    expect(await chunkCount(project.id, notJson)).toBe("0");
    expect(await store.get(replayKeyOf(project.id, notJson))).toBeNull();
  });

  test("deletes replays past their 30 days, and a deleted project's", async () => {
    const [old, gone] = [await newProject("Old"), await newProject("Gone")];
    const [first, second] = [randomUUID(), randomUUID()];
    await sendRecording(old.public_key, first);
    await sendRecording(gone.public_key, second);
    await joinReplays(dashboard.db, store);

    expect(
      await deleteExpiredReplays(dashboard.db, store, {
        now: new Date(Date.now() + 31 * 86_400_000),
      }),
    ).toBeGreaterThanOrEqual(1);
    expect(await store.get(replayKeyOf(old.id, first))).toBeNull();

    await sendRecording(gone.public_key, randomUUID());
    await joinReplays(dashboard.db, store);
    await dashboard.db.deleteFrom("projects").where("id", "=", gone.id).execute();
    const purged = await purgeDeletedProjects(dashboard.db, dashboard.reader.client, store);
    expect(purged.files).toBeGreaterThanOrEqual(1);
    const rows = await dashboard.db
      .selectFrom("replays")
      .select("replay_id")
      .where("project_id", "=", gone.id)
      .execute();
    expect(rows).toEqual([]);
  });
});

describe("deleting a project's replays while one is joined", () => {
  test("waits for the join, then deletes what it wrote", async () => {
    const project = await newProject("Deleted while joining");
    const replay = randomUUID();
    const key = replayKeyOf(project.id, replay);
    await sendRecording(project.public_key, replay);

    // A store that holds this replay's upload until the test lets it go.
    let uploading!: () => void;
    const started = new Promise<void>((resolve) => {
      uploading = resolve;
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow: ObjectStore = {
      put: async (objectKey, body, contentType) => {
        if (objectKey === key) {
          uploading();
          await held;
        }
        await store.put(objectKey, body, contentType);
      },
      get: (objectKey) => store.get(objectKey),
      delete: (keys) => store.delete(keys),
      deletePrefix: (prefix) => store.deletePrefix(prefix),
      close: () => undefined,
    };

    const joining = joinReplays(dashboard.db, slow);
    await started;
    let deleted = false;
    const deleting = deleteProjectReplays(dashboard.db, store, project.id).then(() => {
      deleted = true;
    });
    // The deletion waits for the project's row, which the join holds.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(deleted).toBe(false);

    release();
    await Promise.all([joining, deleting]);
    expect(await store.get(key)).toBeNull();
    expect(
      await dashboard.db
        .selectFrom("replays")
        .select("replay_id")
        .where("project_id", "=", project.id)
        .execute(),
    ).toEqual([]);
    expect(
      await dashboard.db
        .selectFrom("replay_chunks")
        .select("seq")
        .where("project_id", "=", project.id)
        .execute(),
    ).toEqual([]);
  });
});

describe("an error's replay", () => {
  test("is named by the error event, and kept with it", async () => {
    const project = await newProject("Linked");
    const replayId = randomUUID();
    const response = await dashboard.app.inject({
      method: "POST",
      url: "/api/events",
      headers: { "content-type": "text/plain", origin: ORIGIN, "user-agent": CHROME },
      payload: JSON.stringify({
        v: 1,
        key: project.public_key,
        sentAt: Date.now(),
        events: [
          {
            id: randomUUID(),
            name: "error",
            occurredAt: Date.now(),
            url: "https://shop.example/cart",
            error: {
              type: "TypeError",
              message: "x is undefined",
              handled: false,
              replayId: replayId.toUpperCase(),
            },
          },
        ],
      }),
    });
    expect(response.statusCode).toBe(202);
    // In ClickHouse, which the error page reads, in lower case.
    const stored = await dashboard.reader.client.query({
      query:
        "SELECT toString(replay_id) AS replay_id FROM events FINAL WHERE project_id = {project:UUID}",
      query_params: { project: project.id },
      format: "JSONEachRow",
    });
    expect(await stored.json()).toEqual([{ replay_id: replayId }]);
  });
});

/** A GET of a project route from the dashboard, signed in. */
const get = (url: string) =>
  dashboard.app.inject({ url: `/api/projects/${url}`, headers: { cookie: dashboard.cookie } });

describe("replays in the dashboard", () => {
  test("each occurrence says whether its replay is ready, coming, or missing", async () => {
    const project = await newProject("Occurrences");
    const [ready, coming, lost] = [randomUUID(), randomUUID(), randomUUID()];
    await sendRecording(project.public_key, ready);
    await joinReplays(dashboard.db, store);
    const error = { type: "TypeError", message: "x is undefined", handled: false };
    const occurrence = (replayId: string, minutesAgo: number) => ({
      eventId: randomUUID(),
      name: "error",
      occurredAt: new Date(Date.now() - minutesAgo * 60_000),
      path: "/cart",
      visitorId: "1",
      error: { ...error, fingerprint: fingerprint(error), replayId },
    });
    await dashboard.store(project.id, [
      occurrence(ready, 30),
      occurrence(coming, 1),
      occurrence(lost, 60),
    ]);

    // Seven days, not today: an hour ago is yesterday just after midnight.
    const body = (await get(`${project.id}/errors/${fingerprint(error)}?period=7d`)).json();
    const byId = Object.fromEntries(
      body.occurrences.map((item: { replay: { id: string; status: string } }) => [
        item.replay.id,
        item.replay.status,
      ]),
    );
    expect(byId).toEqual({ [ready]: "ready", [coming]: "pending", [lost]: "missing" });
  });

  test("serves a replay's recording, compressed, to the project's members", async () => {
    const project = await newProject("Served");
    const replay = randomUUID();
    await sendRecording(project.public_key, replay);
    await joinReplays(dashboard.db, store);

    const response = await get(`${project.id}/replays/${replay}`);
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-encoding"]).toBe("gzip");
    expect(response.headers["content-type"]).toMatch(/^application\/json/);
    expect(gunzipSync(response.rawPayload).toString()).toBe(RECORDING);
    expect((await get(`${project.id}/replays/${randomUUID()}`)).statusCode).toBe(404);
  });

  test("plays it in a page that loads only the project's own sites' files", async () => {
    const project = await newProject("Player");
    const replay = randomUUID();
    const response = await get(`${project.id}/replays/${replay}/player?errorAt=1700000000000`);
    expect(response.statusCode).toBe(200);
    const policy = response.headers["content-security-policy"];
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("script-src 'self'");
    expect(policy).toContain(
      "img-src 'self' data: blob: https://shop.example:* http://shop.example:*",
    );
    expect(policy).toContain("frame-ancestors 'self'");
    expect(policy).not.toMatch(/script-src[^;]*unsafe/);
    expect(response.body).toContain(
      `data-replay-url="/api/projects/${project.id}/replays/${replay}"`,
    );
    expect(response.body).toContain('data-error-at="1700000000000"');
    expect(response.body).toContain('<script src="/replay-player.js" defer></script>');
    // Only what the page checked goes into it.
    expect((await get(`${project.id}/replays/${replay}/player?errorAt=<script>`)).statusCode).toBe(
      400,
    );
  });

  test("sums up the project's replays, and deletes them all on request", async () => {
    const project = await newProject("Summary");
    const replay = randomUUID();
    await sendRecording(project.public_key, replay);
    await joinReplays(dashboard.db, store);

    const summary = (await get(`${project.id}/replays`)).json();
    expect(summary).toMatchObject({ configured: true, mode: "errors", replays: { count: 1 } });
    expect(summary.instance.limitBytes).toBe(1024 ** 3);

    const remove = (origin: string) =>
      dashboard.app.inject({
        method: "DELETE",
        url: `/api/projects/${project.id}/replays`,
        headers: { cookie: dashboard.cookie, origin },
      });
    expect((await remove("https://evil.example")).statusCode).toBe(403);
    expect((await remove(PUBLIC_URL)).statusCode).toBe(204);
    expect(await store.get(replayKeyOf(project.id, replay))).toBeNull();
    expect((await get(`${project.id}/replays`)).json().replays).toEqual({ count: 0, bytes: 0 });
  });
});

describe("closing a recording whose end never came", () => {
  test("cuts after the last whole event, outside strings", () => {
    const events = [
      { type: 4, timestamp: 1, data: { href: "https://shop.example/a}b" } },
      { type: 3, timestamp: 2, data: { text: 'quote " and } brace and \\ backslash' } },
    ];
    const whole = JSON.stringify({ v: 1, events });
    // Cut inside the second event's string.
    const start = whole.slice(0, whole.indexOf("brace") + 2);
    expect(JSON.parse(closeRecording(start) ?? "null")).toEqual({ v: 1, events: [events[0]] });
    // Cut right after the second event.
    const both = whole.slice(0, -2);
    expect(JSON.parse(closeRecording(both) ?? "null")).toEqual({ v: 1, events });
    // Nothing whole yet.
    expect(closeRecording('{"v":1,"events":[{"type":4,')).toBeNull();
  });
});
