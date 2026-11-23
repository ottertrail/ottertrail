import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import { HEATMAP_TAGS as TRACKER_TAGS } from "../../../packages/tracker/src/heatmap-tags.ts";
import { type AppOptions, buildApp } from "../src/app.ts";
import { createClickHouse } from "../src/clickhouse/clickhouse.ts";
import { purgeDeletedProjects } from "../src/clickhouse/delete-events.ts";
import { QueryParams, queryRows } from "../src/clickhouse/query.ts";
import { loadConfig } from "../src/config.ts";
import { type NewHeatmapRecord, storeHeatmapRecords } from "../src/heatmaps/store.ts";
import { HEATMAP_TAGS as API_TAGS } from "../src/heatmaps/tags.ts";
import { PUBLIC_URL, signedInDashboard, signedInUser } from "./helpers/dashboard.ts";
import { insertProject } from "./helpers/projects.ts";

const SITE = "example.com";
const CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";

let dashboard: Awaited<ReturnType<typeof signedInDashboard>>;
const extraApps: FastifyInstance[] = [];

beforeAll(async () => {
  dashboard = await signedInDashboard();
});

afterAll(async () => {
  await Promise.all(extraApps.map((app) => app.close()));
  await dashboard?.close();
});

/** An app whose clock reads noon today, `later` milliseconds after. */
function atNoon(later = 0) {
  return appWith({ collection: { clickhouse: dashboard.reader.client, now: () => NOON + later } });
}

/** Another app on the same databases, with its own limits and caches. */
function appWith(options: Partial<AppOptions> = {}) {
  const app = buildApp({
    db: dashboard.db,
    collection: { clickhouse: dashboard.reader.client },
    ...options,
  });
  extraApps.push(app);
  return app;
}

async function newProject(values: Record<string, unknown> = {}) {
  return insertProject(dashboard.db, {
    name: `Site ${randomUUID().slice(0, 8)}`,
    allowed_hostnames: [SITE],
    heatmaps: true,
    ...values,
  });
}

/**
 * The clock of the collection tests: noon UTC today, well inside one day, so
 * a retry's few seconds more on the way can never cross midnight.
 */
const NOON = Date.parse(`${new Date().toISOString().slice(0, 10)}T12:00:00.000Z`);
/** The page the records are on, as the batch lists it. */
const PAGE = { url: `https://${SITE}/pricing?utm_source=news&token=secret` };

const click = (overrides: Record<string, unknown> = {}) => ({
  id: randomUUID(),
  type: "click",
  at: NOON - 2000,
  page: 0,
  label: "hero-cta",
  element: "section>a",
  x: 0.25,
  y: 0.5,
  vw: 1280,
  vh: 800,
  ph: 3200,
  device: "desktop",
  ...overrides,
});

const clicks = (count: number) => Array.from({ length: count }, () => click());

const scroll = (overrides: Record<string, unknown> = {}) => ({
  id: randomUUID(),
  type: "scroll",
  at: NOON - 5000,
  page: 0,
  depth: 0.5,
  fold: 0.25,
  vw: 1280,
  vh: 800,
  ph: 3200,
  device: "desktop",
  ...overrides,
});

function send(
  key: string,
  records: unknown[],
  {
    app = dashboard.app,
    remoteAddress = "198.51.100.10",
    userAgent = CHROME,
    sentAt = NOON,
    origin,
    body,
    pages = [PAGE],
  }: {
    pages?: unknown[];
    app?: FastifyInstance;
    remoteAddress?: string;
    userAgent?: string;
    sentAt?: number;
    origin?: string;
    body?: string;
  } = {},
) {
  return app.inject({
    method: "POST",
    url: "/api/heatmaps",
    headers: {
      "content-type": "text/plain",
      "user-agent": userAgent,
      ...(origin === undefined ? {} : { origin }),
    },
    payload: body ?? JSON.stringify({ v: 1, key, sentAt, pages, records }),
    remoteAddress,
  });
}

