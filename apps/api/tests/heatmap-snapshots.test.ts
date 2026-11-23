import { randomUUID } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";

import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import { overlaySessionPath } from "../src/access/overlay-tokens.ts";
import { purgeDeletedProjects } from "../src/clickhouse/delete-events.ts";
import { LOCAL_OBJECT_STORE } from "../src/config.ts";
import {
  MAX_SNAPSHOT_BYTES,
  MAX_SNAPSHOT_CONTAINERS,
  MAX_SNAPSHOT_DEPTH,
  projectSnapshotPrefix,
  structureOf,
} from "../src/heatmaps/snapshots.ts";
import { s3ObjectStore } from "../src/storage/object-store.ts";
import { PUBLIC_URL, signedInDashboard, signedInUser } from "./helpers/dashboard.ts";
import { insertProject } from "./helpers/projects.ts";

/*
 * Saved heatmap views (docs/web-analytics.md, "Saved views"): the overlay
 * uploads a snapshot of the owner's page with its session; the dashboard
 * lists, shows, and deletes them.
 */

type Dashboard = Awaited<ReturnType<typeof signedInDashboard>>;

const SITE = "https://example.com";
const UNLIMITED = { capacity: 10_000, refillPerSecond: 10_000 };
const LIMITS = {
  overlayExchangeLimit: UNLIMITED,
  overlayReadLimit: UNLIMITED,
  overlaySaveLimit: UNLIMITED,
};

// The development Garage from compose.yaml.
const store = s3ObjectStore(LOCAL_OBJECT_STORE);
let dashboard: Dashboard;
let plain: Dashboard;
const projectsMade: string[] = [];

beforeAll(async () => {
  dashboard = await signedInDashboard({ objectStore: store, heatmaps: LIMITS });
  plain = await signedInDashboard({ heatmaps: LIMITS });
});

afterAll(async () => {
  for (const id of projectsMade) await store.deletePrefix(projectSnapshotPrefix(id));
  store.close();
  await dashboard?.close();
  await plain?.close();
});

async function newProject(app = dashboard) {
  const project = await insertProject(app.db, {
    name: `Site ${randomUUID().slice(0, 8)}`,
    allowed_hostnames: ["example.com"],
    heatmaps: true,
  });
  projectsMade.push(project.id);
  return project;
}

/** A snapshot as s.js writes it, gzip-compressed. */
function snapshot({
  width = 1280,
  height = 800,
  extra = {},
  events,
}: {
  width?: number;
  height?: number;
  extra?: Record<string, unknown>;
  events?: unknown[];
} = {}): Buffer {
  const at = Date.now();
  return gzipSync(
    JSON.stringify({
      v: 1,
      events: events ?? [
        { type: 4, data: { href: `${SITE}/pricing`, width, height }, timestamp: at },
        {
          type: 2,
          data: {
            node: { type: 0, id: 1, childNodes: [] },
            initialOffset: { top: 0, left: 0 },
          },
          timestamp: at,
        },
      ],
      pageHeight: 3200,
      ...extra,
    }),
  );
}

async function exchangeFor(
  projectId: string,
  {
    app = dashboard,
    cookie,
    path = "/pricing",
  }: { app?: Dashboard; cookie?: string; path?: string | null } = {},
) {
  const minted = await app.app.inject({
    method: "POST",
    url: `/api/projects/${projectId}/heatmaps/overlay-link`,
    headers: { cookie: cookie ?? app.cookie, origin: PUBLIC_URL },
    ...(path === null ? {} : { payload: { path } }),
  });
  expect(minted.statusCode).toBe(200);
  const exchanged = await app.app.inject({
    method: "POST",
    url: "/api/heatmap-overlay/session",
    headers: { "content-type": "text/plain", origin: SITE },
    payload: JSON.stringify({ token: minted.json().token }),
  });
  expect(exchanged.statusCode).toBe(200);
  return exchanged.json();
}

async function sessionFor(
  projectId: string,
  options: { app?: Dashboard; cookie?: string; path?: string | null } = {},
): Promise<string> {
  return (await exchangeFor(projectId, options)).token;
}

