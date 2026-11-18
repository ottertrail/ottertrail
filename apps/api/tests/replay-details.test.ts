import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import { LOCAL_OBJECT_STORE } from "../src/config.ts";
import { fingerprint } from "../src/errors/fingerprint.ts";
import { CLOCK_TOLERANCE_MS } from "../src/replays/derive.ts";
import { LINK_PER_PROJECT, LINK_WAIT_MS, linkReplays, nextLinkAt } from "../src/replays/link.ts";
import { joinReplays } from "../src/replays/replays.ts";
import { s3ObjectStore } from "../src/storage/object-store.ts";
import { signedInDashboard } from "./helpers/dashboard.ts";
import { insertProject } from "./helpers/projects.ts";

/**
 * The Replays page's data (docs/session-replay.md, "Finding replays"):
 * what the worker derives when it joins a replay and links it to its
 * error, the list with its filters and pages, the timeline, the user's
 * page, and the one access check on each.
 */

// The development Garage from compose.yaml.
const store = s3ObjectStore(LOCAL_OBJECT_STORE);
const ORIGIN = "https://shop.example";
const CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";

/** A real recording, as replay-derive.test.ts describes it. */
const FIXTURE = readFileSync(new URL("fixtures/replay-recording.json", import.meta.url), "utf8");

let dashboard: Awaited<ReturnType<typeof signedInDashboard>>;
const projects: string[] = [];

beforeAll(async () => {
  dashboard = await signedInDashboard({ objectStore: store, replays: { limitBytes: 1024 ** 3 } });
});

afterAll(async () => {
  for (const id of projects) await store.deletePrefix(`replays/${id}/`);
  store.close();
  await dashboard?.close();
});

async function newProject(name: string) {
  const project = await insertProject(dashboard.db, {
    name,
    allowed_hostnames: ["shop.example"],
    replay_mode: "errors",
  });
  projects.push(project.id);
  return project;
}

/** Sends a recording's text as the recorder does, in `pieces` chunks; `last` false leaves its end out. */
async function sendRecording(key: string, replay: string, text: string, pieces = 3, last = true) {
  const size = Math.ceil(text.length / pieces);
  for (let seq = 0; seq < pieces; seq += 1) {
    const isLast = seq === pieces - 1;
    if (isLast && !last) break;
    const response = await dashboard.app.inject({
      method: "POST",
      url: `/api/replays?key=${key}&replay=${replay}&seq=${seq}&last=${isLast ? 1 : 0}&cut=0`,
      headers: { "content-type": "text/plain", origin: ORIGIN, "user-agent": CHROME },
      payload: gzipSync(text.slice(seq * size, (seq + 1) * size)),
    });
    expect(response.statusCode).toBe(202);
  }
}

/** A short recording ending now, on these paths. */
function recordingOn(paths: string[], durationMs = 20_000): string {
  const end = Date.now();
  const start = end - durationMs;
  return JSON.stringify({
    v: 1,
    events: [
      ...paths.map((path, index) => ({
        type: 4,
        timestamp: start + index,
        data: { href: `https://shop.example${path}`, width: 800, height: 600 },
      })),
      { type: 2, timestamp: start + 50, data: { node: { type: 0, id: 1, childNodes: [] } } },
      { type: 3, timestamp: end, data: { source: 2, type: 2, id: 1, x: 1, y: 1 } },
    ],
  });
}

const replayRow = (projectId: string, replayId: string) =>
  dashboard.db
    .selectFrom("replays")
    .selectAll()
    .where("project_id", "=", projectId)
    .where("replay_id", "=", replayId)
    .executeTakeFirstOrThrow();

const ERROR = { type: "TypeError", message: "cart is undefined", handled: false };

/** An error event in ClickHouse that names the replay, as the tracker sends it. */
function errorEvent(
  replayId: string,
  {
    error = ERROR,
    userId,
    environment,
    at = new Date(),
  }: { error?: typeof ERROR; userId?: string; environment?: string; at?: Date } = {},
) {
  return {
    eventId: randomUUID(),
    name: "error",
    occurredAt: at,
    path: "/checkout",
    visitorId: "1",
    client: {
      browser: "Firefox",
      browserVersion: "133",
      os: "Linux",
      deviceType: "desktop" as const,
    },
    ...(userId === undefined ? {} : { userId }),
    ...(environment === undefined ? {} : { environment }),
    error: { ...error, fingerprint: fingerprint(error), replayId },
  };
}

