import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import { ALL_AREAS } from "../src/access/areas.ts";
import { setUserAccess } from "../src/access/grants.ts";
import { PUBLIC_URL, signedInDashboard, signedInUser } from "./helpers/dashboard.ts";

/*
 * Starred projects (docs/dashboard.md, "Starred projects"): each user's
 * own, only on projects they may reach, hidden and deleted once they no
 * longer may.
 */

const NOT_FOUND = { error: "not_found", message: "No project has this ID." };

type Dashboard = Awaited<ReturnType<typeof signedInDashboard>>;

describe("starred projects", () => {
  let dashboard: Dashboard;
  let shop: string;
  let docs: string;
  let blog: string;

  function send(
    cookie: string,
    method: "GET" | "PUT" | "DELETE" | "POST" | "PATCH",
    url: string,
    { origin = PUBLIC_URL, payload }: { origin?: string | null; payload?: object } = {},
  ) {
    return dashboard.app.inject({
      method,
      url,
      headers: {
        cookie,
        ...(origin === null ? {} : { origin }),
        ...(payload === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
    });
  }

  const star = (cookie: string, id: string) => send(cookie, "PUT", `/api/starred-projects/${id}`);
  const unstar = (cookie: string, id: string) =>
    send(cookie, "DELETE", `/api/starred-projects/${id}`);
  const starred = async (cookie: string): Promise<unknown> =>
    (await send(cookie, "GET", "/api/starred-projects")).json();
  const rows = (userId: string) =>
    dashboard.db
      .selectFrom("project_stars")
      .select("project_id")
      .where("user_id", "=", userId)
      .orderBy("created_at")
      .execute()
      .then((list) => list.map((row) => row.project_id));

  let memberCount = 0;
  function member(projects: "all" | readonly string[]) {
    memberCount += 1;
    return signedInUser(dashboard, {
      name: `Member ${memberCount}`,
      email: `star-member-${memberCount}@example.com`,
      grants: { projects, areas: { web_analytics: "view" } },
    });
  }

  beforeAll(async () => {
    dashboard = await signedInDashboard();
    const create = async (name: string): Promise<string> =>
      (await send(dashboard.cookie, "POST", "/api/projects", { payload: { name } })).json().project
        .id;
    shop = await create("Demo shop");
    docs = await create("Docs");
    blog = await create("Blog");
  });

  afterAll(async () => {
    await dashboard?.close();
  });

  test("star, list, star again, and unstar", async () => {
    const { cookie } = dashboard;
    expect(await starred(cookie)).toEqual({ projectIds: [] });

    expect((await star(cookie, docs)).statusCode).toBe(204);
    expect((await star(cookie, shop)).statusCode).toBe(204);
    // Starring again changes nothing, and keeps its place.
    expect((await star(cookie, docs)).statusCode).toBe(204);
    expect(await starred(cookie)).toEqual({ projectIds: [docs, shop] });

    expect((await unstar(cookie, docs)).statusCode).toBe(204);
    // Taking off a star that is not there is no error.
    expect((await unstar(cookie, docs)).statusCode).toBe(204);
    expect(await starred(cookie)).toEqual({ projectIds: [shop] });

    expect((await unstar(cookie, shop)).statusCode).toBe(204);
    expect(await starred(cookie)).toEqual({ projectIds: [] });
  });

  test("each person's stars are their own", async () => {
    const one = await member("all");
    const two = await member("all");
    await star(one.cookie, shop);
    await star(two.cookie, blog);
    await star(dashboard.cookie, docs);

    expect(await starred(one.cookie)).toEqual({ projectIds: [shop] });
    expect(await starred(two.cookie)).toEqual({ projectIds: [blog] });
    expect(await starred(dashboard.cookie)).toEqual({ projectIds: [docs] });

    // Unstarring takes off only the user's own star.
    await unstar(two.cookie, shop);
    expect(await starred(one.cookie)).toEqual({ projectIds: [shop] });
    await unstar(dashboard.cookie, docs);
  });

  test("a project the member may not reach, or none, cannot be starred, and answers as everywhere else", async () => {
    const { userId, cookie } = await member([shop]);
    const refused = await star(cookie, docs);
    expect(refused.statusCode).toBe(404);
    expect(refused.json()).toEqual(NOT_FOUND);
    // An unknown project answers the same.
    const unknown = await star(cookie, randomUUID());
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toEqual(NOT_FOUND);
    expect(await rows(userId)).toEqual([]);

    // Their own project is fine, with any areas or none.
    await setUserAccess(dashboard.db, userId, {
      role: "member",
      projects: [shop],
      areas: { ...ALL_AREAS, web_analytics: "none", product_analytics: "none" },
    });
    expect((await star(cookie, shop)).statusCode).toBe(204);
    expect(await starred(cookie)).toEqual({ projectIds: [shop] });
  });

  test("a member who loses a project no longer sees its star, which is deleted", async () => {
    const { userId, cookie } = await member("all");
    await star(cookie, shop);
    await star(cookie, docs);
    await star(cookie, blog);

    // Their access narrowed to the shop: the other stars go.
    await setUserAccess(dashboard.db, userId, {
      role: "member",
      projects: [shop],
      areas: { ...ALL_AREAS },
    });
    expect(await starred(cookie)).toEqual({ projectIds: [shop] });
    expect(await rows(userId)).toEqual([shop]);

    // Given the docs back, the star does not come back.
    await setUserAccess(dashboard.db, userId, {
      role: "member",
      projects: [shop, docs],
      areas: { ...ALL_AREAS },
    });
    expect(await starred(cookie)).toEqual({ projectIds: [shop] });

    // "All projects", and promotion to admin, keep every star.
    await star(cookie, docs);
    await setUserAccess(dashboard.db, userId, {
      role: "member",
      projects: "all",
      areas: { ...ALL_AREAS },
    });
    await setUserAccess(dashboard.db, userId, { role: "admin" });
    expect(await rows(userId)).toEqual([shop, docs]);
  });

  test("a star left on a project the member cannot reach is not listed", async () => {
    // A row the grants' clean-up did not see (written straight to the database).
    const { userId, cookie } = await member([shop]);
    await dashboard.db
      .insertInto("project_stars")
      .values([
        { user_id: userId, project_id: blog },
        { user_id: userId, project_id: shop },
      ])
      .execute();
    expect(await starred(cookie)).toEqual({ projectIds: [shop] });
  });

  test("the Members page's change of access deletes stars outside it", async () => {
    const { userId, cookie } = await member("all");
    await star(cookie, docs);
    await star(cookie, blog);
    const changed = await send(dashboard.cookie, "PATCH", `/api/members/${userId}`, {
      payload: { role: "member", access: { projects: [blog], areas: { ...ALL_AREAS } } },
    });
    expect(changed.statusCode).toBe(204);
    expect(await rows(userId)).toEqual([blog]);
  });

  test("deleting a project or a user deletes their stars", async () => {
    const temporary = (
      await send(dashboard.cookie, "POST", "/api/projects", { payload: { name: "Temporary" } })
    ).json().project.id as string;
    const { userId, cookie } = await member("all");
    await star(cookie, temporary);
    await star(cookie, shop);
    const deleted = await send(dashboard.cookie, "DELETE", `/api/projects/${temporary}`, {
      payload: { confirmName: "Temporary" },
    });
    expect(deleted.statusCode).toBe(204);
    expect(await rows(userId)).toEqual([shop]);

    await dashboard.db.deleteFrom("dashboard_users").where("id", "=", userId).execute();
    expect(await rows(userId)).toEqual([]);
  });

  test("signed out, from another origin, or with a malformed ID, nothing changes", async () => {
    expect((await star("", shop)).statusCode).toBe(401);
    expect((await send("", "GET", "/api/starred-projects")).statusCode).toBe(401);
    const foreign = await send(dashboard.cookie, "PUT", `/api/starred-projects/${shop}`, {
      origin: "https://attacker.example",
    });
    expect(foreign.statusCode).toBe(403);
    const noOrigin = await send(dashboard.cookie, "DELETE", `/api/starred-projects/${shop}`, {
      origin: null,
    });
    expect(noOrigin.statusCode).toBe(403);
    expect((await star(dashboard.cookie, "not-a-uuid")).statusCode).toBe(400);
    expect(await starred(dashboard.cookie)).toEqual({ projectIds: [] });
  });
});