function save(
  projectId: string,
  session: string | null,
  body: Buffer = snapshot(),
  {
    app = dashboard,
    path = "/pricing",
    origin = SITE,
    type = "application/gzip",
  }: { app?: Dashboard; path?: string; origin?: string; type?: string } = {},
) {
  return app.app.inject({
    method: "POST",
    url: `/api/heatmap-overlay/${projectId}/snapshot?path=${encodeURIComponent(path)}`,
    headers: {
      origin,
      "content-type": type,
      ...(session === null ? {} : { authorization: `Bearer ${session}` }),
    },
    payload: body,
  });
}

function dashboardCall(
  method: "GET" | "DELETE",
  url: string,
  { app = dashboard, cookie = app.cookie }: { app?: Dashboard; cookie?: string } = {},
) {
  return app.app.inject({ method, url, headers: { cookie, origin: PUBLIC_URL } });
}

const listOf = async (projectId: string, path = "/pricing", app = dashboard) =>
  (
    await dashboardCall(
      "GET",
      `/api/projects/${projectId}/heatmaps/snapshots?path=${encodeURIComponent(path)}`,
      { app },
    )
  ).json();

/** Text as the bytes the pre-scan reads. */
const text = (value: string) => new TextEncoder().encode(value);

const keysOf = async (projectId: string) =>
  (
    await dashboard.db
      .selectFrom("heatmap_snapshots")
      .select("object_key")
      .where("project_id", "=", projectId)
      .execute()
  ).map((row) => row.object_key);

