import { randomUUID } from "node:crypto";

import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import { parseLocationHeaderName } from "../src/collection/location-headers.ts";
import { migrations } from "../src/db/migrations/index.ts";
import { updateProject } from "../src/projects/projects.ts";
import { PUBLIC_URL, signedInDashboard, signedInUser } from "./helpers/dashboard.ts";
import { storedEvents } from "./helpers/events.ts";
import { insertProject } from "./helpers/projects.ts";
import {
  createTestDatabase,
  migrateTestDatabase,
  MIGRATION_TEST_MS,
} from "./helpers/test-database.ts";

const SITE = "example.com";
const CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";
const NO_HEADERS = { country: null, region: null, city: null };

let dashboard: Awaited<ReturnType<typeof signedInDashboard>>;

beforeAll(async () => {
  // Behind a proxy, as with Caddy: location headers count only then.
  dashboard = await signedInDashboard({ trustProxy: true });
});

afterAll(async () => {
  await dashboard?.close();
});

async function newProject() {
  return insertProject(dashboard.db, {
    name: `Site ${randomUUID().slice(0, 8)}`,
    allowed_hostnames: [SITE],
  });
}

function patch(projectId: string, body: object, cookie = dashboard.cookie) {
  return dashboard.app.inject({
    method: "PATCH",
    url: `/api/projects/${projectId}`,
    headers: { cookie, origin: PUBLIC_URL, "content-type": "application/json" },
    payload: JSON.stringify(body),
  });
}

async function read(projectId: string, cookie = dashboard.cookie) {
  return dashboard.app.inject({
    method: "GET",
    url: `/api/projects/${projectId}`,
    headers: { cookie },
  });
}

