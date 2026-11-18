import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import type { AccessDeclaration } from "../src/access/access.ts";
import { ALL_AREAS, type Area, AREA_LEVELS, AREAS, type Areas } from "../src/access/areas.ts";
import { setUserAccess } from "../src/access/grants.ts";
import { grantMember, PUBLIC_URL, signedInDashboard, signedInUser } from "./helpers/dashboard.ts";
import { PROJECT_REQUESTS, type ProjectRequest, routeKey } from "./helpers/project-routes.ts";
import { registeredRoutes } from "./helpers/routes.ts";
import { createTestDatabase, migrateTestDatabase } from "./helpers/test-database.ts";

const NOT_FOUND = { error: "not_found", message: "No project has this ID." };
const FORBIDDEN = { error: "forbidden", message: "You don't have access to this." };

type Dashboard = Awaited<ReturnType<typeof signedInDashboard>>;

describe("members, admins, and the one access check", () => {
  let dashboard: Dashboard;
  let site: { id: string };
  let other: { id: string };
  /** Each project route's request, with what the route declares. */
  let requests: (ProjectRequest & { declaration: AccessDeclaration })[];

  const rules = (path = "") => `/api/projects/${site.id}/alert-rules${path}`;

  function send(cookie: string, method: string, url: string, payload?: object) {
    return dashboard.app.inject({
      method: method as "GET",
      url,
      headers: {
        cookie,
        origin: PUBLIC_URL,
        ...(payload === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
    });
  }

  /** The routes that need `area`, at `level` when given. */
  const routesOf = (area: Area, level?: "view" | "manage") =>
    requests.filter(({ declaration }) => {
      const { need } = declaration;
      return (
        declaration.scope === "project" &&
        typeof need === "object" &&
        "area" in need &&
        need.area === area &&
        (level === undefined || need.level === level)
      );
    });

  /** Sends each request on `projectId`, one at a time, and answers status and body. */
  async function answers(cookie: string, projectId: string, list: readonly ProjectRequest[]) {
    const results = [];
    for (const { method, route, url, payload } of list) {
      const response = await send(cookie, method, url(projectId), payload);
      const body: unknown = response.headers["content-type"]?.includes("json")
        ? response.json()
        : null;
      results.push({ key: routeKey(method, route), status: response.statusCode, body });
    }
    return results;
  }

  /** A member with every area at its most, but `changes`, on `projects`. */
  async function member(
    email: string,
    changes: Partial<Areas>,
    projects: "all" | readonly string[] = [site.id],
  ) {
    return signedInUser(dashboard, {
      name: email,
      email,
      grants: { projects, areas: { ...ALL_AREAS, ...changes } },
    });
  }

  beforeAll(async () => {
    dashboard = await signedInDashboard();
    const create = async (name: string) =>
      (
        await send(dashboard.cookie, "POST", "/api/projects", {
          name,
          allowedHostnames: [`${name.toLowerCase().replace(/\s/g, "-")}.example`],
        })
      ).json().project;
    site = await create("Some site");
    other = await create("Other site");
    const routes = await registeredRoutes();
    requests = PROJECT_REQUESTS.map((request) => {
      const declaration = routes.get(routeKey(request.method, request.route))?.[0];
      if (declaration === undefined) throw new Error(`${request.route} declares nothing`);
      return { ...request, declaration };
    });
  });

  afterAll(async () => {
    await dashboard?.close();
  });

  test.each(AREAS)("a member without %s is refused, with 403, on its routes", async (area) => {
    const { cookie } = await member(`without-${area}@example.com`, { [area]: "none" });
    const list = routesOf(area);
    expect(list.length).toBeGreaterThan(0);
    expect(await answers(cookie, site.id, list)).toEqual(
      list.map(({ method, route }) => ({
        key: routeKey(method, route),
        status: 403,
        body: FORBIDDEN,
      })),
    );
  });

  test.each(AREAS.filter((area) => AREA_LEVELS[area].includes("manage")))(
    "a member who views %s is refused its manage routes, and reaches its view routes",
    async (area) => {
      const { cookie } = await member(`view-${area}@example.com`, { [area]: "view" });
      const manage = routesOf(area, "manage");
      expect(manage.length).toBeGreaterThan(0);
      expect(await answers(cookie, site.id, manage)).toEqual(
        manage.map(({ method, route }) => ({
          key: routeKey(method, route),
          status: 403,
          body: FORBIDDEN,
        })),
      );
      // Past the check: whatever the route answers, it is not the check's refusal.
      const refusals = (await answers(cookie, site.id, routesOf(area, "view"))).filter(
        ({ status, body }) =>
          status === 401 || status === 403 || JSON.stringify(body) === JSON.stringify(NOT_FOUND),
      );
      expect(refusals).toEqual([]);
    },
  );

  test("a project the member is not granted answers exactly as an unknown project", async () => {
    const { cookie } = await member("one-project@example.com", {});
    expect(await answers(cookie, other.id, requests)).toEqual(
      requests.map(({ method, route }) => ({
        key: routeKey(method, route),
        status: 404,
        body: NOT_FOUND,
      })),
    );
    expect((await send(cookie, "GET", "/api/projects")).json()).toEqual({
      projects: [
        { id: site.id, name: "Some site", createdAt: expect.any(String), lastEventAt: null },
      ],
    });
  });

  test("a member sees a project's name but never its keys or settings, and cannot change it", async () => {
    const { cookie } = await member("everything@example.com", {}, "all");
    const projects = (await send(cookie, "GET", "/api/projects")).json().projects;
    expect(projects.map((project: { name: string }) => project.name)).toEqual([
      "Some site",
      "Other site",
    ]);
    expect(Object.keys(projects[0]).toSorted()).toEqual(["createdAt", "id", "lastEventAt", "name"]);
    expect(
      Object.keys((await send(cookie, "GET", `/api/projects/${site.id}`)).json().project),
    ).toHaveLength(4);
    const settings = requests.filter(
      ({ declaration }) => typeof declaration.need === "object" && "permission" in declaration.need,
    );
    expect(settings.map(({ method, route }) => routeKey(method, route)).toSorted()).toEqual([
      "DELETE /api/projects/:id",
      "DELETE /api/projects/:id/replays",
      "PATCH /api/projects/:id",
      "POST /api/projects/:id/public-key",
      "POST /api/projects/:id/secret-key",
    ]);
    expect(await answers(cookie, site.id, settings)).toEqual(
      settings.map(({ method, route }) => ({
        key: routeKey(method, route),
        status: 403,
        body: FORBIDDEN,
      })),
    );
    for (const [method, url, payload] of [
      ["POST", "/api/projects", { name: "Mine" }],
      ["GET", "/api/channels"],
      ["GET", "/api/settings"],
      ["PATCH", "/api/settings", { name: "Mine" }],
    ] as const) {
      const response = await send(cookie, method, url, payload);
      expect({ url, status: response.statusCode, body: response.json() }).toEqual({
        url,
        status: 403,
        body: FORBIDDEN,
      });
    }
  });

  test("a project created later is in a member's 'all projects', not in a list", async () => {
    const all = await member("all-later@example.com", {}, "all");
    const listed = await member("listed-later@example.com", {}, [site.id]);
    const later = (
      await send(dashboard.cookie, "POST", "/api/projects", { name: "Later site" })
    ).json().project;
    expect((await send(all.cookie, "GET", `/api/projects/${later.id}`)).statusCode).toBe(200);
    expect((await send(listed.cookie, "GET", `/api/projects/${later.id}`)).json()).toEqual(
      NOT_FOUND,
    );
  });

  test("an admin manages projects and channels, but not the instance's settings", async () => {
    const { cookie } = await signedInUser(dashboard, {
      name: "Ada Admin",
      email: "admin@example.com",
      role: "admin",
    });
    const project = (await send(cookie, "GET", `/api/projects/${site.id}`)).json().project;
    expect(project).toMatchObject({ id: site.id, publicKey: expect.any(String) });
    expect(project.secretKey).toEqual(expect.any(String));
    expect((await send(cookie, "GET", "/api/channels")).statusCode).toBe(200);
    expect(
      (await send(cookie, "PATCH", `/api/projects/${site.id}`, { name: "Some site" })).statusCode,
    ).toBe(200);
    expect((await send(cookie, "GET", "/api/settings")).json()).toEqual(FORBIDDEN);
    expect((await send(cookie, "PATCH", "/api/settings", { name: "Mine" })).json()).toEqual(
      FORBIDDEN,
    );
  });

  test("/api/me says who is signed in and what they may reach", async () => {
    const { userId, cookie } = await member("me@example.com", {
      replays: "none",
      users: "none",
      errors: "view",
    });
    expect((await send(cookie, "GET", "/api/me")).json()).toEqual({
      user: { id: userId, name: "me@example.com", email: "me@example.com", role: "member" },
      instance: { name: "Ada's company", timeZone: "UTC" },
      access: {
        projects: [site.id],
        areas: { ...ALL_AREAS, replays: "none", users: "none", errors: "view" },
      },
      permissions: {
        settings: false,
        ownership: false,
        members: false,
        channels: false,
        projects: false,
      },
    });
    expect((await send(dashboard.cookie, "GET", "/api/me")).json()).toMatchObject({
      user: { role: "owner" },
      access: { projects: "all", areas: ALL_AREAS },
      permissions: {
        settings: true,
        ownership: true,
        members: true,
        channels: true,
        projects: true,
      },
    });
  });

  test("a change to a member's grants applies on their next request", async () => {
    const { userId, cookie } = await member("changing@example.com", { users: "none" });
    const url = `/api/projects/${site.id}/users`;
    expect((await send(cookie, "GET", url)).statusCode).toBe(403);
    await grantMember(dashboard.db, userId, { projects: [site.id], areas: { users: "view" } });
    expect((await send(cookie, "GET", url)).statusCode).toBe(200);
    await grantMember(dashboard.db, userId, { projects: [], areas: { users: "view" } });
    expect((await send(cookie, "GET", url)).json()).toEqual(NOT_FOUND);
  });

  test("a member with no grants row reaches nothing; a deleted user is signed out at once", async () => {
    const { userId, cookie } = await signedInUser(dashboard, {
      name: "Nobody",
      email: "nobody@example.com",
    });
    expect((await send(cookie, "GET", "/api/projects")).json()).toEqual({ projects: [] });
    expect((await send(cookie, "GET", `/api/projects/${site.id}/errors?period=7d`)).json()).toEqual(
      NOT_FOUND,
    );
    await dashboard.db.deleteFrom("dashboard_users").where("id", "=", userId).execute();
    expect((await send(cookie, "GET", "/api/me")).statusCode).toBe(401);
    expect(
      await dashboard.db
        .selectFrom("dashboard_sessions")
        .select("id")
        .where("user_id", "=", userId)
        .execute(),
    ).toEqual([]);
  });

  test("goals stay out of web analytics for a member without product analytics", async () => {
    const goal = await send(dashboard.cookie, "POST", `/api/projects/${site.id}/goals`, {
      name: "Pricing",
      step: { type: "page", path: "/pricing" },
    });
    expect(goal.statusCode).toBe(201);
    const url = `/api/projects/${site.id}/analytics?period=7d`;
    expect((await send(dashboard.cookie, "GET", url)).json().goals).toHaveLength(1);
    const { cookie } = await member("no-product@example.com", { product_analytics: "none" });
    expect((await send(cookie, "GET", url)).json().goals).toEqual([]);
  });

  test("a member who manages an area changes it", async () => {
    const { cookie } = await member("marketing@example.com", {
      product_analytics: "manage",
    });
    const goal = await send(cookie, "POST", `/api/projects/${site.id}/goals`, {
      name: "Signup",
      step: { type: "event", name: "signup" },
    });
    expect(goal.statusCode).toBe(201);
    expect(
      (await send(cookie, "DELETE", `/api/projects/${site.id}/goals/${goal.json().goal.id}`))
        .statusCode,
    ).toBe(204);
  });

  test("the sign-in time is recorded", async () => {
    const { userId } = await member("signed-in@example.com", {});
    const row = await dashboard.db
      .selectFrom("dashboard_users")
      .select("last_sign_in_at")
      .where("id", "=", userId)
      .executeTakeFirstOrThrow();
    expect(row.last_sign_in_at).toBeInstanceOf(Date);
  });

  test("an instance has one owner, and roles are owner, admin, or member", async () => {
    await expect(
      dashboard.db
        .insertInto("dashboard_users")
        .values({ name: "Second", email: "second@example.com", role: "owner" })
        .execute(),
    ).rejects.toThrow(/dashboard_users_one_owner_idx/);
    await expect(
      dashboard.db
        .insertInto("dashboard_users")
        .values({ name: "Odd", email: "odd@example.com", role: "root" as "admin" })
        .execute(),
    ).rejects.toThrow(/dashboard_users_role_check/);
  });

  test("an area with nothing to change takes no manage level", async () => {
    const { userId } = await member("checked@example.com", {});
    await expect(
      dashboard.db
        .updateTable("dashboard_member_access")
        .set({ monitoring: "manage" as "view" })
        .where("user_id", "=", userId)
        .execute(),
    ).rejects.toThrow(/dashboard_member_access_monitoring_check/);
  });

  describe("alert rules show only the areas they watch", () => {
    const NO_RULE = { error: "rule_not_found", message: expect.any(String) };
    let channelId: string;
    let errorRule: string;
    let routeRule: string;
    let checkRule: string;

    beforeAll(async () => {
      channelId = (
        await send(dashboard.cookie, "POST", "/api/channels", {
          kind: "email",
          addresses: ["ops@example.com"],
        })
      ).json().channel.id;
      const create = async (body: object) =>
        (await send(dashboard.cookie, "POST", rules(), { ...body, channelIds: [channelId] })).json()
          .rule.id as string;
      errorRule = await create({ kind: "error_new" });
      routeRule = await create({
        kind: "route_latency",
        settings: { service: "checkout", thresholdMs: 500 },
      });
      checkRule = await create({ kind: "check_down" });
      // An alert of each kind, firing, as the worker would leave them.
      for (const [ruleId, message] of [
        [errorRule, "New error: No account for jane.doe@example.com"],
        [routeRule, "GET /orders/{id} in checkout is slow"],
        [checkRule, "Shop: the check is down."],
      ] as const) {
        const history = await dashboard.db
          .insertInto("alert_history")
          .values({
            rule_id: ruleId,
            project_id: site.id,
            subject: ruleId,
            subject_name: "Subject",
            fired_at: new Date(),
            message,
          })
          .returning("id")
          .executeTakeFirstOrThrow();
        await dashboard.db
          .insertInto("alert_states")
          .values({
            rule_id: ruleId,
            subject: ruleId,
            firing: true,
            since: new Date(),
            history_id: history.id,
          })
          .execute();
      }
    });

    test("a member without errors or monitoring sees, creates, and changes check rules only", async () => {
      const { cookie } = await member("alerts-only@example.com", {
        errors: "none",
        monitoring: "none",
        uptime_alerts: "manage",
      });
      const listed = (await send(cookie, "GET", rules())).json().rules;
      expect(listed.map((rule: { id: string }) => rule.id)).toEqual([checkRule]);
      for (const ruleId of [errorRule, routeRule]) {
        for (const [method, path, payload] of [
          ["GET", `/${ruleId}`],
          ["GET", `/${ruleId}/history`],
          ["PATCH", `/${ruleId}`, { enabled: false }],
          ["DELETE", `/${ruleId}`],
        ] as const) {
          const response = await send(cookie, method, rules(path), payload);
          expect({ method, path, status: response.statusCode, body: response.json() }).toEqual({
            method,
            path,
            status: 404,
            body: NO_RULE,
          });
        }
      }
      for (const body of [
        { kind: "error_new" },
        { kind: "error_spike", settings: { threshold: 5, windowMinutes: 10 } },
        { kind: "route_latency", settings: { service: "checkout", thresholdMs: 500 } },
        { kind: "metric_threshold", settings: { metric: "m", metricKind: "gauge", value: 1 } },
      ]) {
        const response = await send(cookie, "POST", rules(), { ...body, channelIds: [channelId] });
        expect({ kind: body.kind, status: response.statusCode, body: response.json() }).toEqual({
          kind: body.kind,
          status: 403,
          body: FORBIDDEN,
        });
      }
      // Turning a check rule into an error rule is refused too.
      expect(
        (await send(cookie, "PATCH", rules(`/${checkRule}`), { kind: "error_new" })).json(),
      ).toEqual(FORBIDDEN);
      const created = await send(cookie, "POST", rules(), {
        kind: "certificate_expiring",
        channelIds: [channelId],
      });
      expect(created.statusCode).toBe(201);
      expect(created.json().warning).toBeNull();

      const alerts = (await send(cookie, "GET", `/api/projects/${site.id}/alerts`)).json().alerts;
      expect(alerts.map((alert: { message: string }) => alert.message)).toEqual([
        "Shop: the check is down.",
      ]);
      const firing = (await send(cookie, "GET", `/api/projects/${site.id}/alerts/firing`)).json()
        .alerts;
      expect(firing.map((alert: { ruleId: string }) => alert.ruleId)).toEqual([checkRule]);
    });

    test("errors at view adds error rules; monitoring at view adds telemetry rules and the warning", async () => {
      const errors = await member("alerts-errors@example.com", {
        errors: "view",
        monitoring: "none",
        uptime_alerts: "manage",
      });
      const listed = (await send(errors.cookie, "GET", rules())).json().rules;
      expect(listed.map((rule: { kind: string }) => rule.kind).toSorted()).toEqual(
        expect.arrayContaining(["check_down", "error_new"]),
      );
      expect(listed.some((rule: { kind: string }) => rule.kind === "route_latency")).toBe(false);
      expect(
        (await send(errors.cookie, "GET", `/api/projects/${site.id}/alerts`)).json().alerts,
      ).toContainEqual(
        expect.objectContaining({ message: "New error: No account for jane.doe@example.com" }),
      );
      expect(
        (
          await send(errors.cookie, "POST", rules(), {
            kind: "error_regressed",
            channelIds: [channelId],
          })
        ).statusCode,
      ).toBe(201);

      const monitoring = await member("alerts-monitoring@example.com", {
        errors: "none",
        monitoring: "view",
        uptime_alerts: "manage",
      });
      const created = await send(monitoring.cookie, "POST", rules(), {
        kind: "route_latency",
        settings: { service: "nothing-reported", thresholdMs: 500 },
        channelIds: [channelId],
      });
      expect(created.statusCode).toBe(201);
      // Nothing of the service arrived: the warning says so to those who read monitoring.
      expect(created.json().warning).not.toBeNull();
      expect((await send(monitoring.cookie, "GET", rules(`/${errorRule}`))).statusCode).toBe(404);
    });
  });

  test("the instance's storage totals go only to those who manage projects", async () => {
    const { cookie } = await member("storage@example.com", {});
    const admin = await signedInUser(dashboard, {
      name: "Storage Admin",
      email: "storage-admin@example.com",
      role: "admin",
    });
    for (const path of ["replays", "source-maps"]) {
      const url = `/api/projects/${site.id}/${path}`;
      expect((await send(cookie, "GET", url)).json()).not.toHaveProperty("instance");
      expect((await send(admin.cookie, "GET", url)).json()).toHaveProperty("instance", {
        storedBytes: expect.any(Number),
        limitBytes: expect.any(Number),
      });
    }
  });

  test("errors and a user's activity carry no replay for a member without replays", async () => {
    const fingerprint = "1-0123456789abcdef0123";
    await dashboard.store(site.id, [
      {
        eventId: randomUUID(),
        name: "error",
        occurredAt: new Date(),
        path: "/checkout",
        userId: "ada",
        error: {
          type: "TypeError",
          message: "x is undefined",
          handled: false,
          fingerprint,
          replayId: randomUUID(),
        },
      },
    ]);
    const errorUrl = `/api/projects/${site.id}/errors/${fingerprint}?period=7d`;
    const userUrl = `/api/projects/${site.id}/users/ada`;
    const replaysOf = async (cookie: string) => ({
      error: (await send(cookie, "GET", errorUrl))
        .json()
        .occurrences.map((occurrence: { replay: unknown }) => occurrence.replay),
      user: (await send(cookie, "GET", userUrl))
        .json()
        .activity.map((activity: { replay: unknown }) => activity.replay),
    });
    expect(await replaysOf(dashboard.cookie)).toEqual({
      error: [{ id: expect.any(String), status: expect.any(String) }],
      user: [{ id: expect.any(String), status: expect.any(String) }],
    });
    const { cookie } = await member("no-replays@example.com", { replays: "none" });
    expect(await replaysOf(cookie)).toEqual({ error: [null], user: [null] });
    expect((await send(cookie, "GET", userUrl)).json().replays).toEqual([]);
  });

  test("/alert-channels answers each channel's ID, name, and kind only", async () => {
    await send(dashboard.cookie, "POST", "/api/channels", {
      kind: "email",
      name: "On call",
      addresses: ["oncall@example.com"],
    });
    const { cookie } = await member("channel-names@example.com", { uptime_alerts: "view" });
    const { channels } = (
      await send(cookie, "GET", `/api/projects/${site.id}/alert-channels`)
    ).json();
    expect(channels.length).toBeGreaterThan(0);
    for (const channel of channels) {
      expect(Object.keys(channel).toSorted()).toEqual(["id", "kind", "name"]);
    }
  });

  test("setUserAccess leaves no old grant behind, and never changes the owner", async () => {
    const { userId } = await member("changes@example.com", {}, [site.id, other.id]);
    const grants = async () => ({
      access: await dashboard.db
        .selectFrom("dashboard_member_access")
        .select(["all_projects", "errors"])
        .where("user_id", "=", userId)
        .execute(),
      projects: (
        await dashboard.db
          .selectFrom("dashboard_member_projects")
          .select("project_id")
          .where("user_id", "=", userId)
          .execute()
      )
        .map((row) => row.project_id)
        .toSorted(),
    });
    expect((await grants()).projects).toEqual([site.id, other.id].toSorted());

    expect(await setUserAccess(dashboard.db, userId, { role: "admin" })).toBe(true);
    expect(await grants()).toEqual({ access: [], projects: [] });
    // Back to a member: only what is given now, not what they had.
    const areas = { ...ALL_AREAS, errors: "view" as const };
    await setUserAccess(dashboard.db, userId, { role: "member", projects: [site.id], areas });
    expect(await grants()).toEqual({
      access: [{ all_projects: false, errors: "view" }],
      projects: [site.id],
    });
    await setUserAccess(dashboard.db, userId, { role: "member", projects: "all", areas });
    expect(await grants()).toEqual({
      access: [{ all_projects: true, errors: "view" }],
      projects: [],
    });
    // A project deleted meanwhile is dropped.
    await setUserAccess(dashboard.db, userId, {
      role: "member",
      projects: [site.id, randomUUID()],
      areas,
    });
    expect((await grants()).projects).toEqual([site.id]);

    const owner = await dashboard.db
      .selectFrom("dashboard_users")
      .select("id")
      .where("role", "=", "owner")
      .executeTakeFirstOrThrow();
    expect(await setUserAccess(dashboard.db, owner.id, { role: "admin" })).toBe(false);
  });

  test("an invitation's email is stored in lower case only", async () => {
    const owner = await dashboard.db
      .selectFrom("dashboard_users")
      .select("id")
      .where("role", "=", "owner")
      .executeTakeFirstOrThrow();
    await expect(
      dashboard.db
        .insertInto("dashboard_invitations")
        .values({
          token_hash: Buffer.from("a"),
          email: "Jane@Example.com",
          role: "member",
          invited_by: owner.id,
          expires_at: new Date(),
        })
        .execute(),
    ).rejects.toThrow(/dashboard_invitations_email_check/);
  });
});

test("rolling back 0006 deletes every user but the owner, who had full access before", async () => {
  const testDb = await createTestDatabase();
  try {
    await testDb.db
      .insertInto("dashboard_users")
      .values([
        { name: "Owner", email: "owner@example.com", role: "owner" },
        { name: "Admin", email: "admin@example.com", role: "admin" },
        { name: "Member", email: "member@example.com", role: "member" },
      ])
      .execute();
    await migrateTestDatabase(testDb, "0005_replay_details");
    const left = await testDb.db.selectFrom("dashboard_users").select("email").execute();
    expect(left).toEqual([{ email: "owner@example.com" }]);
    await migrateTestDatabase(testDb, "latest");
  } finally {
    await testDb.destroy();
  }
});
