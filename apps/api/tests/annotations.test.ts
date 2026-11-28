import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import { MAX_ANNOTATIONS } from "../src/annotations/annotations.ts";
import type { NewEvent } from "../src/collection/event-store.ts";
import { PUBLIC_URL, signedInDashboard, signedInUser } from "./helpers/dashboard.ts";
import { insertProject } from "./helpers/projects.ts";

/** Noon on 17 November 2026 in UTC; the instance runs on Singapore's clock (UTC+8). */
const NOW = new Date("2026-11-17T12:00:00.000Z");

let dashboard: Awaited<ReturnType<typeof signedInDashboard>>;
let projectId = "";
let otherId = "";

function send(
  method: "GET" | "POST" | "PUT" | "DELETE",
  url: string,
  { payload, cookie = dashboard.cookie }: { payload?: object; cookie?: string } = {},
) {
  return dashboard.app.inject({
    method,
    url,
    headers: { cookie, origin: PUBLIC_URL },
    ...(payload === undefined ? {} : { payload }),
  });
}

const notes = (project = projectId) => `/api/projects/${project}/annotations`;

function event(release: string | undefined, occurredAt: string, more: Partial<NewEvent> = {}) {
  return {
    eventId: randomUUID(),
    name: "pageview",
    occurredAt: new Date(occurredAt),
    path: "/",
    visitorId: "1",
    client: { browser: "Chrome", browserVersion: "142", os: "macOS", deviceType: "desktop" },
    ...(release === undefined ? {} : { release }),
    ...more,
  } satisfies NewEvent;
}

const NOTE = {
  day: "2026-11-10",
  time: null,
  text: "Launched the pricing page",
  environment: null,
};

beforeAll(async () => {
  dashboard = await signedInDashboard({ now: () => NOW, timeZone: "Asia/Singapore" });
  projectId = (await insertProject(dashboard.db, { name: "Shop" })).id;
  otherId = (await insertProject(dashboard.db, { name: "Blog" })).id;
});

afterAll(async () => {
  await dashboard?.close();
});

