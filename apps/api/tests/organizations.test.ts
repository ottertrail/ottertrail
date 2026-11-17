import { randomBytes, randomUUID } from "node:crypto";

import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import { postgresKnowsTimeZone } from "../src/organizations/organizations.ts";
import { PUBLIC_URL, signedInDashboard, signedInUser } from "./helpers/dashboard.ts";
import { createTestDatabase, migrateTestDatabase } from "./helpers/test-database.ts";

const CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";
const NOT_FOUND = { error: "not_found", message: "No project has this ID." };

/** Every route on one project: the access check must guard each of them. */
function projectRoutes(id: string): [string, string, object?][] {
  return [
    ["GET", `/api/projects/${id}`],
    ["PATCH", `/api/projects/${id}`, { name: "Taken over" }],
    ["DELETE", `/api/projects/${id}`, { confirmName: "Bob's site" }],
    ["POST", `/api/projects/${id}/public-key`],
    ["POST", `/api/projects/${id}/secret-key`],
    ["GET", `/api/projects/${id}/analytics?period=7d`],
    ["GET", `/api/projects/${id}/analytics/list?report=pages&period=7d`],
    ["GET", `/api/projects/${id}/users`],
    ["GET", `/api/projects/${id}/users/user-42`],
    ["GET", `/api/projects/${id}/speed?period=7d`],
    ["GET", `/api/projects/${id}/events?period=7d`],
    ["GET", `/api/projects/${id}/events/signup?period=7d`],
    [
      "GET",
      `/api/projects/${id}/funnel?period=7d&steps=${encodeURIComponent(
        JSON.stringify([
          { type: "page", path: "/" },
          { type: "event", name: "signup" },
        ]),
      )}`,
    ],
    ["GET", `/api/projects/${id}/retention?period=30d`],
    ["GET", `/api/projects/${id}/errors?period=7d`],
    ["GET", `/api/projects/${id}/errors/1-0123456789abcdef0123?period=7d`],
    ["PATCH", `/api/projects/${id}/errors/1-0123456789abcdef0123`, { status: "resolved" }],
  ];
}