/** A GET of a project route, signed in unless `signedIn` is false. */
const get = (url: string, signedIn = true) =>
  dashboard.app.inject({
    url: `/api/projects/${url}`,
    headers: signedIn ? { cookie: dashboard.cookie } : {},
  });

describe("joining a replay: what it shows", () => {
  test("derives pages, counts, times, and a timeline from a real recording", async () => {
    const project = await newProject("Derived");
    const replay = randomUUID();
    const sentAt = Date.now();
    await sendRecording(project.public_key, replay, FIXTURE);
    await joinReplays(dashboard.db, store);

    const row = await replayRow(project.id, replay);
    expect(row).toMatchObject({
      pages: ["/cart", "/checkout"],
      clicks: 4,
      page_changes: 1,
      cut: false,
      linked: false,
      error_fingerprint: null,
    });
    const events = JSON.parse(FIXTURE).events;
    expect(row.ended_at.getTime() - row.started_at.getTime()).toBe(
      events.at(-1).timestamp - events[0].timestamp,
    );
    // Recorded hours or days before this test: moved to when its first chunk came.
    expect(Math.abs(row.ended_at.getTime() - sentAt)).toBeLessThan(CLOCK_TOLERANCE_MS + 5_000);
    const timeline = row.timeline as { items: { kind: string }[]; truncated: unknown };
    expect(timeline.truncated).toBe(false);
    expect(timeline.items.map((item) => item.kind)).toEqual([
      "page",
      "click",
      "scroll",
      "page",
      "scroll",
      "input",
      "click",
      "input",
      "click",
      "click",
      "error",
    ]);
  });

  test("a cut replay is described as far as it came", async () => {
    const project = await newProject("Cut");
    const replay = randomUUID();
    // Two of three chunks: the visitor left before the last.
    await sendRecording(project.public_key, replay, FIXTURE, 3, false);
    await joinReplays(dashboard.db, store, { now: new Date(Date.now() + 10 * 60_000) });
    const row = await replayRow(project.id, replay);
    expect(row.cut).toBe(true);
    expect(row.pages.length).toBeGreaterThanOrEqual(1);
    expect(row.pages[0]).toBe("/cart");
    const timeline = row.timeline as { items: { kind: string }[] };
    expect(timeline.items.length).toBeGreaterThan(0);
    expect(timeline.items.length).toBeLessThan(11);
  });
});