describe("notes", () => {
  test("are added, listed in time order, changed, and deleted", async () => {
    const added = await send("POST", notes(), { payload: { ...NOTE, text: "  Launch  " } });
    expect(added.statusCode).toBe(201);
    expect(added.json().annotation).toMatchObject({
      day: "2026-11-10",
      time: null,
      text: "Launch",
      environment: null,
      author: { name: "Ada Owner" },
    });
    const id = added.json().annotation.id;
    await send("POST", notes(), {
      payload: { day: "2026-11-09", time: "14:30", text: "Deploy", environment: "Staging" },
    });
    await send("POST", notes(), {
      payload: { day: "2026-11-10", time: "09:05", text: "Ad campaign", environment: "production" },
    });

    const production = (await send("GET", `${notes()}?from=2026-11-01&to=2026-11-15`)).json();
    // Whole days first, then by time; the staging note stays out.
    expect(
      production.annotations.map((note: { text: string; time: string | null }) => [
        note.text,
        note.time,
      ]),
    ).toEqual([
      ["Launch", null],
      ["Ad campaign", "09:05"],
    ]);
    const staging = (await send("GET", `${notes()}?environment=staging`)).json();
    expect(staging.annotations.map((note: { text: string }) => note.text)).toEqual([
      "Deploy",
      "Launch",
    ]);
    expect((await send("GET", `${notes()}?from=2026-11-11`)).json().annotations).toEqual([]);

    const changed = await send("PUT", `${notes()}/${id}`, {
      payload: { day: "2026-11-11", time: "08:00", text: "Launch, moved", environment: null },
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json().annotation).toMatchObject({
      id,
      day: "2026-11-11",
      time: "08:00",
      text: "Launch, moved",
    });

    expect((await send("DELETE", `${notes()}/${id}`)).statusCode).toBe(204);
    const again = await send("DELETE", `${notes()}/${id}`);
    expect([again.statusCode, again.json().error]).toEqual([404, "annotation_not_found"]);
  });

  test("refuse bad days, times, and text", async () => {
    for (const [payload, code] of [
      [{ ...NOTE, day: "2026-02-30" }, "invalid_day"],
      [{ ...NOTE, text: "   " }, "invalid_text"],
      [{ ...NOTE, text: "x".repeat(201) }, "invalid_text"],
      [{ ...NOTE, text: "two\nlines" }, "invalid_text"],
      [{ ...NOTE, time: "24:00" }, "FST_ERR_VALIDATION"],
      [{ ...NOTE, environment: "no spaces" }, "FST_ERR_VALIDATION"],
    ] as const) {
      const answer = await send("POST", notes(), { payload });
      expect([answer.statusCode, answer.json().code ?? answer.json().error]).toEqual([400, code]);
    }
    expect(
      (await send("POST", notes(), { payload: { ...NOTE, text: "x".repeat(200) } })).statusCode,
    ).toBe(201);
  });

  test(`stop at ${MAX_ANNOTATIONS} per project, and never reach another project`, async () => {
    const { count } = await dashboard.db
      .selectFrom("annotations")
      .select((eb) => eb.fn.countAll<string>().as("count"))
      .where("project_id", "=", projectId)
      .executeTakeFirstOrThrow();
    await dashboard.db
      .insertInto("annotations")
      .values(
        Array.from({ length: MAX_ANNOTATIONS - Number(count) }, () => ({
          project_id: projectId,
          day: "2026-10-01",
          time: null,
          text: "Filler",
          environment: null,
          author_id: null,
        })),
      )
      .execute();
    const refused = await send("POST", notes(), { payload: NOTE });
    expect([refused.statusCode, refused.json().error]).toEqual([409, "too_many_annotations"]);

    // The other project has its own count, and none of the first's notes.
    const other = await send("POST", notes(otherId), { payload: NOTE });
    expect(other.statusCode).toBe(201);
    const { id } = other.json().annotation;
    expect((await send("GET", notes(otherId))).json().annotations).toHaveLength(1);
    // A note is reached only through its own project.
    expect((await send("DELETE", `${notes()}/${id}`)).statusCode).toBe(404);
    expect((await send("PUT", `${notes()}/${id}`, { payload: NOTE })).json().error).toBe(
      "annotation_not_found",
    );
    expect((await send("GET", notes(otherId))).json().annotations).toHaveLength(1);
    await dashboard.db.deleteFrom("annotations").where("project_id", "=", projectId).execute();
  });

  test("are read with Web analytics, and changed with product analytics at manage", async () => {
    const viewer = await signedInUser(dashboard, {
      name: "Vera Viewer",
      email: "viewer@example.com",
      grants: { projects: "all", areas: { web_analytics: "view", product_analytics: "view" } },
    });
    const marketing = await signedInUser(dashboard, {
      name: "Mark Eting",
      email: "marketing@example.com",
      grants: {
        projects: [projectId],
        areas: { web_analytics: "view", product_analytics: "manage" },
      },
    });
    const outsider = await signedInUser(dashboard, {
      name: "Otto Side",
      email: "outsider@example.com",
      grants: { projects: "all", areas: { errors: "manage" } },
    });

    const added = await send("POST", notes(), { payload: NOTE, cookie: marketing.cookie });
    expect(added.statusCode).toBe(201);
    expect(added.json().annotation.author.name).toBe("Mark Eting");
    const { id } = added.json().annotation;

    expect((await send("GET", notes(), { cookie: viewer.cookie })).json().annotations).toHaveLength(
      1,
    );
    expect((await send("POST", notes(), { payload: NOTE, cookie: viewer.cookie })).statusCode).toBe(
      403,
    );
    expect(
      (await send("PUT", `${notes()}/${id}`, { payload: NOTE, cookie: viewer.cookie })).statusCode,
    ).toBe(403);
    expect((await send("DELETE", `${notes()}/${id}`, { cookie: viewer.cookie })).statusCode).toBe(
      403,
    );
    expect((await send("GET", notes(), { cookie: outsider.cookie })).statusCode).toBe(403);
    // A project the member is not granted answers as one that does not exist.
    expect((await send("GET", notes(otherId), { cookie: marketing.cookie })).statusCode).toBe(404);

    // Removing the author keeps the note, without an author.
    const edited = await send("PUT", `${notes()}/${id}`, {
      payload: { ...NOTE, text: "Edited" },
      cookie: marketing.cookie,
    });
    expect(edited.json().annotation.author.name).toBe("Mark Eting");
    await dashboard.db.deleteFrom("dashboard_users").where("id", "=", marketing.userId).execute();
    const [kept] = (await send("GET", notes())).json().annotations;
    expect(kept).toMatchObject({ id, text: "Edited", author: null });
  });

  test("need the dashboard's origin to change", async () => {
    const answer = await dashboard.app.inject({
      method: "POST",
      url: notes(),
      headers: { cookie: dashboard.cookie, origin: "https://elsewhere.example" },
      payload: NOTE,
    });
    expect(answer.statusCode).toBe(403);
  });
});

const releases = (query: string, project = projectId) =>
  send("GET", `/api/projects/${project}/release-marks?${query}`);

describe("release marks", () => {
  beforeAll(async () => {
    const retried = event("2.0.0", "2026-11-12T02:00:00.000Z");
    await dashboard.store(projectId, [
      // 1.0.0 first appeared on 1 November, before the range below.
      event("1.0.0", "2026-11-01T03:00:00.000Z"),
      event("1.0.0", "2026-11-11T03:00:00.000Z"),
      // 2.0.0 appears in the range: 10:00 on 12 November in Singapore.
      retried,
      event("2.0.0", "2026-11-13T02:00:00.000Z"),
      // 3.0.0 reached staging first, and production only later.
      event("3.0.0", "2026-11-13T05:00:00.000Z", { environment: "staging" }),
      event("3.0.0", "2026-11-15T05:00:00.000Z"),
      event(undefined, "2026-11-14T05:00:00.000Z"),
    ]);
    // The same event sent again, later, as a retry is.
    await dashboard.store(projectId, [
      { ...retried, occurredAt: new Date("2026-11-12T02:00:01.000Z") },
    ]);
    await dashboard.store(otherId, [event("2.0.0", "2026-11-11T00:00:00.000Z")]);
  });

  test("mark each release first seen in the range, in the shown environment only", async () => {
    const production = await releases("from=2026-11-10&to=2026-11-16");
    expect(production.statusCode).toBe(200);
    expect(production.json().releases).toEqual([
      { release: "2.0.0", firstSeen: "2026-11-12T02:00:00.000Z", local: "2026-11-12T10:00" },
      { release: "3.0.0", firstSeen: "2026-11-15T05:00:00.000Z", local: "2026-11-15T13:00" },
    ]);
    const staging = await releases("from=2026-11-10&to=2026-11-16&environment=staging");
    expect(staging.json().releases).toEqual([
      { release: "3.0.0", firstSeen: "2026-11-13T05:00:00.000Z", local: "2026-11-13T13:00" },
    ]);
    // Seen before the range: no mark in it, but a mark in a range that holds that day.
    expect(
      (await releases("from=2026-11-01&to=2026-11-01"))
        .json()
        .releases.map((mark: { release: string }) => mark.release),
    ).toEqual(["1.0.0"]);
    // Days are the instance's: 2.0.0 came at 10:00 on the 12th in Singapore.
    expect((await releases("from=2026-11-12&to=2026-11-12")).json().releases).toHaveLength(1);
    expect((await releases("from=2026-11-13&to=2026-11-14")).json().releases).toEqual([]);
  });

  test("read the first-seen table, filtered by project first", async () => {
    // The other project's 2.0.0 came earlier, and changes nothing here.
    const other = await releases("from=2026-11-10&to=2026-11-16", otherId);
    expect(other.json().releases).toEqual([
      { release: "2.0.0", firstSeen: "2026-11-11T00:00:00.000Z", local: "2026-11-11T08:00" },
    ]);
    const rows = await dashboard.reader.client.query({
      query: `SELECT environment, release, minMerge(first_seen) AS first
              FROM release_first_seen WHERE project_id = {project:UUID}
              GROUP BY environment, release ORDER BY environment, release`,
      query_params: { project: projectId },
      format: "JSONEachRow",
    });
    expect(await rows.json()).toEqual([
      { environment: "production", release: "1.0.0", first: "2026-11-01 03:00:00.000" },
      { environment: "production", release: "2.0.0", first: "2026-11-12 02:00:00.000" },
      { environment: "production", release: "3.0.0", first: "2026-11-15 05:00:00.000" },
      { environment: "staging", release: "3.0.0", first: "2026-11-13 05:00:00.000" },
    ]);
  });

  test("refuse a missing, backwards, or unknown range", async () => {
    expect((await releases("from=2026-11-10")).statusCode).toBe(400);
    expect((await releases("from=2026-11-10&to=2026-11-09")).json().error).toBe("invalid_range");
    expect((await releases("from=2026-02-30&to=2026-03-01")).json().error).toBe("invalid_range");
    expect((await releases("from=2010-01-01&to=2026-11-16")).json().error).toBe("invalid_range");
    expect((await releases("from=2026-11-10&to=2026-11-16&period=7d")).json().error).toBe(
      "invalid_query",
    );
  });
});