describe("organizations keep customers apart", () => {
  let dashboard: Awaited<ReturnType<typeof signedInDashboard>>;
  let bob: Awaited<ReturnType<typeof signedInUser>>;
  let carol: Awaited<ReturnType<typeof signedInUser>>;
  /** Ada's project, in Ada's company. */
  let adaProject: { id: string; publicKey: string };
  /** Bob's project, in Bob's shop. */
  let bobProject: { id: string; name: string; publicKey: string };

  function request(cookie: string, method: string, url: string, payload?: object) {
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

  /** The names of the projects a user can see. */
  const projectNames = async (cookie: string) =>
    (await request(cookie, "GET", "/api/projects"))
      .json()
      .projects.map((project: { name: string }) => project.name);

  /** The organizations a user belongs to. */
  const organizationsOf = async (cookie: string) =>
    (await request(cookie, "GET", "/api/organizations")).json().organizations;

  beforeAll(async () => {
    dashboard = await signedInDashboard();
    bob = await signedInUser(
      dashboard,
      { name: "Bob", email: "bob@example.com" },
      { newOrganization: "Bob's shop", timeZone: "Asia/Singapore" },
    );
    carol = await signedInUser(
      dashboard,
      { name: "Carol", email: "carol@example.com" },
      { organizationId: dashboard.organizationId, role: "member" },
    );
    adaProject = (
      await request(dashboard.cookie, "POST", "/api/projects", { name: "Ada's site" })
    ).json().project;
    bobProject = (
      await request(bob.cookie, "POST", "/api/projects", {
        name: "Bob's site",
        allowedHostnames: ["shop.example"],
      })
    ).json().project;
  });

  afterAll(async () => {
    await dashboard?.close();
  });

  test("each user lists only their own organizations' projects", async () => {
    expect(await projectNames(dashboard.cookie)).toEqual(["Ada's site"]);
    expect(await projectNames(bob.cookie)).toEqual(["Bob's site"]);
    // Carol is a member of Ada's company.
    expect(await projectNames(carol.cookie)).toEqual(["Ada's site"]);
  });

  test("every route on another organization's project answers as if it did not exist", async () => {
    const answers = async (id: string) =>
      Promise.all(
        projectRoutes(id).map(async ([method, url, payload]) => {
          const response = await request(dashboard.cookie, method, url, payload);
          return { method, status: response.statusCode, body: response.json() };
        }),
      );
    const toBob = await answers(bobProject.id);
    expect(toBob).toEqual(
      projectRoutes(bobProject.id).map(([method]) => ({ method, status: 404, body: NOT_FOUND })),
    );
    // Exactly the answers for a project that does not exist: IDs reveal nothing.
    expect(await answers(randomUUID())).toEqual(toBob);

    // And Bob's project is untouched.
    const seenByBob = (await request(bob.cookie, "GET", `/api/projects/${bobProject.id}`)).json();
    expect(seenByBob.project).toMatchObject({
      name: "Bob's site",
      publicKey: bobProject.publicKey,
    });
  });

  test("a new project goes into the user's own organization, never another's", async () => {
    const refused = await request(dashboard.cookie, "POST", "/api/projects", {
      name: "Sneaky",
      organizationId: bob.organizationId,
    });
    expect(refused.statusCode).toBe(404);
    expect(refused.json()).toMatchObject({ error: "not_found" });
    const sneaky = await dashboard.db
      .selectFrom("projects")
      .select("id")
      .where("name", "=", "Sneaky")
      .execute();
    expect(sneaky).toEqual([]);
  });

  test("the organization list shows only the user's own, with their role", async () => {
    expect(await organizationsOf(dashboard.cookie)).toMatchObject([
      { id: dashboard.organizationId, name: "Ada's company", role: "owner", timeZone: "UTC" },
    ]);
    expect(await organizationsOf(carol.cookie)).toMatchObject([
      { id: dashboard.organizationId, role: "member" },
    ]);
    expect(await organizationsOf(bob.cookie)).toMatchObject([
      { id: bob.organizationId, name: "Bob's shop", role: "owner", timeZone: "Asia/Singapore" },
    ]);
  });

  test("members use their organization's projects; only its owner changes its settings", async () => {
    expect((await request(carol.cookie, "GET", `/api/projects/${adaProject.id}`)).statusCode).toBe(
      200,
    );
    const byMember = await request(
      carol.cookie,
      "PATCH",
      `/api/organizations/${dashboard.organizationId}`,
      { name: "Carol's now" },
    );
    expect(byMember.statusCode).toBe(403);
    // Nobody outside the organization learns it exists.
    const byOutsider = await request(
      dashboard.cookie,
      "PATCH",
      `/api/organizations/${bob.organizationId}`,
      { name: "Ada's now" },
    );
    expect(byOutsider.statusCode).toBe(404);

    const byOwner = await request(
      dashboard.cookie,
      "PATCH",
      `/api/organizations/${dashboard.organizationId}`,
      { name: "  Ada & Co  " },
    );
    expect(byOwner.json().organization).toMatchObject({ name: "Ada & Co", role: "owner" });
    const names = await dashboard.db.selectFrom("organizations").select("name").execute();
    expect(names.map((row) => row.name).toSorted()).toEqual(["Ada & Co", "Bob's shop"]);
  });

  test("refuses a fixed offset or an unknown name as a timezone", async () => {
    for (const timeZone of ["+08:00", "Mars/Olympus_Mons"]) {
      const response = await request(
        bob.cookie,
        "PATCH",
        `/api/organizations/${bob.organizationId}`,
        { timeZone },
      );
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: "invalid_time_zone" });
    }
  });

  test("a new timezone applies at once: to reports, and to the next visitor IDs", async () => {
    const event = () => ({
      v: 1,
      key: bobProject.publicKey,
      sentAt: Date.now(),
      events: [
        {
          id: randomUUID(),
          name: "pageview",
          occurredAt: Date.now(),
          url: "https://shop.example/",
        },
      ],
    });
    const collect = () =>
      dashboard.app.inject({
        method: "POST",
        url: "/api/events",
        headers: { "content-type": "text/plain", "user-agent": CHROME },
        payload: JSON.stringify(event()),
      });
    // The collection endpoint caches the project, with its timezone.
    expect((await collect()).statusCode).toBe(202);

    const changed = await request(bob.cookie, "PATCH", `/api/organizations/${bob.organizationId}`, {
      timeZone: "US/Pacific",
    });
    // Old names become their current official one.
    expect(changed.json().organization).toMatchObject({ timeZone: "America/Los_Angeles" });

    expect((await collect()).statusCode).toBe(202);
    const zones = await dashboard.db
      .selectFrom("visitor_salts")
      .select("time_zone")
      .distinct()
      .orderBy("time_zone")
      .execute();
    expect(zones.map((row) => row.time_zone)).toEqual(["America/Los_Angeles", "Asia/Singapore"]);

    const report = await request(
      bob.cookie,
      "GET",
      `/api/projects/${bobProject.id}/analytics?period=today`,
    );
    expect(report.json().timeZone).toBe("America/Los_Angeles");
  });

  test("someone in no organization cannot create a project; someone in two must say which", async () => {
    const dave = await signedInUser(dashboard, { name: "Dave", email: "dave@example.com" }, null);
    const nowhere = await request(dave.cookie, "POST", "/api/projects", { name: "Lost" });
    expect(nowhere.statusCode).toBe(400);
    expect(nowhere.json()).toMatchObject({ error: "organization_required" });

    const erin = await signedInUser(
      dashboard,
      { name: "Erin", email: "erin@example.com" },
      { newOrganization: "Erin's studio" },
    );
    await dashboard.db
      .insertInto("memberships")
      .values({ organization_id: dashboard.organizationId, user_id: erin.userId, role: "member" })
      .execute();
    const unclear = await request(erin.cookie, "POST", "/api/projects", { name: "Which?" });
    expect(unclear.statusCode).toBe(400);
    expect(unclear.json()).toMatchObject({ error: "organization_required" });

    const named = await request(erin.cookie, "POST", "/api/projects", {
      name: "Studio site",
      organizationId: erin.organizationId,
    });
    expect(named.statusCode).toBe(201);
    expect(named.json().project).toMatchObject({ organizationId: erin.organizationId });
  });
});