/** The project's rows as reports see them (FINAL), oldest first, scroll rows before clicks. */
async function stored(projectId: string) {
  const params = new QueryParams();
  return queryRows<Record<string, unknown>>(
    dashboard.reader,
    `SELECT record_id, kind, path, device, label, element, x, y, depth, dropped, fold, rage, dead, environment, release,
            viewport_width, viewport_height, page_height
     FROM heatmaps FINAL WHERE project_id = ${params.add(projectId, "UUID")}
     ORDER BY occurred_at, kind DESC, record_id`,
    params,
  );
}

describe("POST /api/heatmaps", () => {
  test("stores clicks and scroll depth: the page's path, the element, thousandths", async () => {
    const project = await newProject();
    const response = await send(project.public_key, [click({ rage: true, dead: true }), scroll()], {
      origin: `https://${SITE}`,
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ stored: 2, tooOld: 0, bots: 0, blocked: 0, spam: 0 });
    expect(response.headers["access-control-allow-origin"]).toBe(`https://${SITE}`);
    const rows = await stored(project.id);
    expect(rows).toEqual([
      expect.objectContaining({
        kind: "scroll",
        path: "/pricing",
        device: "desktop",
        label: "",
        element: "",
        depth: 500,
        rage: false,
        dead: false,
        environment: "production",
        release: "",
      }),
      expect.objectContaining({
        kind: "click",
        // Query string and fragment never stored.
        path: "/pricing",
        label: "hero-cta",
        element: "section>a",
        x: 250,
        y: 500,
        depth: 0,
        rage: true,
        dead: true,
        viewport_width: 1280,
        viewport_height: 800,
        page_height: 3200,
      }),
    ]);
  });

  test("a retried batch is the same rows, counted once, though its clock correction differs", async () => {
    const project = await newProject();
    const records = [click(), scroll()];
    const sentAt = NOON;
    expect((await send(project.public_key, records, { sentAt, app: atNoon() })).statusCode).toBe(
      202,
    );
    // The retry: sent later by the same clock, so its records come out seconds apart.
    expect(
      (await send(project.public_key, records, { sentAt: sentAt - 4000, app: atNoon(4000) }))
        .statusCode,
    ).toBe(202);
    expect(await stored(project.id)).toHaveLength(2);
    // And the report counts each once.
    const report = await get(project.id, "?period=7d&path=%2Fpricing");
    expect(report.json()).toMatchObject({ totals: { pageviews: 1, clicks: 1 } });
  });

  test("a copy sent in the minute after midnight by a clock a little ahead stays on its day, counted once", async () => {
    const project = await newProject();
    const midnight = Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
    // The browser's clock is 5 seconds ahead; it floored the click's time to 00:00.
    const record = click({ at: midnight });
    const at = (received: number, sentBy: number) =>
      send(project.public_key, [record], {
        app: appWith({ collection: { clickhouse: dashboard.reader.client, now: () => received } }),
        sentAt: sentBy,
      });
    expect((await at(midnight + 26_000, midnight + 31_000)).statusCode).toBe(202);
    // The retry, 4 seconds longer on the way.
    expect((await at(midnight + 35_000, midnight + 36_000)).statusCode).toBe(202);
    const params = new QueryParams();
    const rows = await queryRows<{ day: string; n: string }>(
      dashboard.reader,
      `SELECT toString(toDate(occurred_at)) AS day, count() AS n FROM heatmaps FINAL
       WHERE project_id = ${params.add(project.id, "UUID")} GROUP BY day`,
      params,
    );
    expect(rows).toEqual([{ day: new Date(midnight).toISOString().slice(0, 10), n: "1" }]);
  });

  test("the page list counts a scroll record sent again once, before its parts merge", async () => {
    const project = await newProject();
    const first = scroll({ depth: 0.2 });
    for (const depth of [0.2, 0.5, 0.9]) {
      await send(project.public_key, [{ ...first, depth }, click()]);
    }
    const pages = (await get(project.id, "/pages?period=7d")).json();
    expect(pages.pages).toEqual([{ path: "/pricing", pageviews: 1, clicks: 3 }]);
  });

  test("times are kept to the minute: the order of a visitor's taps is not", async () => {
    const project = await newProject();
    await send(project.public_key, [click({ at: NOON - 2000 }), click({ at: NOON - 1000 })], {
      app: atNoon(),
    });
    const params = new QueryParams();
    const rows = await queryRows<{ at: string }>(
      dashboard.reader,
      `SELECT toString(occurred_at) AS at FROM heatmaps FINAL
       WHERE project_id = ${params.add(project.id, "UUID")}`,
      params,
    );
    // To the nearest minute: 11:59:58 and 11:59:59 are both 12:00.
    const minute = new Date(Math.round((NOON - 2000) / 60_000) * 60_000)
      .toISOString()
      .replace("T", " ")
      .replace("Z", "");
    expect(rows.map((item) => item.at)).toEqual([minute, minute]);
  });

  test("a scroll record sent again with more dropped clicks, at the same depth, replaces the first", async () => {
    const project = await newProject();
    const first = scroll({ depth: 0.4, dropped: 0 });
    await send(project.public_key, [first]);
    await send(project.public_key, [{ ...first, dropped: 12 }]);
    await send(project.public_key, [{ ...first, dropped: 3 }]);
    const rows = await stored(project.id);
    expect(rows.map((item) => [item.depth, item.dropped])).toEqual([[400, 12]]);
  });

  test("takes the same tag names h.js writes, and no others", () => {
    expect(API_TAGS).toEqual(TRACKER_TAGS);
  });

  test("a scroll depth sent again deeper, with the same ID, replaces the shallower", async () => {
    const project = await newProject();
    const first = scroll({ depth: 0.3 });
    await send(project.public_key, [first]);
    await send(project.public_key, [{ ...first, depth: 0.9 }]);
    // An older, shallower copy arriving last does not win either.
    await send(project.public_key, [{ ...first, depth: 0.5 }]);
    const rows = await stored(project.id);
    expect(rows.map((row) => row.depth)).toEqual([900]);
  });

  test("refuses batches that break the rules, before storing anything (400, 413)", async () => {
    const project = await newProject();
    const key = project.public_key;
    const refused: [string, unknown[]][] = [
      ["51 records", Array.from({ length: 51 }, () => click())],
      ["no records", []],
      ["an ID that is not a UUID", [click({ id: "1" })]],
      ["an unknown type", [click({ type: "move" })]],
      ["a class in the path", [click({ element: "body>div.btn" })]],
      ["an ID in the path", [click({ element: "body>div#signup" })]],
      ["text in the path", [click({ element: "body>a[Sign up]" })]],
      ["25 steps", [click({ element: Array.from({ length: 25 }, () => "div").join(">") })]],
      ["a long path", [click({ element: `body>${"a".repeat(600)}` })]],
      ["a label with an @", [click({ label: "ada@example.com" })]],
      ["a label of 65 characters", [click({ label: "a".repeat(65) })]],
      ["x over 1", [click({ x: 1.5 })]],
      ["a negative y", [click({ y: -0.1 })]],
      ["a click without its element", [click({ element: undefined })]],
      ["a click with a depth", [click({ depth: 0.5 })]],
      ["a scroll without depth", [scroll({ depth: undefined })]],
      ["a scroll with an element", [scroll({ element: "body" })]],
      ["a device that does not match the width", [click({ vw: 390, device: "desktop" })]],
      ["a zero viewport", [click({ vw: 0 })]],
      ["a page taller than a million pixels", [scroll({ ph: 1_000_001 })]],
      ["a page that is not in the batch", [click({ page: 1 })]],
      ["a negative page", [click({ page: -1 })]],
      ["a tag that is not a standard one", [click({ element: "body>main>wilhelmina>a" })]],
      ["a custom element's name", [click({ element: "body>user-card>a" })]],
      ["a fold over 1", [scroll({ fold: 1.2 })]],
      ["a scroll without fold", [scroll({ fold: undefined })]],
      ["a click with dropped clicks", [click({ dropped: 3 })]],
      ["a dead flag that is a word", [click({ dead: "yes" })]],
      ["a dead flag that is a number", [click({ dead: 2 })]],
      ["a dead flag that is an object", [click({ dead: {} })]],
      ["a scroll with a dead flag", [scroll({ dead: true })]],
      ["a scroll with a rage flag", [scroll({ rage: true })]],
      ["dropped over 65,535", [scroll({ dropped: 65_536 })]],
    ];
    for (const [name, records] of refused) {
      const response = await send(key, records);
      expect({ name, status: response.statusCode }).toEqual({ name, status: 400 });
    }
    const pagesRefused: [string, unknown[]][] = [
      ["no pages", []],
      ["a URL that is not http", [{ url: "javascript:alert(1)" }]],
      ["a URL of 8,193 characters", [{ url: `https://${SITE}/${"a".repeat(8200)}` }]],
      ["51 pages", Array.from({ length: 51 }, () => PAGE)],
    ];
    for (const [name, pages] of pagesRefused) {
      const response = await send(key, [click()], { pages });
      expect({ name, status: response.statusCode }).toEqual({ name, status: 400 });
    }
    // "x" stands for any other element.
    expect((await send(key, [click({ element: "body>main>x>a:2" })])).statusCode).toBe(202);
    expect((await send(key, [], { body: "{not json" })).statusCode).toBe(400);
    const large = await send(key, [], {
      body: JSON.stringify({
        v: 1,
        key,
        sentAt: NOON,
        pages: [PAGE],
        records: [click()],
        pad: "a".repeat(70_000),
      }),
    });
    expect(large.statusCode).toBe(413);
    // Unknown fields are dropped, not refused: a newer h.js still reaches this API.
    expect((await send(key, [click({ text: "Sign up" })])).statusCode).toBe(202);
    const rows = await stored(project.id);
    expect(rows).toHaveLength(2);
    expect(JSON.stringify(rows)).not.toContain("Sign up");
  });

  test("records more than a day old are counted, not stored", async () => {
    const project = await newProject();
    const response = await send(project.public_key, [
      click({ at: NOON - 25 * 3_600_000 }),
      click(),
    ]);
    expect(response.json()).toMatchObject({ stored: 1, tooOld: 1 });
  });

  test("refuses the project's data while its heatmaps are off (403 heatmaps_off), and others' keys and sites", async () => {
    const off = await newProject({ heatmaps: false });
    const response = await send(off.public_key, [click()]);
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: "heatmaps_off" });
    expect(await stored(off.id)).toEqual([]);

    expect((await send(`pk_${"0".repeat(32)}`, [click()])).json<{ error: string }>().error).toBe(
      "unknown_key",
    );
    const on = await newProject();
    const elsewhere = await send(on.public_key, [click()], { origin: "https://other.example" });
    expect(elsewhere.statusCode).toBe(403);
    expect(elsewhere.json()).toMatchObject({ error: "origin_not_allowed" });
    const page = await send(on.public_key, [click()], {
      pages: [{ url: "https://other.example/" }],
    });
    expect(page.json()).toMatchObject({ error: "hostname_not_allowed" });
    expect(await stored(on.id)).toEqual([]);
  });

  test("turning heatmaps on in the project's settings takes effect at once", async () => {
    const project = await newProject({ heatmaps: false });
    expect((await send(project.public_key, [click()])).statusCode).toBe(403);
    const patched = await dashboard.app.inject({
      method: "PATCH",
      url: `/api/projects/${project.id}`,
      headers: { cookie: dashboard.cookie, origin: PUBLIC_URL, "content-type": "application/json" },
      payload: JSON.stringify({ heatmaps: true }),
    });
    expect(patched.json()).toMatchObject({ project: { heatmaps: true } });
    expect((await send(project.public_key, [click()])).statusCode).toBe(202);
  });

  test("blocked addresses, bots, data centers, and referrer spam are accepted and not stored", async () => {
    const project = await newProject({
      blocked_addresses: ["203.0.113.0/24"],
      blocked_referrers: ["spam.example"],
    });
    const key = project.public_key;
    const blocked = await send(key, [click()], { remoteAddress: "203.0.113.9" });
    expect(blocked.json()).toMatchObject({ stored: 0, blocked: 1 });
    const bot = await send(key, [click()], {
      userAgent: "Googlebot/2.1 (+http://www.google.com/bot.html)",
    });
    expect(bot.json()).toMatchObject({ stored: 0, bots: 1 });
    const spam = await send(key, [click(), scroll({ page: 1 })], {
      pages: [PAGE, { url: PAGE.url, referrer: "https://www.spam.example/landing" }],
    });
    expect(spam.json()).toMatchObject({ stored: 0, spam: 2 });
    // The site's own pages as referrers are never spam.
    const own = await send(key, [click()], {
      pages: [{ url: PAGE.url, referrer: `https://${SITE}/` }],
    });
    expect(own.json()).toMatchObject({ stored: 1 });

    const cloud = appWith({
      collection: { clickhouse: dashboard.reader.client, isDataCenter: () => true },
    });
    const fromCloud = await send(key, [click()], { app: cloud });
    expect(fromCloud.json()).toMatchObject({ stored: 0, bots: 1 });
    expect(await stored(project.id)).toHaveLength(1);
  });

  test("has budgets of its own per project and instance, apart from events', and per client address", async () => {
    const stopped = Date.now();
    const app = appWith({
      collection: { clickhouse: dashboard.reader.client, now: () => stopped },
      heatmaps: { projectLimit: { capacity: 60, refillPerSecond: 1 } },
    });
    const project = await newProject();
    expect((await send(project.public_key, clicks(50), { app, sentAt: stopped })).statusCode).toBe(
      202,
    );
    const refused = await send(project.public_key, clicks(50), { app, sentAt: stopped });
    expect(refused.statusCode).toBe(429);
    expect(refused.headers["retry-after"]).toBe("40");
    // Events are not held back by heatmaps.
    const events = await app.inject({
      method: "POST",
      url: "/api/events",
      headers: { "content-type": "text/plain", "user-agent": CHROME },
      payload: JSON.stringify({
        v: 1,
        key: project.public_key,
        sentAt: stopped,
        events: [
          { id: randomUUID(), name: "pageview", occurredAt: stopped - 10, url: `https://${SITE}/` },
        ],
      }),
      remoteAddress: "198.51.100.10",
    });
    expect(events.statusCode).toBe(202);
    // Another project has its own.
    const other = await newProject();
    expect((await send(other.public_key, clicks(50), { app, sentAt: stopped })).statusCode).toBe(
      202,
    );

    const instance = appWith({
      collection: { clickhouse: dashboard.reader.client, now: () => stopped },
      heatmaps: { instanceLimit: { capacity: 60, refillPerSecond: 1 } },
    });
    expect(
      (await send(project.public_key, clicks(50), { app: instance, sentAt: stopped })).statusCode,
    ).toBe(202);
    expect(
      (await send(other.public_key, clicks(50), { app: instance, sentAt: stopped })).statusCode,
    ).toBe(429);

    const perClient = appWith({
      collection: { clickhouse: dashboard.reader.client, now: () => stopped },
      heatmaps: { ipRecordLimit: { capacity: 60, refillPerSecond: 1 } },
    });
    expect(
      (await send(project.public_key, clicks(50), { app: perClient, sentAt: stopped })).statusCode,
    ).toBe(202);
    expect(
      (await send(project.public_key, clicks(50), { app: perClient, sentAt: stopped })).statusCode,
    ).toBe(429);
    expect(
      (
        await send(project.public_key, clicks(50), {
          app: perClient,
          sentAt: stopped,
          remoteAddress: "198.51.100.77",
        })
      ).statusCode,
    ).toBe(202);
  });

  test("counts the addresses of one IPv6 /64 as one client", async () => {
    const project = await newProject();
    const app = appWith({
      collection: { clickhouse: dashboard.reader.client, now: () => NOON },
      heatmaps: { ipLimit: { capacity: 2, refillPerSecond: 1 } },
    });
    for (const remoteAddress of ["2001:db8:1:2::1", "2001:db8:1:2::2"]) {
      expect((await send(project.public_key, [click()], { app, remoteAddress })).statusCode).toBe(
        202,
      );
    }
    const third = await send(project.public_key, [click()], {
      app,
      remoteAddress: "2001:db8:1:2::3",
    });
    expect(third.statusCode).toBe(429);
  });

  test("answers 503 while ClickHouse cannot write, and gives the budget back", async () => {
    const down = createClickHouse({ ...loadConfig().clickhouse, url: "http://127.0.0.1:1" });
    const project = await newProject();
    const app = buildApp({
      db: dashboard.db,
      collection: { clickhouse: down },
      heatmaps: { projectLimit: { capacity: 50, refillPerSecond: 0.001 } },
    });
    extraApps.push(app);
    const records = Array.from({ length: 50 }, () => click());
    const response = await send(project.public_key, records, { app });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: "storage_unavailable" });
    // The budget came back: the retry is not refused for it.
    expect((await send(project.public_key, records, { app })).statusCode).toBe(503);
    await down.close();
  });
});

