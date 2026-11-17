import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import { MAX_SAVED_FUNNELS } from "../src/funnels/saved-funnels.ts";
import { PUBLIC_URL, signedInDashboard } from "./helpers/dashboard.ts";
import { insertProject } from "./helpers/projects.ts";

let dashboard: Awaited<ReturnType<typeof signedInDashboard>>;

/** A new project in the dashboard's organization, so each test has its own funnels. */
const newProject = async (name: string) =>
  (await insertProject(dashboard.db, { organization_id: dashboard.organizationId, name })).id;

function call(
  method: "GET" | "POST" | "PUT" | "DELETE",
  url: string,
  payload?: object,
  origin = PUBLIC_URL,
) {
  return dashboard.app.inject({
    method,
    url: `/api/projects/${url}`,
    headers: { cookie: dashboard.cookie, origin },
    ...(payload === undefined ? {} : { payload }),
  });
}

const PRICING = { type: "page", path: "/pricing" };
const SIGNUP = { type: "event", name: "signup" };
const TEAM_SIGNUP = { type: "event", name: "signup", filter: { key: "plan", value: "team" } };
const INVITE = { type: "event", name: "invite" };

/** A funnel as the dashboard sends it. */
const funnel = (name: string, more: object = {}) => ({
  name,
  steps: [PRICING, SIGNUP],
  count: "visitors",
  window: 3600,
  ...more,
});

beforeAll(async () => {
  dashboard = await signedInDashboard();
});

afterAll(async () => {
  await dashboard?.close();
});