/** A test database migrated back to just before organizations. */
async function beforeOrganizations() {
  const testDb = await createTestDatabase();
  await migrateTestDatabase(testDb, "0009_add_project_retention");
  return testDb;
}

describe("postgresKnowsTimeZone", () => {
  test("asks PostgreSQL, whose timezone database can differ from Node's", async () => {
    const testDb = await createTestDatabase();
    try {
      expect(await postgresKnowsTimeZone(testDb.db, "UTC")).toBe(true);
      expect(await postgresKnowsTimeZone(testDb.db, "America/Los_Angeles")).toBe(true);
      expect(await postgresKnowsTimeZone(testDb.db, "Nowhere/Nothing")).toBe(false);
    } finally {
      await testDb.destroy();
    }
  });
});

describe("migration 0010", () => {
  test("names the organization after an owner with a long name within its 100 characters", async () => {
    const testDb = await beforeOrganizations();
    try {
      await sql`
        insert into dashboard_users (name, email, role)
        values (${"A".repeat(200)}, 'long@example.com', 'owner')
      `.execute(testDb.db);
      await migrateTestDatabase(testDb, "latest");
      const [organization] = await testDb.db.selectFrom("organizations").select("name").execute();
      expect(organization?.name).toBe(`${"A".repeat(85)}'s organization`);
    } finally {
      await testDb.destroy();
    }
  });

  test("going back keeps the salts of the deployment's timezone, which the old code uses", async () => {
    const testDb = await createTestDatabase();
    try {
      for (const time_zone of ["America/New_York", "UTC"]) {
        await testDb.db
          .insertInto("visitor_salts")
          .values({ time_zone, day: "2026-11-16", salt: randomBytes(32) })
          .execute();
      }
      // TIMEZONE is unset in the tests: UTC.
      await migrateTestDatabase(testDb, "0009_add_project_retention");
      const { rows } = await sql<{ day: string }>`select day::text from visitor_salts`.execute(
        testDb.db,
      );
      expect(rows).toEqual([{ day: "2026-11-16" }]);
      const { rows: zones } = await sql<{ count: string }>`
        select count(*) from information_schema.columns
        where table_schema = ${testDb.schema} and table_name = 'visitor_salts' and column_name = 'time_zone'
      `.execute(testDb.db);
      expect(zones[0]?.count).toBe("0");
    } finally {
      await testDb.destroy();
    }
  });

  test("moves existing projects, users, and salts into one organization in TIMEZONE", async () => {
    const testDb = await createTestDatabase();
    const timeZoneBefore = process.env.TIMEZONE;
    try {
      // The database as it was before organizations existed.
      await migrateTestDatabase(testDb, "0009_add_project_retention");
      await sql`
        insert into dashboard_users (name, email, role)
        values ('Ada', 'ada@example.com', 'owner'), ('Bea', 'bea@example.com', 'member')
      `.execute(testDb.db);
      await sql`insert into projects (name) values ('Old site'), ('Old shop')`.execute(testDb.db);
      await sql`
        insert into visitor_salts (day, salt) values ('2026-11-16', ${randomBytes(32)})
      `.execute(testDb.db);

      process.env.TIMEZONE = "singapore";
      await migrateTestDatabase(testDb, "latest");

      const organizations = await testDb.db.selectFrom("organizations").selectAll().execute();
      expect(organizations).toMatchObject([
        { name: "Ada's organization", time_zone: "Asia/Singapore" },
      ]);
      const organizationId = organizations[0]?.id;
      const projects = await testDb.db.selectFrom("projects").select("organization_id").execute();
      expect(projects).toEqual([
        { organization_id: organizationId },
        { organization_id: organizationId },
      ]);
      const memberships = await testDb.db
        .selectFrom("memberships")
        .innerJoin("dashboard_users", "dashboard_users.id", "memberships.user_id")
        .select(["dashboard_users.name", "memberships.role"])
        .orderBy("dashboard_users.name")
        .execute();
      expect(memberships).toEqual([
        { name: "Ada", role: "owner" },
        { name: "Bea", role: "member" },
      ]);
      // The salt keeps working: the day boundary did not move.
      const salts = await testDb.db
        .selectFrom("visitor_salts")
        .select(["time_zone", "day"])
        .execute();
      expect(salts).toEqual([{ time_zone: "Asia/Singapore", day: "2026-11-16" }]);
    } finally {
      if (timeZoneBefore === undefined) {
        delete process.env.TIMEZONE;
      } else {
        process.env.TIMEZONE = timeZoneBefore;
      }
      await testDb.destroy();
    }
  });

  test("creates no organization for an empty database", async () => {
    const testDb = await createTestDatabase();
    try {
      expect(await testDb.db.selectFrom("organizations").selectAll().execute()).toEqual([]);
    } finally {
      await testDb.destroy();
    }
  });
});