describe("saving a view from the overlay", () => {
  test("stores it gzipped under heatmap-snapshots/, one per page and device, saved by the user", async () => {
    const project = await newProject();
    const session = await sessionFor(project.id);
    const response = await save(project.id, session);
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ path: "/pricing", device: "desktop", width: 1280 });
    // Readable by the project's site only.
    expect(response.headers["access-control-allow-origin"]).toBe(SITE);
    expect(response.headers["cache-control"]).toBe("no-store");

    const [key] = await keysOf(project.id);
    expect(key).toMatch(new RegExp(`^heatmap-snapshots/${project.id}/[0-9a-f-]{36}\\.json\\.gz$`));
    const stored = await store.get(key ?? "");
    expect(JSON.parse(gunzipSync(stored ?? new Uint8Array()).toString("utf8"))).toMatchObject({
      v: 1,
      pageHeight: 3200,
    });
    expect(await listOf(project.id)).toEqual({
      configured: true,
      snapshots: [
        {
          device: "desktop",
          width: 1280,
          height: 800,
          pageHeight: 3200,
          savedAt: expect.any(String),
          savedBy: "Ada Owner",
        },
      ],
    });
    // The device is the viewport's: a phone's width is a mobile view beside it.
    expect(
      (await save(project.id, session, snapshot({ width: 390, height: 844 }))).json(),
    ).toMatchObject({
      device: "mobile",
    });
    expect(
      (await listOf(project.id)).snapshots.map((item: { device: string }) => item.device),
    ).toEqual(["desktop", "mobile"]);
  });

  test("saving again replaces the view and deletes the old object", async () => {
    const project = await newProject();
    const session = await sessionFor(project.id);
    expect((await save(project.id, session)).statusCode).toBe(201);
    const [first] = await keysOf(project.id);
    expect((await save(project.id, session, snapshot({ height: 700 }))).statusCode).toBe(201);
    const [second, ...more] = await keysOf(project.id);
    expect(more).toEqual([]);
    expect(second).not.toBe(first);
    expect(await store.get(first ?? "")).toBeNull();
    expect(await store.get(second ?? "")).not.toBeNull();
    expect((await listOf(project.id)).snapshots).toMatchObject([{ height: 700 }]);
  });

  test("needs the overlay's session, for this project and the page its link opened", async () => {
    const project = await newProject();
    const other = await newProject();
    const session = await sessionFor(project.id);
    expect((await save(project.id, null)).statusCode).toBe(401);
    expect((await save(project.id, "x".repeat(43))).statusCode).toBe(401);
    // Another project's address: the session is not one of its own.
    expect((await save(other.id, session)).statusCode).toBe(401);
    // Another page of the site.
    const wrongPage = await save(project.id, session, snapshot(), { path: "/account" });
    expect([wrongPage.statusCode, wrongPage.json().error]).toEqual([403, "wrong_page"]);
    // A link made without a page saves nothing.
    const noPage = await sessionFor(project.id, { path: null });
    expect((await save(project.id, noPage)).statusCode).toBe(403);
    // Only from the project's site.
    const elsewhere = await save(project.id, session, snapshot(), {
      origin: "https://evil.example",
    });
    expect(elsewhere.statusCode).toBe(403);
    expect(elsewhere.headers["access-control-allow-origin"]).toBeUndefined();
    // Neither the dashboard's cookie nor a public key saves one.
    const cookie = await dashboard.app.inject({
      method: "POST",
      url: `/api/heatmap-overlay/${project.id}/snapshot?path=%2Fpricing`,
      headers: { origin: SITE, cookie: dashboard.cookie, "content-type": "application/gzip" },
      payload: snapshot(),
    });
    expect(cookie.statusCode).toBe(401);
    const keyed = await dashboard.app.inject({
      method: "POST",
      url: `/api/heatmap-overlay/${project.id}/snapshot?path=%2Fpricing&key=pk_x`,
      headers: {
        origin: SITE,
        authorization: `Bearer ${session}`,
        "content-type": "application/gzip",
      },
      payload: snapshot(),
    });
    expect(keyed.statusCode).toBe(400);
    expect(await keysOf(project.id)).toEqual([]);
  });

  test("only the owner and admins save a view; a member's session says it cannot", async () => {
    const project = await newProject();
    const member = await signedInUser(dashboard, {
      name: "Analyst",
      email: `analyst-${randomUUID()}@example.com`,
      grants: { projects: [project.id], areas: { web_analytics: "view" } },
    });
    const memberSession = await exchangeFor(project.id, { cookie: member.cookie });
    expect(memberSession).toMatchObject({ snapshots: true, canSave: false });
    const refused = await save(project.id, memberSession.token);
    expect([refused.statusCode, refused.json().error]).toEqual([403, "forbidden"]);
    expect(await keysOf(project.id)).toEqual([]);

    const admin = await signedInUser(dashboard, {
      name: "Admin",
      email: `admin-${randomUUID()}@example.com`,
      role: "admin",
    });
    const adminSession = await exchangeFor(project.id, { cookie: admin.cookie });
    expect(adminSession.canSave).toBe(true);
    expect((await exchangeFor(project.id)).canSave).toBe(true);
    expect((await save(project.id, adminSession.token)).statusCode).toBe(201);
    expect((await listOf(project.id)).snapshots[0].savedBy).toBe("Admin");
    // Made a member meanwhile, with no projects granted: the next save is refused.
    await dashboard.db
      .updateTable("dashboard_users")
      .set({ role: "member" })
      .where("id", "=", admin.userId)
      .execute();
    expect((await save(project.id, adminSession.token)).statusCode).toBe(404);
    // The user removed: the view stays, saved by no one known.
    await dashboard.db.deleteFrom("dashboard_users").where("id", "=", admin.userId).execute();
    expect((await listOf(project.id)).snapshots[0].savedBy).toBeNull();
  });

  test("a session's page is its own only while the session and its dashboard session last", async () => {
    const project = await newProject();
    const session = await sessionFor(project.id);
    const now = new Date();
    expect(await overlaySessionPath(dashboard.db, session, project.id, now)).toBe("/pricing");
    const later = new Date(now.getTime() + 31 * 60_000);
    expect(await overlaySessionPath(dashboard.db, session, project.id, later)).toBeNull();
    const { session_id: sessionId } = await dashboard.db
      .selectFrom("heatmap_overlay_tokens")
      .select("session_id")
      .where("kind", "=", "session")
      .where("project_id", "=", project.id)
      .executeTakeFirstOrThrow();
    const { expires_at: ends } = await dashboard.db
      .selectFrom("dashboard_sessions")
      .select("expires_at")
      .where("id", "=", sessionId)
      .executeTakeFirstOrThrow();
    // Past the dashboard session's end, though the overlay's 30 minutes are not.
    expect(await overlaySessionPath(dashboard.db, session, project.id, ends)).toBeNull();
  });

  test("refuses a page nested too deeply for the player to rebuild", async () => {
    const project = await newProject();
    const session = await sessionFor(project.id);
    const at = Date.now();
    let node: unknown = { type: 3, textContent: "deep", id: 1000 };
    for (let id = 999; id >= 2; id -= 1) {
      node = { type: 2, tagName: "div", attributes: {}, childNodes: [node], id };
    }
    const deep = snapshot({
      events: [
        { type: 4, data: { href: SITE, width: 1280, height: 800 }, timestamp: at },
        { type: 2, data: { node: { type: 0, id: 1, childNodes: [node] } }, timestamp: at },
      ],
    });
    const refused = await save(project.id, session, deep);
    expect([refused.statusCode, refused.json().error]).toEqual([400, "snapshot_too_deep"]);
    expect(await keysOf(project.id)).toEqual([]);
  });

  test("checks the Origin's form, the Bearer's, and the declared size before reading the body", async () => {
    const project = await newProject();
    const session = await sessionFor(project.id);
    const post = (headers: Record<string, string>) =>
      dashboard.app.inject({
        method: "POST",
        url: `/api/heatmap-overlay/${project.id}/snapshot?path=%2Fpricing`,
        headers: { "content-type": "application/gzip", ...headers },
        // Past the body limit: read first, it would be refused as too large (413).
        payload: Buffer.alloc(MAX_SNAPSHOT_BYTES + 1),
      });
    const bearer = `Bearer ${session}`;
    expect((await post({ origin: SITE })).statusCode).toBe(401);
    expect((await post({ authorization: bearer })).statusCode).toBe(403);
    // Plain http, except on this computer.
    expect((await post({ origin: "http://example.com", authorization: bearer })).statusCode).toBe(
      403,
    );
    const declared = await post({ origin: SITE, authorization: bearer });
    expect([declared.statusCode, declared.json().error]).toEqual([413, "snapshot_too_large"]);
  });

  test("refuses what is not a snapshot (400), too large (413), or another type (415)", async () => {
    const project = await newProject();
    const session = await sessionFor(project.id);
    const at = Date.now();
    const meta = { type: 4, data: { href: SITE, width: 1280, height: 800 }, timestamp: at };
    const full = { type: 2, data: { node: { type: 0, id: 1, childNodes: [] } }, timestamp: at };
    for (const body of [
      gzipSync("not json"),
      Buffer.from("not gzip"),
      gzipSync(JSON.stringify({ v: 2, events: [meta, full], pageHeight: 10 })),
      snapshot({ extra: { script: "x" } }),
      snapshot({ extra: { pageHeight: 0 } }),
      snapshot({ events: [meta] }),
      snapshot({ events: [meta, meta, full] }),
      snapshot({ events: [meta, full, full] }),
      snapshot({ events: [meta, { ...full, data: { node: { type: 2 } } }] }),
      // Changes after the snapshot (a mutation) are no part of one.
      snapshot({ events: [meta, full, { type: 3, data: { source: 0 }, timestamp: at }] }),
      snapshot({ events: [meta, full, { ...full, type: 5 }] }),
      snapshot({ events: [{ ...meta, extra: 1 }, full] }),
      snapshot({ width: 0 }),
      snapshot({ width: 20_000 }),
    ]) {
      const response = await save(project.id, session, body);
      expect([response.statusCode, response.json().error]).toEqual([400, "invalid_snapshot"]);
    }
    // Style events a full snapshot brings with it are kept.
    const styled = snapshot({
      events: [meta, full, { type: 3, data: { source: 15, id: 1, styleIds: [] }, timestamp: at }],
    });
    expect((await save(project.id, session, styled)).statusCode).toBe(201);

    const huge = gzipSync(" ".repeat(40 * 1024 * 1024));
    expect(huge.byteLength).toBeLessThan(MAX_SNAPSHOT_BYTES);
    const unpacked = await save(project.id, session, huge);
    expect([unpacked.statusCode, unpacked.json().error]).toEqual([413, "snapshot_too_large"]);
    const large = await save(project.id, session, Buffer.alloc(MAX_SNAPSHOT_BYTES + 1));
    expect(large.statusCode).toBe(413);
    expect((await save(project.id, session, snapshot(), { type: "text/plain" })).statusCode).toBe(
      400,
    );
    expect(
      (await save(project.id, session, snapshot(), { type: "application/octet-stream" }))
        .statusCode,
    ).toBe(415);
    expect(await keysOf(project.id)).toHaveLength(1);
  });

  test("objects are counted before parsing: a body of tiny objects is refused, a large real page is not", async () => {
    const project = await newProject();
    const session = await sessionFor(project.id);
    const at = Date.now();
    const meta = { type: 4, data: { href: SITE, width: 1280, height: 800 }, timestamp: at };
    const page = (childNodes: unknown[]) => ({
      type: 2,
      data: { node: { type: 0, id: 1, childNodes }, initialOffset: { top: 0, left: 0 } },
      timestamp: at + 50,
    });
    // 32 MiB of "{}," in one node: under 5 MB compressed, millions of objects once parsed.
    const tiny = `{"v":1,"pageHeight":10,"events":[${JSON.stringify(meta)},${JSON.stringify(
      page([]),
    ).replace('"childNodes":[]', `"childNodes":[${"{},".repeat(10_000_000)}{}]`)}]}`;
    const packed = gzipSync(tiny);
    expect(packed.byteLength).toBeLessThan(MAX_SNAPSHOT_BYTES);
    const refused = await save(project.id, session, packed);
    expect([refused.statusCode, refused.json().error]).toEqual([413, "snapshot_too_large"]);
    expect(refused.json().message).toMatch(/^This page is too large to save/);

    // A very large real page: 80,000 elements, each with a class and a text node.
    const rows = Array.from({ length: 80_000 }, (_, index) => ({
      type: 2,
      tagName: "div",
      attributes: { class: "row" },
      childNodes: [{ type: 3, textContent: `Row ${index}`, id: 2 * index + 3 }],
      id: 2 * index + 2,
    }));
    const large = snapshot({ events: [meta, page(rows)] });
    expect(large.byteLength).toBeLessThan(MAX_SNAPSHOT_BYTES);
    expect(structureOf(gunzipSync(large)).containers).toBeGreaterThan(300_000);
    expect((await save(project.id, session, large)).statusCode).toBe(201);
  });

  test("the pre-scan counts only outside strings, and stops past its limit", () => {
    expect(structureOf(text('{"a":"{[,]}\\"","b":[1,2,{}]}'))).toEqual({
      containers: 3,
      values: 6,
      over: false,
      deep: false,
    });
    expect(structureOf(text("[".repeat(MAX_SNAPSHOT_CONTAINERS + 1))).over).toBe(true);
    expect(structureOf(text("[".repeat(MAX_SNAPSHOT_DEPTH + 1)))).toMatchObject({ deep: true });
    expect(structureOf(text("[]".repeat(MAX_SNAPSHOT_DEPTH + 1))).deep).toBe(false);
    expect(
      structureOf(text("[]".repeat(10)), { containers: 5, values: 100, depth: 500 }),
    ).toMatchObject({
      over: true,
      containers: 6,
    });
  });

  test("the preflight answers the project's site only", async () => {
    const project = await newProject();
    const preflight = (origin: string) =>
      dashboard.app.inject({
        method: "OPTIONS",
        url: `/api/heatmap-overlay/${project.id}/snapshot`,
        headers: { origin, "access-control-request-method": "POST" },
      });
    const ok = await preflight(SITE);
    expect(ok.statusCode).toBe(204);
    expect(ok.headers["access-control-allow-origin"]).toBe(SITE);
    expect(ok.headers["access-control-allow-methods"]).toBe("POST");
    expect(ok.headers["access-control-allow-headers"]).toBe("Authorization, Content-Type");
    expect(ok.headers["access-control-allow-credentials"]).toBeUndefined();
    const refused = await preflight("https://evil.example");
    expect(refused.statusCode).toBe(403);
    expect(refused.headers["access-control-allow-origin"]).toBeUndefined();
  });

  test("without an object store, the session says so and a save is refused (409)", async () => {
    const project = await newProject(plain);
    const minted = await plain.app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/heatmaps/overlay-link`,
      headers: { cookie: plain.cookie, origin: PUBLIC_URL },
      payload: { path: "/pricing" },
    });
    const exchanged = await plain.app.inject({
      method: "POST",
      url: "/api/heatmap-overlay/session",
      headers: { "content-type": "text/plain", origin: SITE },
      payload: JSON.stringify({ token: minted.json().token }),
    });
    expect(exchanged.json()).toMatchObject({ snapshots: false });
    const response = await save(project.id, exchanged.json().token, snapshot(), { app: plain });
    expect([response.statusCode, response.json().error]).toEqual([409, "object_store_not_set_up"]);
    expect(await listOf(project.id, "/pricing", plain)).toEqual({
      configured: false,
      snapshots: [],
    });
    expect((await sessionFor((await newProject()).id)).length).toBe(43);
  });

  test("an overlay link's page must be a path", async () => {
    const project = await newProject();
    for (const payload of [{ path: "pricing" }, { path: "/a", extra: 1 }, { path: 5 }, ["/a"]]) {
      const response = await dashboard.app.inject({
        method: "POST",
        url: `/api/projects/${project.id}/heatmaps/overlay-link`,
        headers: { cookie: dashboard.cookie, origin: PUBLIC_URL },
        payload,
      });
      expect(response.statusCode).toBe(400);
    }
  });
});

describe("paths PostgreSQL cannot store", () => {
  test("a NUL or an unpaired surrogate is refused with 400 on every route that keeps a path", async () => {
    const project = await newProject();
    const session = await sessionFor(project.id);
    const base = `/api/projects/${project.id}/heatmaps/snapshots`;
    // In an address only a NUL gets through: invalid UTF-8 there reads as U+FFFD, which is stored.
    for (const bad of ["/%00", "/a%00b"]) {
      for (const [method, url] of [
        ["GET", `${base}?path=${bad}`],
        ["GET", `${base}/desktop?path=${bad}`],
        ["GET", `${base}/desktop/player?path=${bad}&period=7d`],
        ["GET", `${base}/desktop/heatmap?path=${bad}&period=7d`],
        ["DELETE", `${base}/desktop?path=${bad}`],
      ] as const) {
        expect([url, (await dashboardCall(method, url)).statusCode]).toEqual([url, 400]);
      }
      const upload = await dashboard.app.inject({
        method: "POST",
        url: `/api/heatmap-overlay/${project.id}/snapshot?path=${bad}`,
        headers: {
          origin: SITE,
          authorization: `Bearer ${session}`,
          "content-type": "application/gzip",
        },
        payload: snapshot(),
      });
      expect([bad, upload.statusCode]).toEqual([bad, 400]);
    }
    // In a JSON body, a NUL and an unpaired surrogate both get through.
    for (const path of ["/\u0000", "/a\ud800"]) {
      const minted = await dashboard.app.inject({
        method: "POST",
        url: `/api/projects/${project.id}/heatmaps/overlay-link`,
        headers: {
          cookie: dashboard.cookie,
          origin: PUBLIC_URL,
          "content-type": "application/json",
        },
        // JSON.stringify writes both as \\u escapes, which JSON.parse reads back.
        payload: JSON.stringify({ path }),
      });
      expect([path, minted.statusCode]).toEqual([path, 400]);
    }
  });
});

describe("saved views in the dashboard", () => {
  test("the view as JSON, its player page under the replay player's policy, and its heatmap", async () => {
    const project = await newProject();
    await save(project.id, await sessionFor(project.id));
    const base = `/api/projects/${project.id}/heatmaps/snapshots/desktop`;
    const json = await dashboardCall("GET", `${base}?path=%2Fpricing`);
    expect(json.statusCode).toBe(200);
    expect(json.headers["content-encoding"]).toBe("gzip");
    expect(JSON.parse(gunzipSync(json.rawPayload).toString("utf8"))).toMatchObject({ v: 1 });
    expect((await dashboardCall("GET", `${base}?path=%2Fother`)).statusCode).toBe(404);
    expect(
      (
        await dashboardCall(
          "GET",
          `/api/projects/${project.id}/heatmaps/snapshots/mobile?path=%2Fpricing`,
        )
      ).statusCode,
    ).toBe(404);

    const page = await dashboardCall("GET", `${base}/player?path=%2Fpricing&period=7d&theme=light`);
    expect(page.statusCode).toBe(200);
    const policy = page.headers["content-security-policy"];
    expect(policy).toContain("script-src 'self'");
    expect(policy).toContain("frame-ancestors 'self'");
    expect(policy).toContain("https://example.com:*");
    expect(page.body).toContain('data-theme="light"');
    expect(page.body).toContain(`data-snapshot-url="${base}?path=%2Fpricing"`);
    expect(page.body).toContain(`data-heatmap-url="${base}/heatmap?path=%2Fpricing&amp;period=7d"`);
    // A path is written into the page escaped.
    const odd = await dashboardCall(
      "GET",
      `${base}/player?path=${encodeURIComponent('/"><script>')}&period=7d`,
    );
    expect(odd.body).not.toContain("<script>x");
    expect(odd.body).not.toContain('"><script>');

    const heatmap = await dashboardCall("GET", `${base}/heatmap?path=%2Fpricing&period=7d`);
    expect(heatmap.statusCode).toBe(200);
    expect(heatmap.json()).toMatchObject({
      path: "/pricing",
      device: "desktop",
      totals: { pageviews: 0, clicks: 0 },
      elements: [],
    });
  });

  test("only the owner and admins delete one; members still see it", async () => {
    const project = await newProject();
    await save(project.id, await sessionFor(project.id));
    const member = await signedInUser(dashboard, {
      name: "Viewer",
      email: `viewer-${randomUUID()}@example.com`,
      grants: { projects: [project.id], areas: { web_analytics: "view" } },
    });
    const url = `/api/projects/${project.id}/heatmaps/snapshots/desktop?path=%2Fpricing`;
    expect((await listOf(project.id)).snapshots).toHaveLength(1);
    const listed = await dashboardCall("GET", url.replace("/desktop", ""), {
      cookie: member.cookie,
    });
    expect(listed.json().snapshots).toHaveLength(1);
    const refused = await dashboardCall("DELETE", url, { cookie: member.cookie });
    expect([refused.statusCode, refused.json().error]).toEqual([403, "forbidden"]);
    expect(await keysOf(project.id)).toHaveLength(1);
  });

  test("delete removes the row and the object, from the dashboard's origin only", async () => {
    const project = await newProject();
    await save(project.id, await sessionFor(project.id));
    const [key] = await keysOf(project.id);
    const url = `/api/projects/${project.id}/heatmaps/snapshots/desktop?path=%2Fpricing`;
    const elsewhere = await dashboard.app.inject({
      method: "DELETE",
      url,
      headers: { cookie: dashboard.cookie, origin: "https://evil.example" },
    });
    expect(elsewhere.statusCode).toBe(403);
    expect((await dashboardCall("DELETE", url)).statusCode).toBe(204);
    expect(await keysOf(project.id)).toEqual([]);
    expect(await store.get(key ?? "")).toBeNull();
    expect((await dashboardCall("DELETE", url)).statusCode).toBe(404);
  });

  test("a member without Web analytics sees none of it", async () => {
    const project = await newProject();
    await save(project.id, await sessionFor(project.id));
    const member = await signedInUser(dashboard, {
      name: "Support",
      email: `support-${randomUUID()}@example.com`,
      grants: { projects: [project.id], areas: { errors: "view" } },
    });
    const base = `/api/projects/${project.id}/heatmaps/snapshots`;
    for (const [method, url] of [
      ["GET", `${base}?path=%2Fpricing`],
      ["GET", `${base}/desktop?path=%2Fpricing`],
      ["GET", `${base}/desktop/player?path=%2Fpricing&period=7d`],
      ["GET", `${base}/desktop/heatmap?path=%2Fpricing&period=7d`],
      ["DELETE", `${base}/desktop?path=%2Fpricing`],
    ] as const) {
      expect([
        url,
        (await dashboardCall(method, url, { cookie: member.cookie })).statusCode,
      ]).toEqual([url, 403]);
    }
    expect(await keysOf(project.id)).toHaveLength(1);
  });

  test("deleting the project deletes its saved views", async () => {
    const project = await newProject();
    await save(project.id, await sessionFor(project.id));
    const [key] = await keysOf(project.id);
    await dashboard.db.deleteFrom("projects").where("id", "=", project.id).execute();
    // Deleting the row queues the project for the purge (project_deletions).
    await purgeDeletedProjects(dashboard.db, dashboard.reader.client, store);
    expect(await store.get(key ?? "")).toBeNull();
    expect(await keysOf(project.id)).toEqual([]);
  });
});
