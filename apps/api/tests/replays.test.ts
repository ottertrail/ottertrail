import { randomBytes, randomUUID } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";

import { InsertQueryNode, type KyselyPlugin } from "kysely";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import { purgeDeletedProjects } from "../src/clickhouse/delete-events.ts";
import { LOCAL_OBJECT_STORE } from "../src/config.ts";
import { fingerprint } from "../src/errors/fingerprint.ts";
import {
  closeRecording,
  deleteExpiredReplays,
  deleteJoinedChunks,
  deleteProjectReplays,
  joinChunks,
  joinReplays,
  MAX_CHUNKS,
  MAX_REPLAY_BYTES,
  MAX_REPLAY_EVENTS,
  replayKeyOf,
  storeChunk,
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

/** A recording of `count` events, as one chunk. */
const recordingOf = (count: number) => [
  gzipSync(
    JSON.stringify({
      v: 1,
      events: Array.from({ length: count }, () => ({ type: 3, timestamp: 1 })),
    }),
  ),
];

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
  {
    last = false,
    cut = false,
    headers = {},
    app = dashboard.app,
    remoteAddress,
  }: SendOptions & { remoteAddress?: string } = {},
) {
  return app.inject({
    ...(remoteAddress === undefined ? {} : { remoteAddress }),
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
    expect([again.statusCode, again.json()]).toEqual([202, { received: 1 }]);
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
    // The validator's own words are not for callers who are not signed in.
    const invalid = await send(project.public_key, replay, MAX_CHUNKS, gzipSync("x"));
    expect(invalid.json().message).toBe(
      "The request is not a replay chunk: check its query (key, replay, seq, last, cut).",
    );
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
    // The same answer as a chunk stored: a sender never learns a filter caught it.
    expect([bot.statusCode, bot.json()]).toEqual([202, { received: 1 }]);
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

  test("stops a replay that would unpack past 16 MiB, however well it compresses", async () => {
    const project = await newProject("Unpacked");
    const replay = randomUUID();
    // A megabyte of spaces is about a kilobyte of gzip: 16 of them pass, the 17th does not.
    const chunk = gzipSync(Buffer.alloc(1_000_000, 32));
    // An address of its own, so the address's limit is not this file's other tests'.
    const remoteAddress = "198.51.100.16";
    for (let seq = 0; seq < 16; seq += 1) {
      expect(
        (await send(project.public_key, replay, seq, chunk, { remoteAddress })).statusCode,
      ).toBe(202);
    }
    const refused = await send(project.public_key, replay, 16, chunk, { remoteAddress });
    expect([refused.statusCode, refused.json().error]).toEqual([413, "replay_too_large"]);
    expect(refused.json().message).toBe(
      "A replay unpacks to at most 16 MiB. Its chunks so far are kept; later ones are not.",
    );
    expect(await chunkCount(project.id, replay)).toBe("16");
  });

  test("limits an IPv6 network as one address, and chunks in progress", async () => {
    const limited = await signedInDashboard({
      objectStore: store,
      replays: { limitBytes: 1024 ** 3, ipLimit: { capacity: 1, refillPerSecond: 0.001 } },
    });
    try {
      const project = await newProject("One network", "errors", limited.db);
      const from = (remoteAddress: string) =>
        send(project.public_key, randomUUID(), 0, gzipSync("x"), {
          app: limited.app,
          remoteAddress,
        });
      expect((await from("2001:db8:5:6::1")).statusCode).toBe(202);
      expect((await from("2001:db8:5:6::2")).statusCode).toBe(429);
      expect((await from("2001:db8:5:7::1")).statusCode).toBe(202);
    } finally {
      await limited.close();
    }

    // At most 8 of one project's chunks at once, and 16 of all.
    const one = await newProject("Many chunks");
    const many = await Promise.all(
      Array.from({ length: 9 }, () =>
        send(one.public_key, randomUUID(), 0, gzipSync("x"), { remoteAddress: "198.51.100.8" }),
      ),
    );
    expect(many.filter((response) => response.statusCode === 429)).toHaveLength(1);
    const others = await Promise.all(["A", "B", "C"].map((name) => newProject(`Busy ${name}`)));
    const all = await Promise.all(
      Array.from({ length: 17 }, (_, index) =>
        send(others[index % 3]?.public_key ?? "", randomUUID(), 0, gzipSync("x"), {
          remoteAddress: "198.51.100.17",
        }),
      ),
    );
    const busy = all.filter((response) => response.statusCode === 503);
    expect(busy.map((response) => response.json().error)).toEqual(["busy"]);
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

/** Fails the first insert into replays with this PostgreSQL code, as pg reports one. */
function failingOnce(code: string): KyselyPlugin {
  let failed = false;
  return {
    transformQuery: ({ node }) => {
      if (!failed && InsertQueryNode.is(node) && node.into?.table.identifier.name === "replays") {
        failed = true;
        throw Object.assign(new Error(`a PostgreSQL error ${code}`), { code });
      }
      return node;
    },
    transformResult: async ({ result }) => result,
  };
}

/** The IDs of a project's joined replays. */
const insertedOf = async (projectId: string) =>
  (
    await dashboard.db
      .selectFrom("replays")
      .select("replay_id")
      .where("project_id", "=", projectId)
      .execute()
  ).map((row) => row.replay_id);

/** A new project with two whole replays sent. */
const pair = async (name: string) => {
  const project = await newProject(name);
  const replays = [randomUUID(), randomUUID()];
  // One chunk each: the tests share the address's rate.
  for (const replay of replays) await sendRecording(project.public_key, replay, RECORDING, 1);
  return { project, replays };
};

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

  test("drops a recording whose times are not a clock's; the rest of the batch is joined", async () => {
    const project = await newProject("Far future");
    const [farOff, negative, other] = [randomUUID(), randomUUID(), randomUUID()];
    const events = JSON.parse(RECORDING).events as { timestamp: number }[];
    const at = (timestamp: number) =>
      JSON.stringify({
        v: 1,
        events: events.map((event, index) => (index === 2 ? { ...event, timestamp } : event)),
      });
    await sendRecording(project.public_key, farOff, at(1e20), 1);
    await sendRecording(project.public_key, negative, at(-1), 1);
    await sendRecording(project.public_key, other, RECORDING, 1);

    const result = await joinReplays(dashboard.db, store, { onlyProjectId: project.id });
    expect(result).toEqual({ joined: 1, dropped: 2, failed: 0 });
    for (const replay of [farOff, negative]) {
      expect(await chunkCount(project.id, replay)).toBe("0");
      expect(await store.get(replayKeyOf(project.id, replay))).toBeNull();
    }
    expect(await chunkCount(project.id, other)).toBe("1");
    expect(await store.get(replayKeyOf(project.id, other))).not.toBeNull();
  });

  test("one replay's error is its own: dropped when it is the data's, kept when it may pass", async () => {
    // Out of range (22003): the same on every run, so dropped; the other is joined.
    const data = await pair("Data error");
    const errors: { dropped: boolean }[] = [];
    const dropped = await joinReplays(dashboard.db.withPlugin(failingOnce("22003")), store, {
      onlyProjectId: data.project.id,
      onError: (_error, replay) => errors.push(replay),
    });
    expect(dropped).toEqual({ joined: 1, dropped: 1, failed: 0 });
    expect(errors).toMatchObject([{ projectId: data.project.id, dropped: true }]);
    const [joinedData] = await insertedOf(data.project.id);
    const droppedData = data.replays.find((replay) => replay !== joinedData) ?? "";
    expect(await chunkCount(data.project.id, droppedData)).toBe("0");
    // Its object, written before the row was refused, went with it.
    expect(await store.get(replayKeyOf(data.project.id, droppedData))).toBeNull();

    // The connection lost (08006): its chunks wait, and the next run joins it.
    const lost = await pair("Connection lost");
    const failed = await joinReplays(dashboard.db.withPlugin(failingOnce("08006")), store, {
      onlyProjectId: lost.project.id,
    });
    expect(failed).toMatchObject({ joined: 1, dropped: 0, failed: 1 });
    expect(String(failed.firstError)).toContain("08006");
    expect(await joinReplays(dashboard.db, store, { onlyProjectId: lost.project.id })).toEqual({
      joined: 1,
      dropped: 0,
      failed: 0,
    });
    expect((await insertedOf(lost.project.id)).toSorted()).toEqual(lost.replays.toSorted());

    // Node's coded errors are the join's own (ERR_OUT_OF_RANGE): dropped; a
    // system error (ECONNRESET) may pass: kept.
    for (const [code, outcome] of [
      ["ERR_OUT_OF_RANGE", { joined: 1, dropped: 1, failed: 0 }],
      ["ECONNRESET", { joined: 1, dropped: 0, failed: 1 }],
    ] as const) {
      const coded = await pair(code);
      expect(
        await joinReplays(dashboard.db.withPlugin(failingOnce(code)), store, {
          onlyProjectId: coded.project.id,
        }),
      ).toMatchObject(outcome);
    }
  });

  test("a replay another run recorded meanwhile is not dropped by a run that failed on it", async () => {
    const project = await newProject("Overlapping runs");
    const replay = randomUUID();
    await sendRecording(project.public_key, replay, RECORDING, 1);
    // While this run writes the object, another run joins the replay and
    // commits; then this run's row is refused as the data's.
    let other: Awaited<ReturnType<typeof joinReplays>> | undefined;
    const overlapping: ObjectStore = {
      put: async (objectKey, body, contentType) => {
        other ??= await joinReplays(dashboard.db, store, { onlyProjectId: project.id });
        await store.put(objectKey, body, contentType);
      },
      get: (objectKey) => store.get(objectKey),
      delete: (keys) => store.delete(keys),
      deletePrefix: (prefix) => store.deletePrefix(prefix),
      close: () => undefined,
    };
    const result = await joinReplays(dashboard.db.withPlugin(failingOnce("22003")), overlapping, {
      onlyProjectId: project.id,
    });
    expect(other).toEqual({ joined: 1, dropped: 0, failed: 0 });
    expect(result).toEqual({ joined: 0, dropped: 0, failed: 0 });
    // The other run's replay stands: its row, its object, and its chunks.
    expect(await insertedOf(project.id)).toEqual([replay]);
    expect(await store.get(replayKeyOf(project.id, replay))).not.toBeNull();
    expect(await chunkCount(project.id, replay)).toBe("1");
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
    expect(late.json()).toEqual({ received: 1 });
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

  test("joins the oldest replays first", async () => {
    const project = await newProject("Oldest first");
    const chunk = { seq: 0, last: true, cut: false, data: gzipSync(RECORDING) };
    const newer = Array.from({ length: 5 }, () => randomUUID());
    for (const replayId of newer) {
      await storeChunk(dashboard.db, project, { ...chunk, replayId }, 1024 ** 3);
    }
    const older = randomUUID();
    await storeChunk(
      dashboard.db,
      project,
      { ...chunk, replayId: older, receivedAt: new Date(Date.now() - 60_000) },
      1024 ** 3,
    );
    await joinReplays(dashboard.db, store, { limit: 1, onlyProjectId: project.id });
    const joined = await dashboard.db
      .selectFrom("replays")
      .select("replay_id")
      .where("project_id", "=", project.id)
      .execute();
    expect(joined.map((row) => row.replay_id)).toEqual([older]);
  });

  test("gives up a recording of too many events", () => {
    expect(joinChunks(recordingOf(MAX_REPLAY_EVENTS))).not.toBeNull();
    expect(joinChunks(recordingOf(MAX_REPLAY_EVENTS + 1))).toBeNull();
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
    expect(await sendRecording(project.public_key, replay)).toEqual([202, 202, 202]);

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
    // Never 'self' for styles, images, or fonts: a forged recording could send
    // cookie-bearing GETs to the API. packages/replay-player's browser tests
    // run under the same directives.
    expect(policy).toBe(
      [
        "default-src 'none'",
        "script-src 'self'",
        "connect-src 'self'",
        "style-src 'unsafe-inline' https://shop.example:* http://shop.example:*",
        "img-src data: blob: https://shop.example:* http://shop.example:*",
        "font-src data: https://shop.example:* http://shop.example:*",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'self'",
      ].join("; "),
    );
    expect(response.body).toContain(
      `data-replay-url="/api/projects/${project.id}/replays/${replay}"`,
    );
    expect(response.body).toContain('data-error-at="1700000000000"');
    expect(response.body).toContain('<script src="/replay-player.js" defer></script>');
    // The player's theme: the dashboard's, dark unless it asks for light.
    expect(response.body).toContain('<html lang="en" data-theme="dark">');
    const light = await get(`${project.id}/replays/${replay}/player?theme=light`);
    expect(light.body).toContain('<html lang="en" data-theme="light">');
    expect(light.body).toContain('<meta name="color-scheme" content="light" />');
    // Only what the page checked goes into it.
    expect((await get(`${project.id}/replays/${replay}/player?errorAt=<script>`)).statusCode).toBe(
      400,
    );
    expect((await get(`${project.id}/replays/${replay}/player?theme=<b>`)).statusCode).toBe(400);
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