describe("a project's location source", () => {
  test("is database by default, with no header names", async () => {
    const project = await newProject();
    expect((await read(project.id)).json().project).toMatchObject({
      locationSource: "database",
      locationHeaders: NO_HEADERS,
    });
  });

  test("the owner chooses headers, with names in lower case, then off; the names stay", async () => {
    const project = await newProject();
    const headers = await patch(project.id, {
      locationSource: "headers",
      locationHeaders: { country: " X-Visitor-Country ", region: "", city: "x-visitor-city" },
    });
    expect(headers.statusCode).toBe(200);
    expect(headers.json().project).toMatchObject({
      locationSource: "headers",
      locationHeaders: { country: "x-visitor-country", region: null, city: "x-visitor-city" },
    });
    const off = await patch(project.id, { locationSource: "off" });
    expect(off.json().project).toMatchObject({
      locationSource: "off",
      locationHeaders: { country: "x-visitor-country", region: null, city: "x-visitor-city" },
    });
    // Back to headers: the names are still there.
    expect((await patch(project.id, { locationSource: "headers" })).statusCode).toBe(200);
  });

  test("headers needs the country header", async () => {
    const project = await newProject();
    for (const body of [
      { locationSource: "headers" },
      { locationSource: "headers", locationHeaders: { ...NO_HEADERS, city: "x-visitor-city" } },
      { locationSource: "headers", locationHeaders: { ...NO_HEADERS, country: "  " } },
    ]) {
      const refused = await patch(project.id, body);
      expect(refused.statusCode).toBe(400);
      expect(refused.json()).toMatchObject({ error: "country_header_required" });
    }
    // Clearing the country while headers is chosen is refused too.
    await patch(project.id, {
      locationSource: "headers",
      locationHeaders: { ...NO_HEADERS, country: "x-visitor-country" },
    });
    const cleared = await patch(project.id, { locationHeaders: NO_HEADERS });
    expect(cleared.json()).toMatchObject({ error: "country_header_required" });
    expect((await read(project.id)).json().project.locationHeaders.country).toBe(
      "x-visitor-country",
    );
  });

  test("a change that races another and leaves headers without a country is refused, not a 500", async () => {
    const project = await newProject();
    await patch(project.id, {
      locationSource: "headers",
      locationHeaders: { ...NO_HEADERS, country: "x-visitor-country" },
    });
    // As if another request had chosen headers after this one read the project.
    expect(await updateProject(dashboard.db, project.id, { locationHeaders: NO_HEADERS })).toBe(
      "country_header_required",
    );
    expect((await read(project.id)).json().project.locationHeaders.country).toBe(
      "x-visitor-country",
    );
  });

  test.each([
    ["an address header", "cf-connecting-ip"],
    ["the standard address header", "Forwarded"],
    ["a header Node keeps once", "last-modified"],
    ["spaces", "x visitor"],
    ["an underscore", "x_visitor_country"],
    ["a colon", "x-country:"],
    ["non-ASCII", "x-länd"],
    ["too long", `x-${"a".repeat(63)}`],
    ["X-Forwarded-For", "X-Forwarded-For"],
    ["the trust header", "x-ottertrail-trusted-proxy"],
    ["a hop-by-hop header", "Connection"],
    ["another hop-by-hop header", "transfer-encoding"],
  ])("refuses a header name with %s", async (_, name) => {
    const project = await newProject();
    const refused = await patch(project.id, {
      locationSource: "headers",
      locationHeaders: { country: "x-visitor-country", region: name, city: null },
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({ error: "invalid_header_name" });
    expect((await read(project.id)).json().project.locationSource).toBe("database");
  });

  test("refuses an unknown source, and header fields missing", async () => {
    const project = await newProject();
    for (const body of [
      { locationSource: "cloudflare" },
      { locationSource: null },
      { locationHeaders: { country: "x-visitor-country" } },
    ]) {
      expect((await patch(project.id, body)).statusCode).toBe(400);
    }
  });

  test("a header name is at most 64 characters", () => {
    expect(parseLocationHeaderName(`x-${"a".repeat(62)}`)).toMatchObject({ ok: true });
    expect(parseLocationHeaderName(`x-${"a".repeat(63)}`)).toMatchObject({ ok: false });
  });

  test("only those who manage projects see and change it", async () => {
    const project = await newProject();
    const { cookie } = await signedInUser(dashboard, {
      name: "Mia",
      email: `mia-${randomUUID()}@example.com`,
      grants: { projects: "all", areas: { web_analytics: "view", errors: "manage" } },
    });
    const seen = (await read(project.id, cookie)).json().project;
    expect(seen).not.toHaveProperty("locationSource");
    expect(seen).not.toHaveProperty("locationHeaders");
    expect((await patch(project.id, { locationSource: "off" }, cookie)).statusCode).toBe(403);
    const admin = await signedInUser(dashboard, {
      name: "Dee",
      email: `dee-${randomUUID()}@example.com`,
      role: "admin",
    });
    expect((await patch(project.id, { locationSource: "off" }, admin.cookie)).statusCode).toBe(200);
  });

  test("a change applies to collection on the next request", async () => {
    const project = await newProject();
    const send = () =>
      dashboard.app.inject({
        method: "POST",
        url: "/api/events",
        headers: {
          "content-type": "text/plain",
          "user-agent": CHROME,
          "x-ottertrail-trusted-proxy": "true",
          "x-visitor-country": "NL",
        },
        payload: JSON.stringify({
          v: 1,
          key: project.public_key,
          sentAt: Date.now(),
          events: [
            {
              id: randomUUID(),
              name: "pageview",
              occurredAt: Date.now() - 1000,
              url: `https://${SITE}/`,
            },
          ],
        }),
      });
    // Cached with the key.
    expect((await send()).statusCode).toBe(202);
    await patch(project.id, {
      locationSource: "headers",
      locationHeaders: { ...NO_HEADERS, country: "x-visitor-country" },
    });
    expect((await send()).statusCode).toBe(202);
    const events = await storedEvents(dashboard.reader.client, project.id);
    expect(events.map((event) => event.country)).toEqual([null, "NL"]);
  });
});

test(
  "the migration rolls back: no location columns, and the rows keep the rest",
  { timeout: MIGRATION_TEST_MS },
  async () => {
    const testDb = await createTestDatabase();
    try {
      const columns = () =>
        sql<{ name: string }>`
          select column_name as name from information_schema.columns
          where table_schema = ${testDb.schema} and table_name = 'projects'
            and column_name like 'location_%'
        `
          .execute(testDb.db)
          .then(({ rows }) => rows.length);
      await insertProject(testDb.db, {
        name: "Site",
        allowed_hostnames: [SITE],
        location_source: "headers",
        location_country_header: "x-visitor-country",
      });
      expect(await columns()).toBe(4);
      // The migration before this one, whichever it is once other branches add theirs.
      const names = Object.keys(migrations).toSorted();
      await migrateTestDatabase(testDb, names[names.indexOf("0027_project_location_source") - 1]!);
      expect(await columns()).toBe(0);
      await migrateTestDatabase(testDb, "latest");
      expect(await columns()).toBe(4);
      const row = await testDb.db
        .selectFrom("projects")
        .select(["name", "location_source", "location_country_header"])
        .executeTakeFirstOrThrow();
      // Back to the default.
      expect(row).toEqual({
        name: "Site",
        location_source: "database",
        location_country_header: null,
      });
    } finally {
      await testDb.destroy();
    }
  },
);