describe("saved funnels", () => {
  test("are saved with their steps, count, and window, and listed by name", async () => {
    const project = await newProject("Listed");
    const saved = await call(
      "POST",
      `${project}/funnels`,
      funnel("  pricing to team ", {
        steps: [PRICING, TEAM_SIGNUP, INVITE],
        count: "users",
        window: 604_800,
      }),
    );
    expect(saved.statusCode).toBe(201);
    const { funnel: body } = saved.json();
    expect(body).toMatchObject({
      name: "pricing to team",
      steps: [PRICING, TEAM_SIGNUP, INVITE],
      count: "users",
      window: 604_800,
    });
    // In one order of fields, as the dashboard writes them, so the two compare as text.
    expect(JSON.stringify(body.steps)).toBe(JSON.stringify([PRICING, TEAM_SIGNUP, INVITE]));
    await call("POST", `${project}/funnels`, funnel("Activation"));
    await call("POST", `${project}/funnels`, funnel("Zebra"));

    const list = (await call("GET", `${project}/funnels`)).json().funnels;
    expect(list.map((item: { name: string }) => item.name)).toEqual([
      "Activation",
      "pricing to team",
      "Zebra",
    ]);
    expect(JSON.stringify(list[1].steps)).toBe(JSON.stringify([PRICING, TEAM_SIGNUP, INVITE]));
  });

  test("refuse what the funnel report would refuse, and a bad name", async () => {
    const project = await newProject("Refused");
    for (const [payload, error] of [
      [funnel(""), "invalid_name"],
      [funnel("Tab\there"), "invalid_name"],
      [funnel("x".repeat(101)), "invalid_name"],
      [funnel("One step", { steps: [PRICING] }), "invalid_steps"],
      [funnel("Bad path", { steps: [{ type: "page", path: "pricing" }, SIGNUP] }), "invalid_steps"],
      [
        funnel("Tracker", { steps: [PRICING, { type: "event", name: "pageview" }] }),
        "invalid_steps",
      ],
      [funnel("Twice", { steps: [SIGNUP, TEAM_SIGNUP] }), "steps_overlap"],
      [funnel("Week of visitors", { window: 604_800 }), "invalid_window"],
    ] as const) {
      const response = await call("POST", `${project}/funnels`, payload);
      expect({
        name: payload.name,
        status: response.statusCode,
        error: response.json().error,
      }).toEqual({ name: payload.name, status: 400, error });
    }
    for (const payload of [
      funnel("Six steps", { steps: [PRICING, SIGNUP, PRICING, SIGNUP, PRICING, SIGNUP] }),
      funnel("Odd window", { window: 60 }),
      funnel("Odd count", { count: "sessions" }),
    ]) {
      expect((await call("POST", `${project}/funnels`, payload)).statusCode).toBe(400);
    }
    // 100 emoji: 200 UTF-16 units, but 100 characters.
    expect((await call("POST", `${project}/funnels`, funnel("🎉".repeat(100)))).statusCode).toBe(
      201,
    );
    const elsewhere = await call(
      "POST",
      `${project}/funnels`,
      funnel("Evil"),
      "https://evil.example",
    );
    expect(elsewhere.statusCode).toBe(403);
    expect((await call("GET", `${project}/funnels`)).json().funnels).toHaveLength(1);
  });

  test("are named once each, and at most MAX_SAVED_FUNNELS, even saved at once", async () => {
    const project = await newProject("Full");
    await call("POST", `${project}/funnels`, funnel("Taken"));
    const again = await call("POST", `${project}/funnels`, funnel("Taken", { window: 300 }));
    expect([again.statusCode, again.json().error]).toEqual([409, "funnel_name_taken"]);

    for (let index = 1; index < MAX_SAVED_FUNNELS - 1; index += 1) {
      await call("POST", `${project}/funnels`, funnel(`Funnel ${index}`));
    }
    const statuses = await Promise.all(
      ["A", "B", "C"].map(
        async (name) => (await call("POST", `${project}/funnels`, funnel(name))).statusCode,
      ),
    );
    expect(statuses.toSorted((a, b) => a - b)).toEqual([201, 409, 409]);
    const over = await call("POST", `${project}/funnels`, funnel("One more"));
    expect([over.statusCode, over.json().error]).toEqual([409, "too_many_funnels"]);
    expect((await call("GET", `${project}/funnels`)).json().funnels).toHaveLength(
      MAX_SAVED_FUNNELS,
    );
  });

  test("are changed in place: name, steps, count, and window", async () => {
    const project = await newProject("Changed");
    const first = (await call("POST", `${project}/funnels`, funnel("First"))).json().funnel;
    await call("POST", `${project}/funnels`, funnel("Second"));
    const put = (payload: object, id = first.id, updatedAt = first.updatedAt) =>
      call("PUT", `${project}/funnels/${id}`, { ...payload, updatedAt });

    const changed = await put(
      funnel("Renamed", { steps: [PRICING, SIGNUP, INVITE], count: "users", window: 1_209_600 }),
    );
    expect(changed.statusCode).toBe(200);
    const after = changed.json().funnel;
    expect(after).toMatchObject({
      id: first.id,
      name: "Renamed",
      steps: [PRICING, SIGNUP, INVITE],
      count: "users",
      window: 1_209_600,
      createdAt: first.createdAt,
    });
    // A new version, even within the same millisecond.
    expect(Date.parse(after.updatedAt)).toBeGreaterThan(Date.parse(first.updatedAt));

    const taken = await put(funnel("Second"), first.id, after.updatedAt);
    expect([taken.statusCode, taken.json().error]).toEqual([409, "funnel_name_taken"]);
    const refused = await put(funnel("Renamed", { window: 604_800 }), first.id, after.updatedAt);
    expect([refused.statusCode, refused.json().error]).toEqual([400, "invalid_window"]);
    const missing = await put(funnel("Nowhere"), "00000000-0000-4000-8000-000000000000");
    expect([missing.statusCode, missing.json().error]).toEqual([404, "funnel_not_found"]);
    const unread = await put(funnel("Renamed"), first.id, "yesterday-ish");
    expect([unread.statusCode, unread.json().error]).toEqual([400, "invalid_updated_at"]);

    const list = (await call("GET", `${project}/funnels`)).json().funnels;
    expect(list.map((item: { name: string }) => item.name)).toEqual(["Renamed", "Second"]);
    expect(list[0]).toMatchObject({ window: 1_209_600, updatedAt: after.updatedAt });
  });

  test("are not changed from a copy read before another change", async () => {
    const project = await newProject("Two tabs");
    const read = (await call("POST", `${project}/funnels`, funnel("Shared"))).json().funnel;
    // One tab renames it.
    const renamed = await call("PUT", `${project}/funnels/${read.id}`, {
      ...funnel("Shared, renamed"),
      updatedAt: read.updatedAt,
    });
    expect(renamed.statusCode).toBe(200);

    // The other, still on the first version, changes its steps.
    const stale = await call("PUT", `${project}/funnels/${read.id}`, {
      ...funnel("Shared", { steps: [PRICING, INVITE] }),
      updatedAt: read.updatedAt,
    });
    expect([stale.statusCode, stale.json().error]).toEqual([409, "funnel_changed"]);
    const [kept] = (await call("GET", `${project}/funnels`)).json().funnels;
    expect(kept).toMatchObject({ name: "Shared, renamed", steps: [PRICING, SIGNUP] });

    // Read again, the change goes through.
    const again = await call("PUT", `${project}/funnels/${read.id}`, {
      ...funnel("Shared, renamed", { steps: [PRICING, INVITE] }),
      updatedAt: kept.updatedAt,
    });
    expect(again.statusCode).toBe(200);
  });

  test("are deleted, once", async () => {
    const project = await newProject("Deleted");
    const saved = (await call("POST", `${project}/funnels`, funnel("Gone"))).json().funnel;
    expect((await call("DELETE", `${project}/funnels/${saved.id}`)).statusCode).toBe(204);
    const again = await call("DELETE", `${project}/funnels/${saved.id}`);
    expect([again.statusCode, again.json().error]).toEqual([404, "funnel_not_found"]);
    expect((await call("GET", `${project}/funnels`)).json().funnels).toEqual([]);
  });

  test("are changed and deleted only through their own project's address", async () => {
    const [first, second] = [await newProject("First"), await newProject("Second")];
    const theirs = (await call("POST", `${second}/funnels`, funnel("Theirs"))).json().funnel;

    const changed = await call("PUT", `${first}/funnels/${theirs.id}`, {
      ...funnel("Mine"),
      updatedAt: theirs.updatedAt,
    });
    expect(changed.statusCode).toBe(404);
    const deleted = await call("DELETE", `${first}/funnels/${theirs.id}`);
    expect(deleted.statusCode).toBe(404);

    const list = (await call("GET", `${second}/funnels`)).json().funnels;
    expect(list).toMatchObject([{ id: theirs.id, name: "Theirs" }]);
  });

  test("go with their project", async () => {
    const project = await newProject("Short-lived");
    await call("POST", `${project}/funnels`, funnel("Kept until the end"));
    await dashboard.db.deleteFrom("projects").where("id", "=", project).execute();
    const left = await dashboard.db
      .selectFrom("saved_funnels")
      .select("id")
      .where("project_id", "=", project)
      .execute();
    expect(left).toEqual([]);
  });
});
