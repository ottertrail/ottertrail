import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import { QueryParams } from "../src/clickhouse/query.ts";
import type { NewEvent } from "../src/collection/event-store.ts";
import { visitsWhere } from "../src/spam/delete-visits.ts";
import type { ObjectStore } from "../src/storage/object-store.ts";
import { PUBLIC_URL, signedInDashboard, signedInUser } from "./helpers/dashboard.ts";
import { storedEvents } from "./helpers/events.ts";
import { insertProject } from "./helpers/projects.ts";

/** The dashboard's clock: the period's days end on 16 November 2026, in UTC. */
const NOW = new Date("2026-11-16T12:00:00.000Z");
const at = (time: string) => new Date(`2026-11-${time}Z`);

/** An object store in memory: the replays' objects. */
const objects = new Map<string, Uint8Array>();
/** Makes the store's deletes fail, as an unreachable object store would. */
let failDeletes = false;
const memoryStore: ObjectStore = {
  put: async (key, body) => {
    objects.set(key, body);
  },
  get: async (key) => objects.get(key) ?? null,
  delete: async (keys) => {
    if (failDeletes) throw new Error("The object store is unreachable");
    for (const key of keys) objects.delete(key);
  },
  deletePrefix: async (prefix) => {
    let n = 0;
    for (const key of objects.keys()) {
      if (key.startsWith(prefix)) {
        objects.delete(key);
        n += 1;
      }
    }
    return n;
  },
  close: () => undefined,
};

let dashboard: Awaited<ReturnType<typeof signedInDashboard>>;

beforeAll(async () => {
  dashboard = await signedInDashboard({ now: () => NOW, objectStore: memoryStore });
});

afterAll(async () => {
  await dashboard?.close();
});

function event(visitorId: string | undefined, occurredAt: Date, more: Partial<NewEvent> = {}) {
  return {
    eventId: randomUUID(),
    name: "pageview",
    occurredAt,
    path: "/",
    ...(visitorId === undefined ? {} : { visitorId }),
    ...more,
  } satisfies NewEvent;
}

/**
 * A project with:
 * - visit A (visitor 1, 15 Nov 10:00): from spam.example, a pageview, time
 *   on page, Web Vitals, an error with a replay, a custom event, a second
 *   pageview, by a signed-in user; and retries of its first and last events
 *   not merged yet, a few seconds apart;
 * - a neighbour (visitor 1, 15 Nov 10:36:10): over 30 minutes after visit
 *   A's last event, so a visit of its own, and outside A's delete window;
 * - visit B (visitor 1, 15 Nov 12:00, after a gap): from google.com, the
 *   same user;
 * - visit C (visitor 2, 14 Nov 23:50): from spam.example, outside the period;
 * - visit D (visitor 3, 15 Nov 09:00): from www.spam.example, /x, in Germany;
 * - a server-side event on 15 Nov at 11:00, by the same user, which belongs to no visit.
 */