describe("storage", () => {
  test("keeps 90 days, and a deleted project's heatmaps go with it", async () => {
    const [table] = await queryRows<{ statement: string }>(
      dashboard.reader,
      "SHOW CREATE TABLE heatmaps",
      new QueryParams(),
    );
    expect(table?.statement).toContain("TTL toDateTime(occurred_at) + toIntervalDay(90)");
    expect(table?.statement).toContain("ReplacingMergeTree(version)");
    // A day's parts merge once all are an hour old, so copies do not stay.
    expect(table?.statement).toContain("min_age_to_force_merge_seconds = 3600");
    expect(table?.statement).toContain("min_age_to_force_merge_on_partition_only = 1");
    expect(table?.statement).toContain(
      "ORDER BY (project_id, toDate(occurred_at), path, device, kind, record_id)",
    );

    const project = await newProject();
    await send(project.public_key, [click(), scroll()]);
    expect(await stored(project.id)).toHaveLength(2);
    await dashboard.db.deleteFrom("projects").where("id", "=", project.id).execute();
    await purgeDeletedProjects(dashboard.db, dashboard.reader.client);
    expect(await stored(project.id)).toEqual([]);
  });
});

// The reports, on rows stored directly, worked out by hand.

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000);
/** The first of the 90 days kept, today among them (UTC, the instance's timezone). */
const FIRST_KEPT = new Date(
  Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`) - 89 * 86_400_000,
)
  .toISOString()
  .slice(0, 10);

const row = (overrides: Partial<NewHeatmapRecord>): NewHeatmapRecord => ({
  recordId: randomUUID(),
  kind: "click",
  occurredAt: hoursAgo(2),
  environment: "production",
  path: "/pricing",
  device: "desktop",
  label: "",
  element: "",
  x: 0,
  y: 0,
  viewportWidth: 1280,
  viewportHeight: 800,
  pageHeight: 4000,
  rage: false,
  depth: 0,
  ...overrides,
});

const pageview = (depth: number, viewportHeight: number, more: Partial<NewHeatmapRecord> = {}) =>
  row({ kind: "scroll", depth, viewportHeight, pageHeight: 4000, ...more });

function get(projectId: string, query: string, cookie = dashboard.cookie) {
  return dashboard.app.inject({
    url: `/api/projects/${projectId}/heatmaps${query}`,
    headers: { cookie },
  });
}

describe("the reports", () => {
  let projectId = "";
  beforeAll(async () => {
    projectId = (await newProject()).id;
    const cta = { label: "hero-cta", element: "section>a" };
    await storeHeatmapRecords(dashboard.reader.client, projectId, [
      // /pricing on desktop: four pageviews, at a quarter, half, three
      // quarters, and the bottom; folds as each first showed, smaller than
      // their viewport against the final height (the page grew), and 7
      // clicks past the 100 on one of them.
      pageview(0.25, 800, { fold: 0.1 }),
      pageview(0.5, 800, { fold: 0.1, dropped: 7 }),
      pageview(0.75, 1600, { fold: 0.2 }),
      pageview(1, 1600, { fold: 0.2 }),
      // Three clicks on the call to action, one a rage click that was also
      // a dead click, and one dead click on the menu.
      row({ ...cta, x: 0.2, y: 0.4 }),
      row({ ...cta, x: 0.4, y: 0.6 }),
      row({ ...cta, x: 0.6, y: 0.5, rage: true, dead: true }),
      row({ element: "body>header>nav>a:2", x: 0.5, y: 0.5, dead: true }),
      // On a phone: one pageview and a click, left out by device=desktop.
      pageview(0.1, 700, { device: "mobile", viewportWidth: 390 }),
      row({ ...cta, device: "mobile", viewportWidth: 390, rage: true, dead: true }),
      // Another page, another environment, and too old for the period.
      pageview(0.5, 800, { path: "/" }),
      pageview(0.5, 800, { path: "/", environment: "staging" }),
      pageview(0.5, 800, { occurredAt: hoursAgo(24 * 10) }),
      // Clicks on a page whose scroll depths have not arrived yet.
      ...Array.from({ length: 10 }, () => row({ path: "/new", element: "body>a" })),
      // On the first of the 90 days kept: never in a range before them.
      pageview(0.5, 800, { occurredAt: new Date(Date.parse(`${FIRST_KEPT}T12:00:00Z`)) }),
    ]);
  });

  test("lists the pages with heatmap data, most pageviews first, and finds them by part of the path", async () => {
    const response = await get(projectId, "/pages?period=7d");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      environment: "production",
      environments: ["production", "staging"],
      heatmaps: true,
      retentionDays: 90,
      clipped: false,
      // By pageviews and clicks together: /new's clicks list it before its pageviews arrive.
      pages: [
        { path: "/pricing", pageviews: 5, clicks: 5 },
        { path: "/new", pageviews: 0, clicks: 10 },
        { path: "/", pageviews: 1, clicks: 0 },
      ],
    });
    const found = await get(projectId, "/pages?period=7d&search=PRIC&device=mobile");
    expect(found.json<{ pages: unknown[] }>().pages).toEqual([
      { path: "/pricing", pageviews: 1, clicks: 1 },
    ]);
  });

  test("one page's report: scroll reach, the fold, the most-clicked elements, rage and dead hotspots, totals", async () => {
    const response = await get(projectId, "?period=7d&path=%2Fpricing&device=desktop");
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({
      path: "/pricing",
      device: "desktop",
      // Every device, for the picker.
      devices: [
        { device: "desktop", pageviews: 4 },
        { device: "mobile", pageviews: 1 },
      ],
      totals: {
        pageviews: 4,
        clicks: 4,
        rageClicks: 1,
        deadClicks: 2,
        // Halfway between 0.5 and 0.75.
        medianDepth: 0.625,
        reachedBottom: 0.25,
        droppedClicks: 7,
      },
      scroll: {
        // The folds as first measured, (0.1 + 0.1 + 0.2 + 0.2) / 4, not the
        // viewports against the final height (0.3).
        averageFold: 0.15,
      },
      elements: [
        {
          label: "hero-cta",
          element: "section>a",
          clicks: 3,
          share: 0.75,
          rageClicks: 1,
          deadClicks: 1,
          x: 0.4,
          y: 0.5,
        },
        {
          label: null,
          element: "body>header>nav>a:2",
          clicks: 1,
          share: 0.25,
          rageClicks: 0,
          deadClicks: 1,
        },
      ],
      hotspots: [{ label: "hero-cta", element: "section>a", rageClicks: 1, x: 0.6, y: 0.5 }],
      // One each, then by name: the unnamed menu link first.
      deadHotspots: [
        { label: null, element: "body>header>nav>a:2", deadClicks: 1, x: 0.5, y: 0.5 },
        { label: "hero-cta", element: "section>a", deadClicks: 1, x: 0.6, y: 0.5 },
      ],
    });
    expect(body.scroll.reach).toEqual([
      { depth: 10, pageviews: 4, share: 1 },
      { depth: 20, pageviews: 4, share: 1 },
      { depth: 30, pageviews: 3, share: 0.75 },
      { depth: 40, pageviews: 3, share: 0.75 },
      { depth: 50, pageviews: 3, share: 0.75 },
      { depth: 60, pageviews: 2, share: 0.5 },
      { depth: 70, pageviews: 2, share: 0.5 },
      { depth: 80, pageviews: 1, share: 0.25 },
      { depth: 90, pageviews: 1, share: 0.25 },
      { depth: 100, pageviews: 1, share: 0.25 },
    ]);

    // All devices: the phone's pageview and rage click too.
    const all = (await get(projectId, "?period=7d&path=%2Fpricing")).json();
    expect(all.totals).toMatchObject({ pageviews: 5, clicks: 5, rageClicks: 2, deadClicks: 3 });
    expect(all.hotspots).toEqual([expect.objectContaining({ label: "hero-cta", rageClicks: 2 })]);
    expect(all.deadHotspots[0]).toMatchObject({ label: "hero-cta", deadClicks: 2 });
  });

  test("a page without data has empty figures, not errors", async () => {
    const body = (await get(projectId, "?period=7d&path=%2Fnowhere")).json();
    expect(body.totals).toEqual({
      pageviews: 0,
      clicks: 0,
      rageClicks: 0,
      deadClicks: 0,
      medianDepth: null,
      reachedBottom: null,
      droppedClicks: 0,
    });
    expect(body.scroll.averageFold).toBeNull();
    expect(body.elements).toEqual([]);
    expect(body.deadHotspots).toEqual([]);
  });

  test("reads at most the 90 days kept, and says so", async () => {
    const body = (await get(projectId, "/pages?period=12m")).json();
    expect(body.clipped).toBe(true);
    const today = new Date().toISOString().slice(0, 10);
    const first = new Date(Date.parse(`${today}T00:00:00Z`) - 89 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    expect(body).toMatchObject({ firstDay: first, lastDay: today });
    // The pageviews 10 and 89 days ago are inside the 90 days.
    expect(body.pages[0]).toMatchObject({ path: "/pricing", pageviews: 7 });
  });

  test("a range wholly before the 90 days kept is empty, and says so", async () => {
    const before = (days: number) =>
      new Date(Date.parse(`${FIRST_KEPT}T00:00:00Z`) - days * 86_400_000)
        .toISOString()
        .slice(0, 10);
    const range = `from=${before(30)}&to=${before(1)}`;
    const pages = (await get(projectId, `/pages?${range}`)).json();
    expect(pages).toMatchObject({
      clipped: true,
      firstDay: before(30),
      lastDay: before(1),
      pages: [],
    });
    const report = (await get(projectId, `?${range}&path=%2Fpricing`)).json();
    expect(report).toMatchObject({
      clipped: true,
      totals: { pageviews: 0, clicks: 0 },
      elements: [],
    });
    // A range that reaches into the 90 days reads from their first day.
    const into = (await get(projectId, `/pages?from=${before(30)}&to=${FIRST_KEPT}`)).json();
    expect(into).toMatchObject({
      clipped: true,
      firstDay: FIRST_KEPT,
      pages: [{ path: "/pricing", pageviews: 1 }],
    });
  });

  test("refuses bad queries (400)", async () => {
    for (const query of [
      "?period=7d",
      "?period=7d&path=pricing",
      `?period=7d&path=/${"a".repeat(2048)}`,
      "?period=7d&path=%2F&device=watch",
      "?period=1y&path=%2F",
      "/pages?period=7d&search=" + "a".repeat(201),
    ]) {
      const response = await get(projectId, query);
      expect({ query, status: response.statusCode }).toEqual({ query, status: 400 });
    }
  });

  test("need web analytics at view; a project not granted is unknown", async () => {
    const other = await newProject();
    const viewer = await signedInUser(dashboard, {
      name: "Viewer",
      email: `viewer-${randomUUID()}@example.com`,
      grants: { projects: [projectId], areas: { web_analytics: "view" } },
    });
    const withoutArea = await signedInUser(dashboard, {
      name: "Errors only",
      email: `errors-${randomUUID()}@example.com`,
      grants: { projects: [projectId], areas: { errors: "manage" } },
    });
    for (const query of ["/pages?period=7d", "?period=7d&path=%2Fpricing"]) {
      expect((await get(projectId, query, viewer.cookie)).statusCode).toBe(200);
      const forbidden = await get(projectId, query, withoutArea.cookie);
      expect(forbidden.statusCode).toBe(403);
      expect(forbidden.json()).toMatchObject({ error: "forbidden" });
      const unknown = await get(other.id, query, viewer.cookie);
      expect(unknown.statusCode).toBe(404);
      expect(unknown.json()).toEqual({ error: "not_found", message: "No project has this ID." });
      expect(
        (await dashboard.app.inject({ url: `/api/projects/${projectId}/heatmaps${query}` }))
          .statusCode,
      ).toBe(401);
    }
  });
});