describe("linking a replay to its error", () => {
  test("keeps the first error's group, user, environment, and client", async () => {
    const project = await newProject("Linked");
    const replay = randomUUID();
    await sendRecording(project.public_key, replay, recordingOn(["/cart"]));
    await joinReplays(dashboard.db, store);
    const first = new Date(Date.now() - 5_000);
    await dashboard.store(project.id, [
      errorEvent(replay, { userId: "ada", environment: "staging", at: first }),
      // A later error of the same page load: the first one is kept.
      errorEvent(replay, {
        error: { type: "RangeError", message: "later", handled: false },
        at: new Date(),
      }),
    ]);

    const result = await linkReplays(dashboard.db, dashboard.reader);
    expect(result.linked).toBeGreaterThanOrEqual(1);
    const row = await replayRow(project.id, replay);
    expect(row).toMatchObject({
      linked: true,
      error_fingerprint: fingerprint(ERROR),
      error_type: "TypeError",
      error_message: "cart is undefined",
      user_id: "ada",
      environment: "staging",
      browser: "Firefox",
      os: "Linux",
      device_type: "desktop",
    });
    expect(row.error_at?.getTime()).toBe(first.getTime());
  });

  test("looks again while the error may come, then gives up", async () => {
    const project = await newProject("Not found");
    const replay = randomUUID();
    await sendRecording(project.public_key, replay, recordingOn(["/cart"]));
    await joinReplays(dashboard.db, store);

    await linkReplays(dashboard.db, dashboard.reader);
    expect((await replayRow(project.id, replay)).linked).toBe(false);
    await linkReplays(dashboard.db, dashboard.reader, {
      now: new Date(Date.now() + LINK_WAIT_MS + 60_000),
    });
    expect(await replayRow(project.id, replay)).toMatchObject({
      linked: true,
      error_fingerprint: null,
      user_id: null,
    });
  });

  test("a project whose errors never come keeps no other project's replays waiting", async () => {
    const [noisy, quiet] = [await newProject("Noisy"), await newProject("Quiet")];
    // Joined just now, as the worker leaves them: more than a run takes of one project.
    const now = new Date();
    const noisyIds = Array.from({ length: LINK_PER_PROJECT * 2 }, () => randomUUID());
    await dashboard.db
      .insertInto("replays")
      .values(
        noisyIds.map((replayId) => ({
          project_id: noisy.id,
          replay_id: replayId,
          object_key: `replays/${noisy.id}/${replayId}.json.gz`,
          bytes: 1,
          cut: false,
          started_at: now,
          ended_at: now,
        })),
      )
      .execute();
    const quietReplay = randomUUID();
    await sendRecording(quiet.public_key, quietReplay, recordingOn(["/cart"]));
    await joinReplays(dashboard.db, store);
    await dashboard.store(quiet.id, [errorEvent(quietReplay, { userId: "grace" })]);

    // A run that takes no more than one project's share: the quiet one still gets its turn.
    const result = await linkReplays(dashboard.db, dashboard.reader, {
      limit: LINK_PER_PROJECT + 1,
    });
    expect(result.linked).toBe(1);
    expect(await replayRow(quiet.id, quietReplay)).toMatchObject({
      linked: true,
      user_id: "grace",
    });

    // The noisy project's looked-at replays wait before the next try; the rest come next.
    const waits = await dashboard.db
      .selectFrom("replays")
      .select(["next_link_at"])
      .where("project_id", "=", noisy.id)
      .execute();
    const later = waits.filter((row) => row.next_link_at > new Date());
    expect(later).toHaveLength(LINK_PER_PROJECT);
    await linkReplays(dashboard.db, dashboard.reader);
    const tried = await dashboard.db
      .selectFrom("replays")
      .select((eb) => eb.fn.countAll<string>().as("count"))
      .where("project_id", "=", noisy.id)
      .where("next_link_at", ">", new Date())
      .executeTakeFirstOrThrow();
    expect(tried.count).toBe(String(LINK_PER_PROJECT * 2));
  });

  test("waits longer after each miss, up to 10 minutes", () => {
    const joined = new Date(0);
    const wait = (ageMs: number) => nextLinkAt(joined, new Date(ageMs)).getTime() - ageMs;
    expect(wait(0)).toBe(10_000);
    expect(wait(60_000)).toBe(30_000);
    expect(wait(3_600_000)).toBe(600_000);
  });

  test("an error of another project with the same replay ID is not linked", async () => {
    const [mine, theirs] = [await newProject("Mine"), await newProject("Theirs")];
    const replay = randomUUID();
    await sendRecording(mine.public_key, replay, recordingOn(["/cart"]));
    await joinReplays(dashboard.db, store);
    await dashboard.store(theirs.id, [errorEvent(replay, { userId: "mallory" })]);
    await linkReplays(dashboard.db, dashboard.reader);
    expect((await replayRow(mine.id, replay)).user_id).toBeNull();
  });
});