async function spamProject(name: string) {
  const project = await insertProject(dashboard.db, { name, allowed_hostnames: ["example.com"] });
  const replayId = randomUUID();
  const firstOfA = event("1", at("15T10:00:00"), {
    referrer: "https://spam.example/",
    userId: "u1",
  });
  const visitA = [
    firstOfA,
    event("1", at("15T10:01:00"), { name: "engagement", properties: { engagedMs: 5000 } }),
    event("1", at("15T10:01:00"), { name: "vitals", properties: { lcp: 1200 } }),
    event("1", at("15T10:02:00"), {
      name: "error",
      error: { type: "TypeError", message: "x", handled: false, fingerprint: "1-abc", replayId },
    }),
    event("1", at("15T10:03:00"), { name: "signup" }),
    event("1", at("15T10:05:00"), { path: "/b", userId: "u1" }),
  ];
  const lastOfA = visitA.at(-1);
  if (lastOfA === undefined) throw new Error("visit A has no events");
  const neighbour = [event("1", at("15T10:36:10"), { path: "/later" })];
  const visitB = [
    event("1", at("15T12:00:00"), { referrer: "https://www.google.com/", userId: "u1" }),
  ];
  const visitC = [event("2", at("14T23:50:00"), { referrer: "https://spam.example/" })];
  const visitD = [
    event("3", at("15T09:00:00"), {
      referrer: "https://www.spam.example/",
      path: "/x",
      location: { country: "DE" },
    }),
  ];
  const server = [event(undefined, at("15T11:00:00"), { name: "paid", userId: "u1" })];
  await dashboard.store(project.id, [
    ...visitA,
    ...neighbour,
    ...visitB,
    ...visitC,
    ...visitD,
    ...server,
  ]);
  // Retries of A's first and last events, stored again 3 seconds later, not
  // merged yet. Whichever copy FINAL keeps, one of the two retries lies
  // outside the visit's first and last event as FINAL reads it.
  await dashboard.store(
    project.id,
    [firstOfA, lastOfA].map((row) => ({
      ...row,
      occurredAt: new Date(row.occurredAt.getTime() + 3000),
    })),
  );
  await dashboard.db
    .insertInto("replays")
    .values(
      [replayId, randomUUID()].map((id) => ({
        project_id: project.id,
        replay_id: id,
        object_key: `replays/${project.id}/${id}.json.gz`,
        bytes: 1,
        cut: false,
        started_at: NOW,
        ended_at: NOW,
      })),
    )
    .execute();
  for (const id of [replayId])
    objects.set(`replays/${project.id}/${id}.json.gz`, new Uint8Array(1));
  return { id: project.id, replayId, neighbour, visitB, visitC, visitD, server };
}

function post(
  projectId: string,
  action: "preview" | "delete",
  body: object,
  cookie = dashboard.cookie,
) {
  return dashboard.app.inject({
    method: "POST",
    url: `/api/projects/${projectId}/spam-visits/${action}`,
    headers: { cookie, origin: PUBLIC_URL, "content-type": "application/json" },
    payload: JSON.stringify(body),
  });
}

const PERIOD = { from: "2026-11-15", to: "2026-11-15" };

const idsOf = async (projectId: string) =>
  (await storedEvents(dashboard.reader.client, projectId)).map((row) => row.event_id).toSorted();