describe("the list of a project's replays", () => {
  let project: { id: string; public_key: string };
  /** Newest first. */
  const ids: string[] = [];

  beforeAll(async () => {
    project = await newProject("Listed");
    const minute = 60_000;
    const now = Date.now();
    // id, paths, seconds long, started minutes ago, environment, user, error type.
    const plan: [string[], number, number, string | null, string | null, string | null][] = [
      [["/cart", "/checkout"], 50, 1, "production", "ada", "TypeError"],
      [["/pricing"], 10, 2, "staging", "grace", "RangeError"],
      [["/100%-off"], 35, 3, null, null, null],
      [["/account"], 20, 4, "production", "ada", "RangeError"],
      [["/checkout/pay"], 45, 5, "production", null, "TypeError"],
      // Ten days ago: in 30 days, not 7.
      [["/old"], 30, 10 * 24 * 60, "production", null, "TypeError"],
    ];
    for (const [paths, seconds, minutesAgo, environment, userId, type] of plan) {
      const replay = randomUUID();
      ids.push(replay);
      await sendRecording(project.public_key, replay, recordingOn(paths, seconds * 1000));
      await joinReplays(dashboard.db, store);
      const startedAt = new Date(now - minutesAgo * minute);
      const error =
        type === null ? null : { type, message: `${type} message`, handled: false as const };
      // Set as the worker would have: when it started, and its error.
      await dashboard.db
        .updateTable("replays")
        .set({
          started_at: startedAt,
          ended_at: new Date(startedAt.getTime() + seconds * 1000),
          linked: true,
          environment,
          user_id: userId,
          error_at: error === null ? null : startedAt,
          error_fingerprint: error === null ? null : fingerprint(error),
          error_type: error?.type ?? null,
          error_message: error?.message ?? null,
        })
        .where("project_id", "=", project.id)
        .where("replay_id", "=", replay)
        .execute();
    }
  });

  const list = async (query: string) => {
    const response = await get(`${project.id}/replays/list?${query}`);
    expect(response.statusCode).toBe(200);
    return response.json();
  };
  const listed = async (query: string) =>
    (await list(query)).replays.map((replay: { id: string }) => ids.indexOf(replay.id));

  test("lists the period's replays, newest first, with what each shows", async () => {
    const body = await list("period=7d");
    // Production's, and the one whose error was never found (no environment).
    expect(body.replays.map((replay: { id: string }) => ids.indexOf(replay.id))).toEqual([
      0, 2, 3, 4,
    ]);
    expect(body.replays[0]).toMatchObject({
      pages: ["/cart", "/checkout"],
      durationMs: 50_000,
      cut: false,
      clicks: 1,
      pageChanges: 1,
      userId: "ada",
      environment: "production",
      linked: true,
      error: { type: "TypeError", message: "TypeError message" },
    });
    expect(body.replays[1].error).toBeNull();
    expect(body).toMatchObject({ configured: true, environment: "production", next: null });
    expect(body.environments).toEqual(["production", "staging"]);
    expect(
      body.errorGroups
        .map((group: { type: string; replays: number }) => [group.type, group.replays])
        .toSorted(),
    ).toEqual([
      // Production's: staging's RangeError is not offered here.
      ["RangeError", 1],
      ["TypeError", 2],
    ]);
    expect(await listed("period=30d")).toEqual([0, 2, 3, 4, 5]);
  });

  test("filters by environment, path, user, error group, and duration", async () => {
    expect(await listed("period=7d&environment=staging")).toEqual([1, 2]);
    // The error filter offers the environment's groups only.
    const staging = await list("period=7d&environment=staging");
    expect(
      staging.errorGroups.map((group: { type: string; replays: number }) => [
        group.type,
        group.replays,
      ]),
    ).toEqual([["RangeError", 1]]);
    // Case ignored, and no wildcards: % and _ are matched as they are.
    expect(await listed("period=7d&path=CHECKOUT")).toEqual([0, 4]);
    expect(await listed(`period=7d&path=${encodeURIComponent("100%")}`)).toEqual([2]);
    expect(await listed(`period=7d&path=${encodeURIComponent("%")}`)).toEqual([2]);
    expect(await listed("period=7d&path=_")).toEqual([]);
    expect(await listed("period=7d&userId=ada")).toEqual([0, 3]);
    expect(await listed("period=7d&userId=ADA")).toEqual([]);
    const typeError = fingerprint({ type: "TypeError", message: "TypeError message" });
    expect(await listed(`period=7d&fingerprint=${typeError}`)).toEqual([0, 4]);
    expect(await listed("period=7d&minDuration=40000")).toEqual([0, 4]);
    expect(await listed("period=7d&minDuration=40000&userId=ada&path=cart")).toEqual([0]);
  });

  test("pages through with a cursor, none twice, none missed", async () => {
    const seen: number[] = [];
    /** Error groups listed with each page: the filters' choices come with the first only. */
    const choices: number[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const body = await list(
        `period=30d&limit=2${cursor === null ? "" : `&before=${encodeURIComponent(cursor)}`}`,
      );
      expect(body.replays.length).toBeLessThanOrEqual(2);
      seen.push(...body.replays.map((replay: { id: string }) => ids.indexOf(replay.id)));
      choices.push(body.errorGroups.length);
      cursor = body.next;
      pages += 1;
    } while (cursor !== null && pages < 10);
    expect(choices).toEqual([2, 0, 0]);
    expect(seen).toEqual([0, 2, 3, 4, 5]);
    expect(pages).toBe(3);
  });

  test("refuses parameters it does not take, and bounds every one", async () => {
    const refused = [
      "",
      "period=forever",
      "period=7d&from=2026-11-01&to=2026-11-02",
      "period=7d&limit=0",
      "period=7d&limit=101",
      "period=7d&minDuration=-1",
      "period=7d&minDuration=3600001",
      "period=7d&minDuration=ten",
      `period=7d&path=${"a".repeat(201)}`,
      `period=7d&path=${encodeURIComponent("a\nb")}`,
      `period=7d&userId=${encodeURIComponent("a\u0000b")}`,
      "period=7d&fingerprint=nope",
      "period=7d&before=yesterday",
      `period=7d&before=99999999999999999_${randomUUID()}`,
      "period=7d&environment=a%20b",
      "period=7d&limit=1.5",
    ];
    for (const query of refused) {
      const response = await get(`${project.id}/replays/list?${query}`);
      expect({ query, status: response.statusCode }).toEqual({ query, status: 400 });
    }
  });

  test("a page holds at most 100", async () => {
    expect((await list("period=7d&limit=100")).replays.length).toBeLessThanOrEqual(100);
  });
});

describe("a replay's timeline", () => {
  test("serves the derived timeline, the error's place, and the recording's start", async () => {
    const project = await newProject("Timeline");
    const replay = randomUUID();
    await sendRecording(project.public_key, replay, FIXTURE);
    await joinReplays(dashboard.db, store);

    const response = await get(`${project.id}/replays/${replay.toUpperCase()}/timeline`);
    expect(response.statusCode).toBe(200);
    const body = response.json();
    const events = JSON.parse(FIXTURE).events;
    const marker = events.find((event: { type: number }) => event.type === 5);
    expect(body.replay).toMatchObject({ id: replay, pages: ["/cart", "/checkout"], clicks: 4 });
    expect(body.timeline.items).toHaveLength(11);
    expect(body.timeline.items[1]).toMatchObject({ kind: "click", tag: "button", role: "button" });
    // The recorder's own marker, in ms from the start, as the player counts.
    expect(body.errorOffsetMs).toBe(marker.timestamp - events[0].timestamp);
    expect(body.recordingStartMs).toBe(events[0].timestamp);
    expect(body.timeZone).toBe("UTC");
  });
});

describe("one check on every replay route", () => {
  test("signed out 401, an unknown project 404, another project's replay 404", async () => {
    const [mine, theirs] = [await newProject("Mine too"), await newProject("Theirs too")];
    const replay = randomUUID();
    await sendRecording(theirs.public_key, replay, recordingOn(["/secret"]));
    await joinReplays(dashboard.db, store);

    for (const path of [
      `${mine.id}/replays/list?period=7d`,
      `${mine.id}/replays/${replay}/timeline`,
    ]) {
      expect((await get(path, false)).statusCode).toBe(401);
    }
    const unknown = randomUUID();
    expect((await get(`${unknown}/replays/list?period=7d`)).json().error).toBe("not_found");
    expect((await get(`${unknown}/replays/${replay}/timeline`)).statusCode).toBe(404);
    // Theirs, asked for under mine: not found, and nothing of it in mine's list.
    expect((await get(`${mine.id}/replays/${replay}/timeline`)).statusCode).toBe(404);
    expect((await get(`${mine.id}/replays/${replay}`)).statusCode).toBe(404);
    expect((await get(`${mine.id}/replays/list?period=7d`)).json().replays).toEqual([]);
    expect((await get(`${theirs.id}/replays/${replay}/timeline`)).statusCode).toBe(200);
    // Bad IDs never reach the database.
    expect((await get(`${mine.id}/replays/not-a-uuid/timeline`)).statusCode).toBe(400);
  });
});

describe("a user's replays", () => {
  test("the user's errors name their replay, and the first page lists the user's replays", async () => {
    const project = await newProject("Users");
    const [played, coming] = [randomUUID(), randomUUID()];
    await sendRecording(project.public_key, played, recordingOn(["/cart"]));
    await joinReplays(dashboard.db, store);
    await dashboard.store(project.id, [
      errorEvent(played, { userId: "ada", at: new Date(Date.now() - 2_000) }),
      errorEvent(coming, { userId: "ada" }),
      {
        eventId: randomUUID(),
        name: "pageview",
        occurredAt: new Date(Date.now() - 10_000),
        path: "/cart",
        visitorId: "1",
        userId: "ada",
      },
    ]);
    await linkReplays(dashboard.db, dashboard.reader);

    const body = (await get(`${project.id}/users/ada`)).json();
    const errors = body.activity.filter((item: { name: string }) => item.name === "error");
    expect(errors.map((item: { replay: unknown }) => item.replay)).toEqual([
      { id: coming, status: "pending" },
      { id: played, status: "ready" },
    ]);
    const pageview = body.activity.find((item: { name: string }) => item.name === "pageview");
    expect(pageview.replay).toBeNull();
    expect(body.replays.map((replay: { id: string }) => replay.id)).toEqual([played]);
    expect(body.replays[0]).toMatchObject({ userId: "ada", pages: ["/cart"] });

    // Another environment's page has none of production's replays.
    const staging = await get(`${project.id}/users/ada?environment=staging`);
    expect(staging.statusCode).toBe(404);
  });
});