describe("deleting spam visits", () => {
  test("the preview counts whole visits and their events by kind", async () => {
    const project = await spamProject("Preview");
    const preview = await post(project.id, "preview", { ...PERIOD, referrer: "spam.example" });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toEqual({
      visits: 2,
      events: 7,
      pageviews: 3,
      customEvents: 1,
      errors: 1,
      other: 2,
      replays: 1,
      limit: 10_000,
    });
    expect((await post(project.id, "preview", { ...PERIOD, path: "/x" })).json()).toMatchObject({
      visits: 1,
      events: 1,
    });
    expect((await post(project.id, "preview", { ...PERIOD, country: "de" })).json()).toMatchObject({
      visits: 1,
      events: 1,
    });
    expect(
      (
        await post(project.id, "preview", {
          from: "2026-11-14",
          to: "2026-11-15",
          referrer: "spam.example",
        })
      ).json(),
    ).toMatchObject({ visits: 3 });
    // Without a filter, every visit of the period would go: refused.
    const unfiltered = await post(project.id, "preview", PERIOD);
    expect(unfiltered.statusCode).toBe(400);
    expect(unfiltered.json().message).toContain("Choose at least one filter");
  });

  test("deletes whole visits, retries included, and nothing else; FINAL reads no longer see them", async () => {
    // The retries stay rows of their own until ClickHouse merges the parts,
    // which it may do before the delete; stopping merges would stop the
    // delete too. So this catches a delete that leaves a copy only when the
    // merge has not run yet, which the count below records; the window
    // itself is tested on fixed rows ("a delete's window").
    const project = await spamProject("Delete");
    const rows = async (final: boolean) => {
      const result = await dashboard.reader.client.query({
        query: `SELECT count() AS n FROM events ${final ? "FINAL" : ""}
                WHERE project_id = {p:UUID} AND visitor_id = 1 AND occurred_at < '2026-11-15 11:00:00'`,
        query_params: { p: project.id },
        format: "JSONEachRow",
      });
      const [row] = await result.json<{ n: string }>();
      return Number(row?.n ?? 0);
    };
    const unmerged = (await rows(false)) - (await rows(true));
    expect(unmerged === 0 || unmerged === 2).toBe(true);
    console.info(`Retried copies still unmerged before the delete: ${unmerged} of 2`);
    const other = await spamProject("Other project");
    const otherBefore = await idsOf(other.id);

    // The typed count must match what is found.
    const wrong = await post(project.id, "delete", {
      ...PERIOD,
      referrer: "spam.example",
      confirmVisits: 3,
    });
    expect(wrong.statusCode).toBe(409);
    expect(wrong.json()).toMatchObject({ error: "visits_changed" });

    const deleted = await post(project.id, "delete", {
      ...PERIOD,
      referrer: "spam.example",
      confirmVisits: 2,
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({
      visits: 2,
      events: 7,
      pageviews: 3,
      customEvents: 1,
      errors: 1,
      other: 2,
      replays: 1,
      replaysDeleted: 1,
    });

    // Visit B, visit C (another period), and the server-side event are left, read with FINAL.
    expect(await idsOf(project.id)).toEqual(
      [...project.neighbour, ...project.visitB, ...project.visitC, ...project.server]
        .map((row) => row.eventId)
        .toSorted(),
    );
    // Nothing of the deleted visits is left even without FINAL: the retry went too.
    const raw = await dashboard.reader.client.query({
      query: `SELECT count() AS n FROM events WHERE project_id = {p:UUID} AND visitor_id IN (1, 3)
              AND toDate(occurred_at) = '2026-11-15' AND occurred_at < '2026-11-15 10:30:00'`,
      query_params: { p: project.id },
      format: "JSONEachRow",
    });
    expect(await raw.json()).toEqual([{ n: "0" }]);
    // Another project's identical visits are untouched.
    expect(await idsOf(other.id)).toEqual(otherBefore);

    // The deleted error's replay went; the other replay stays.
    const replays = await dashboard.db
      .selectFrom("replays")
      .select("replay_id")
      .where("project_id", "=", project.id)
      .execute();
    expect(replays.map((row) => row.replay_id)).not.toContain(project.replayId);
    expect(replays).toHaveLength(1);
    expect(objects.has(`replays/${project.id}/${project.replayId}.json.gz`)).toBe(false);

    // The signed-in user is first seen at their earliest event left, the
    // server-side event at 11:00, no longer visit A's at 10:00.
    const firstSeen = await dashboard.reader.client.query({
      query: `SELECT user_id, toString(minMerge(first_seen)) AS first FROM user_first_seen
              WHERE project_id = {p:UUID} GROUP BY user_id`,
      query_params: { p: project.id },
      format: "JSONEachRow",
    });
    expect(await firstSeen.json()).toEqual([{ user_id: "u1", first: "2026-11-15 11:00:00.000" }]);

    // Done: nothing more matches.
    expect(
      (await post(project.id, "preview", { ...PERIOD, referrer: "spam.example" })).json(),
    ).toMatchObject({ visits: 0, events: 0 });
  });

  test("members without the projects permission are refused; an ungranted project is not found", async () => {
    const project = await spamProject("Guarded");
    const other = await spamProject("Not granted");
    const { cookie } = await signedInUser(dashboard, {
      name: "Mo",
      email: `mo-${randomUUID()}@example.com`,
      grants: {
        projects: [project.id],
        areas: { web_analytics: "view", product_analytics: "manage", errors: "manage" },
      },
    });
    for (const action of ["preview", "delete"] as const) {
      const body = { ...PERIOD, ...(action === "delete" ? { confirmVisits: 1 } : {}) };
      expect((await post(project.id, action, body, cookie)).statusCode).toBe(403);
      expect((await post(other.id, action, body, cookie)).statusCode).toBe(404);
    }
    expect((await idsOf(project.id)).length).toBeGreaterThan(0);
  });

  test.each([
    ["no period", { country: "DE" }],
    ["no filter", PERIOD],
    ["a day that does not exist", { from: "2026-02-30", to: "2026-11-15", country: "DE" }],
    ["an end before the start", { from: "2026-11-15", to: "2026-11-14", country: "DE" }],
    ["an end after today", { from: "2026-11-15", to: "2026-11-17", country: "DE" }],
    ["a period over 92 days", { from: "2026-08-01", to: "2026-11-15", country: "DE" }],
    ["a country that is no code", { ...PERIOD, country: "Germany" }],
    ["a path without its slash", { ...PERIOD, path: "pricing" }],
    ["a referrer that is no domain", { ...PERIOD, referrer: "not a domain" }],
  ])("refuses %s with 400", async (_label, body) => {
    const project = await spamProject(`Bad ${randomUUID().slice(0, 6)}`);
    expect((await post(project.id, "preview", body)).statusCode).toBe(400);
    expect((await post(project.id, "delete", { ...body, confirmVisits: 1 })).statusCode).toBe(400);
  });

  test("refuses a period before the project's retention", async () => {
    const project = await spamProject("Kept 30 days");
    await dashboard.db
      .updateTable("projects")
      .set({ retention_days: 30 })
      .where("id", "=", project.id)
      .execute();
    const response = await post(project.id, "preview", {
      from: "2026-10-01",
      to: "2026-11-15",
      country: "DE",
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().message).toContain("2026-10-17");
    expect(
      (await post(project.id, "preview", { from: "2026-10-17", to: "2026-11-15", country: "DE" }))
        .statusCode,
    ).toBe(200);
  });

  test("a failure partway answers so, and the visits that went take their first-seen times", async () => {
    const project = await spamProject("Partly");
    // The object store fails as the delete's last step removes the replays.
    failDeletes = true;
    let response;
    try {
      response = await post(project.id, "delete", {
        ...PERIOD,
        referrer: "spam.example",
        confirmVisits: 2,
      });
    } finally {
      failDeletes = false;
    }
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: "delete_failed",
      message:
        "The delete stopped partway: some visits may have been deleted. Count the visits again, then delete what is left.",
    });
    // The visits went, and first-seen times were worked out again first.
    expect(
      (await post(project.id, "preview", { ...PERIOD, referrer: "spam.example" })).json(),
    ).toMatchObject({ visits: 0 });
    const firstSeen = await dashboard.reader.client.query({
      query: `SELECT toString(minMerge(first_seen)) AS first FROM user_first_seen
              WHERE project_id = {p:UUID} GROUP BY user_id`,
      query_params: { p: project.id },
      format: "JSONEachRow",
    });
    expect(await firstSeen.json()).toEqual([{ first: "2026-11-15 11:00:00.000" }]);
  });
});

describe("a delete's window", () => {
  test("takes a retried copy seconds outside the visit, and not the visitor's next visit", async () => {
    const project = randomUUID();
    const params = new QueryParams();
    const where = visitsWhere(
      project,
      [
        {
          environment: "production",
          visitor: "-4611686018427387904",
          startedAt: at("15T10:00:00"),
          endedAt: at("15T10:05:00"),
        },
      ],
      params,
    );
    // A plain table of rows, no merging: the visit's own event, a retried
    // copy 3 seconds after its last event, the same visitor 31 minutes
    // later, another environment, another visitor, and another project.
    const rows = [
      ["original", project, "production", "-4611686018427387904", "2026-11-15 10:05:00.000"],
      ["copy", project, "production", "-4611686018427387904", "2026-11-15 10:05:03.000"],
      ["neighbour", project, "production", "-4611686018427387904", "2026-11-15 10:36:00.000"],
      ["staging", project, "staging", "-4611686018427387904", "2026-11-15 10:02:00.000"],
      ["visitor", project, "production", "42", "2026-11-15 10:02:00.000"],
      ["project", randomUUID(), "production", "-4611686018427387904", "2026-11-15 10:02:00.000"],
    ];
    const result = await dashboard.reader.client.query({
      query: `SELECT label FROM values(
                'label String, project_id UUID, environment String, visitor_id Nullable(Int64), occurred_at DateTime64(3, \\'UTC\\')',
                ${rows.map((row) => `(${row.map((value) => `'${value}'`).join(", ")})`).join(", ")})
              WHERE ${where} ORDER BY label`,
      query_params: params.values,
      format: "JSONEachRow",
    });
    expect(await result.json()).toEqual([{ label: "copy" }, { label: "original" }]);
  });
});
