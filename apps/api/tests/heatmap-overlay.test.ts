import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import { setUserAccess } from "../src/access/grants.ts";
import {
  findOverlayLink,
  OVERLAY_LINK_TTL_MS,
  OVERLAY_SESSION_TTL_MS,
  OVERLAY_TOKEN_KEEP_MS,
  useOverlayLink,
} from "../src/access/overlay-tokens.ts";
import { type AppOptions, buildApp } from "../src/app.ts";
import { createAuth } from "../src/auth/auth.ts";
import { createClickHouse } from "../src/clickhouse/clickhouse.ts";
import { createDatabase } from "../src/db/database.ts";
import { type NewHeatmapRecord, storeHeatmapRecords } from "../src/heatmaps/store.ts";
import { PUBLIC_URL, signedInDashboard, signedInUser } from "./helpers/dashboard.ts";
import { insertProject } from "./helpers/projects.ts";

/*
 * The heatmap overlay's tokens and routes (docs/web-analytics.md, "The
 * overlay on your site"; docs/access.md, "Heatmap overlay tokens"): the
 * dashboard mints a one-time link, o.js exchanges it on the customer's
 * site for a session, and reads aggregates with it.
 */

const SITE = "https://example.com";
const OTHER_SITE = "https://not-the-site.example";
const UNLIMITED = { capacity: 10_000, refillPerSecond: 10_000 };

let dashboard: Awaited<ReturnType<typeof signedInDashboard>>;
const extraApps: FastifyInstance[] = [];

beforeAll(async () => {
  dashboard = await signedInDashboard({
    heatmaps: { overlayExchangeLimit: UNLIMITED, overlayReadLimit: UNLIMITED },
  });
});

afterAll(async () => {
  await Promise.all(extraApps.map((app) => app.close()));
  await dashboard?.close();
});

async function newProject(hostnames = ["example.com", "www.example.com"]) {
  return insertProject(dashboard.db, {
    name: `Site ${randomUUID().slice(0, 8)}`,
    allowed_hostnames: hostnames,
    heatmaps: true,
  });
}

const sha256 = (text: string) => createHash("sha256").update(text).digest();

function mint(projectId: string, cookie = dashboard.cookie, origin = PUBLIC_URL) {
  return dashboard.app.inject({
    method: "POST",
    url: `/api/projects/${projectId}/heatmaps/overlay-link`,
    headers: { cookie, origin },
  });
}

async function linkFor(projectId: string, cookie = dashboard.cookie): Promise<string> {
  const response = await mint(projectId, cookie);
  expect(response.statusCode).toBe(200);
  return response.json().token;
}

function exchange(
  token: unknown,
  {
    origin = SITE,
    app = dashboard.app,
    body,
  }: { origin?: string | null; app?: FastifyInstance; body?: string } = {},
) {
  return app.inject({
    method: "POST",
    url: "/api/heatmap-overlay/session",
    headers: { "content-type": "text/plain", ...(origin === null ? {} : { origin }) },
    payload: body ?? JSON.stringify({ token }),
  });
}

async function sessionFor(projectId: string, cookie = dashboard.cookie): Promise<string> {
  const response = await exchange(await linkFor(projectId, cookie));
  expect(response.statusCode).toBe(200);
  return response.json().token;
}

function read(
  projectId: string,
  authorization: string | null,
  {
    origin = SITE,
    query = "path=%2Fpricing&device=desktop&period=30d",
    app = dashboard.app,
    cookie,
  }: { origin?: string | null; query?: string; app?: FastifyInstance; cookie?: string } = {},
) {
  return app.inject({
    method: "GET",
    url: `/api/heatmap-overlay/${projectId}/heatmap?${query}`,
    headers: {
      ...(origin === null ? {} : { origin }),
      ...(authorization === null ? {} : { authorization }),
      ...(cookie === undefined ? {} : { cookie }),
    },
  });
}

const HOUR_AGO = () => new Date(Date.now() - 60 * 60 * 1000);

function click(values: Partial<NewHeatmapRecord> = {}): NewHeatmapRecord {
  return {
    recordId: randomUUID(),
    kind: "click",
    occurredAt: HOUR_AGO(),
    environment: "production",
    path: "/pricing",
    device: "desktop",
    label: "hero-cta",
    element: "section>a",
    x: 0.2,
    y: 0.4,
    viewportWidth: 1280,
    viewportHeight: 800,
    pageHeight: 3200,
    rage: false,
    depth: 0,
    ...values,
  };
}

function pageview(depth: number, values: Partial<NewHeatmapRecord> = {}): NewHeatmapRecord {
  return click({
    kind: "scroll",
    label: "",
    element: "",
    x: 0,
    y: 0,
    depth,
    fold: 0.25,
    ...values,
  });
}

/** An app on the same databases with its own limits. */
function appWith(heatmaps: AppOptions["heatmaps"]) {
  const app = buildApp({
    db: dashboard.db,
    dashboard: {
      auth: dashboard.auth,
      clickhouse: dashboard.reader.client,
      publicUrl: PUBLIC_URL,
      trustedOrigins: [PUBLIC_URL],
    },
    heatmaps,
  });
  extraApps.push(app);
  return app;
}

describe("minting a link", () => {
  test("needs Web analytics at view and the dashboard's origin; only the token's hash is kept, for 5 minutes", async () => {
    const project = await newProject();
    const before = Date.now();
    const response = await mint(project.id);
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    const { token, expiresAt }: { token: string; expiresAt: string } = response.json();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const rows = await dashboard.db
      .selectFrom("heatmap_overlay_tokens")
      .selectAll()
      .where("project_id", "=", project.id)
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "link", scope: "heatmap:overlay", used_at: null });
    expect(rows[0]?.token_hash.equals(sha256(token))).toBe(true);
    // Nothing in the row is the token itself.
    expect(JSON.stringify(rows)).not.toContain(token);
    const expires = rows[0]?.expires_at.getTime() ?? 0;
    expect(expires).toBeGreaterThanOrEqual(before + OVERLAY_LINK_TTL_MS);
    expect(expires).toBeLessThanOrEqual(Date.now() + OVERLAY_LINK_TTL_MS);
    expect(Date.parse(expiresAt)).toBe(expires);

    const viewer = await signedInUser(dashboard, {
      name: "Viewer",
      email: `viewer-${randomUUID()}@example.com`,
      grants: { projects: [project.id], areas: { web_analytics: "view" } },
    });
    expect((await mint(project.id, viewer.cookie)).statusCode).toBe(200);
    const errorsOnly = await signedInUser(dashboard, {
      name: "Errors only",
      email: `errors-${randomUUID()}@example.com`,
      grants: { projects: [project.id], areas: { errors: "manage" } },
    });
    expect((await mint(project.id, errorsOnly.cookie)).json()).toMatchObject({
      error: "forbidden",
    });
    const elsewhere = await signedInUser(dashboard, {
      name: "Other project",
      email: `other-${randomUUID()}@example.com`,
      grants: { projects: [(await newProject()).id], areas: { web_analytics: "view" } },
    });
    expect((await mint(project.id, elsewhere.cookie)).statusCode).toBe(404);
    expect((await mint(project.id, "")).statusCode).toBe(401);
    // From a page that is not the dashboard: refused, though signed in.
    const forged = await mint(project.id, dashboard.cookie, SITE);
    expect(forged.statusCode).toBe(403);
    expect(forged.json()).toMatchObject({ error: "untrusted_origin" });
  });

  test("expired rows are purged a day after they expire, on the next insert", async () => {
    const project = await newProject();
    // A row long expired, as an old link would be.
    const ancient = new Date(Date.now() - OVERLAY_TOKEN_KEEP_MS - 60_000);
    const recent = new Date(Date.now() - 60_000);
    const { userId, sessionId } = await dashboard.db
      .selectFrom("dashboard_sessions as s")
      .innerJoin("dashboard_users as u", "u.id", "s.user_id")
      .select(["u.id as userId", "s.id as sessionId"])
      .where("u.role", "=", "owner")
      .executeTakeFirstOrThrow();
    await dashboard.db
      .insertInto("heatmap_overlay_tokens")
      .values([
        {
          token_hash: sha256("ancient"),
          kind: "link",
          user_id: userId,
          session_id: sessionId,
          project_id: project.id,
          scope: "heatmap:overlay",
          expires_at: ancient,
        },
        {
          token_hash: sha256("recent"),
          kind: "session",
          user_id: userId,
          session_id: sessionId,
          project_id: project.id,
          scope: "heatmap:overlay",
          expires_at: recent,
        },
      ])
      .execute();
    await linkFor(project.id);
    const left = await dashboard.db
      .selectFrom("heatmap_overlay_tokens")
      .select("token_hash")
      .where("project_id", "=", project.id)
      .execute();
    const hashes = left.map((row) => row.token_hash.toString("hex"));
    expect(hashes).not.toContain(sha256("ancient").toString("hex"));
    // Expired a minute ago: kept, so the overlay can still say it ended.
    expect(hashes).toContain(sha256("recent").toString("hex"));
    expect(hashes).toHaveLength(2);
  });
});

describe("exchanging a link", () => {
  test("works once, from the project's site, for a 30-minute session kept only as a hash", async () => {
    const project = await newProject();
    const link = await linkFor(project.id);
    const before = Date.now();
    const first = await exchange(link);
    expect(first.statusCode).toBe(200);
    expect(first.headers["access-control-allow-origin"]).toBe(SITE);
    expect(first.headers["access-control-allow-credentials"]).toBeUndefined();
    expect(first.headers["cache-control"]).toBe("no-store");
    expect(first.headers["set-cookie"]).toBeUndefined();
    const session: { token: string; projectId: string; expiresAt: string } = first.json();
    expect(session.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(session.token).not.toBe(link);
    expect(session.projectId).toBe(project.id);
    const row = await dashboard.db
      .selectFrom("heatmap_overlay_tokens")
      .selectAll()
      .where("token_hash", "=", sha256(session.token))
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      kind: "session",
      project_id: project.id,
      scope: "heatmap:overlay",
    });
    expect(row.expires_at.getTime()).toBeGreaterThanOrEqual(before + OVERLAY_SESSION_TTL_MS);
    expect(row.expires_at.getTime()).toBeLessThanOrEqual(Date.now() + OVERLAY_SESSION_TTL_MS);

    // Used: never again, and the page may read why.
    const again = await exchange(link);
    expect(again.statusCode).toBe(410);
    expect(again.json()).toMatchObject({ error: "link_expired" });
    expect(again.headers["access-control-allow-origin"]).toBe(SITE);
    expect(again.headers["cache-control"]).toBe("no-store");
    // Two at once: one wins.
    const raced = await linkFor(project.id);
    const answers = await Promise.all([exchange(raced), exchange(raced), exchange(raced)]);
    expect(answers.map((answer) => answer.statusCode).toSorted((a, b) => a - b)).toEqual([
      200, 410, 410,
    ]);
  });

  test("each check on its own: a link is used once, only while valid, and is spent after", async () => {
    const project = await newProject();
    const link = await linkFor(project.id);
    const now = new Date();
    expect((await findOverlayLink(dashboard.db, link, now))?.spent).toBe(false);
    expect(await useOverlayLink(dashboard.db, link, now)).toBe(true);
    expect(await useOverlayLink(dashboard.db, link, now)).toBe(false);
    expect((await findOverlayLink(dashboard.db, link, now))?.spent).toBe(true);
    // Past its 5 minutes, unused.
    const other = await linkFor(project.id);
    const later = new Date(Date.now() + OVERLAY_LINK_TTL_MS + 1000);
    expect((await findOverlayLink(dashboard.db, other, later))?.spent).toBe(true);
    expect(await useOverlayLink(dashboard.db, other, later)).toBe(false);
  });

  test("an expired link is refused as such, readable by the project's site; one never made as unknown, without CORS", async () => {
    const project = await newProject();
    const link = await linkFor(project.id);
    await dashboard.db
      .updateTable("heatmap_overlay_tokens")
      .set({ expires_at: new Date(Date.now() - 1000) } as never)
      .where("token_hash", "=", sha256(link))
      .execute();
    const expired = await exchange(link);
    expect(expired.statusCode).toBe(410);
    expect(expired.json()).toMatchObject({ error: "link_expired" });
    // The link names its project: its site may read why.
    expect(expired.headers["access-control-allow-origin"]).toBe(SITE);
    // No project known: no site may read it (o.js shows nothing either way).
    const unknown = await exchange("A".repeat(43));
    expect(unknown.statusCode).toBe(410);
    expect(unknown.json()).toMatchObject({ error: "link_unknown" });
    expect(unknown.headers["access-control-allow-origin"]).toBeUndefined();
    // A session token is not a link.
    const session = await sessionFor(project.id);
    expect((await exchange(session)).json()).toMatchObject({ error: "link_unknown" });
  });

  test("only from the project's allowed hostnames: another site gets no CORS and does not use up the link", async () => {
    const project = await newProject();
    const link = await linkFor(project.id);
    for (const origin of [OTHER_SITE, "null", "https://example.com.evil.example", null]) {
      const refused = await exchange(link, { origin });
      expect(refused.statusCode).toBe(403);
      expect(refused.json()).toMatchObject({ error: "origin_not_allowed" });
      expect(refused.headers["access-control-allow-origin"]).toBeUndefined();
      expect(refused.headers["cache-control"]).toBe("no-store");
    }
    // Any port, as collection: hostnames have none.
    expect((await exchange(link, { origin: "https://www.example.com:8080" })).statusCode).toBe(200);
  });

  test("only over https, but over http on localhost, .localhost, and 127.0.0.1, on any port", async () => {
    // Links minted on an app of its own: the shared app's links per user are this file's.
    const app = appWith({
      overlayMintLimit: UNLIMITED,
      overlayExchangeLimit: UNLIMITED,
      overlayReadLimit: UNLIMITED,
    });
    const project = await newProject(["example.com", "localhost", "127.0.0.1", "shop.localhost"]);
    const newLink = async () =>
      (
        await app.inject({
          method: "POST",
          url: `/api/projects/${project.id}/heatmaps/overlay-link`,
          headers: { cookie: dashboard.cookie, origin: PUBLIC_URL },
        })
      ).json().token as string;
    const link = await newLink();
    const plain = await exchange(link, { origin: "http://example.com", app });
    expect([plain.statusCode, plain.json().error]).toEqual([403, "origin_not_allowed"]);
    expect(plain.headers["access-control-allow-origin"]).toBeUndefined();
    // Not used up by the refusal.
    expect((await exchange(link, { origin: "http://localhost:5173", app })).statusCode).toBe(200);
    const named = await exchange(await newLink(), { origin: "http://shop.localhost:3000", app });
    expect(named.statusCode).toBe(200);
    const local = await exchange(await newLink(), { origin: "http://127.0.0.1:8080", app });
    expect(local.statusCode).toBe(200);
    const token = `Bearer ${local.json().token}`;
    expect(
      (await read(project.id, token, { origin: "http://127.0.0.1:8080", app })).statusCode,
    ).toBe(200);
    expect((await read(project.id, token, { origin: "http://example.com", app })).statusCode).toBe(
      403,
    );
  });

  test("a user who lost access meanwhile gets no session", async () => {
    const project = await newProject();
    const viewer = await signedInUser(dashboard, {
      name: "Viewer",
      email: `viewer-${randomUUID()}@example.com`,
      grants: { projects: [project.id], areas: { web_analytics: "view" } },
    });
    const link = await linkFor(project.id, viewer.cookie);
    await setUserAccess(dashboard.db, viewer.userId, {
      role: "member",
      projects: [project.id],
      areas: {
        web_analytics: "none",
        product_analytics: "none",
        errors: "view",
        replays: "none",
        users: "none",
        monitoring: "none",
        ai: "none",
        uptime_alerts: "none",
      },
    });
    const refused = await exchange(link);
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ error: "no_access" });
    expect(refused.headers["access-control-allow-origin"]).toBe(SITE);
  });
});

describe("reading the overlay", () => {
  let project = { id: "" };
  beforeAll(async () => {
    project = await newProject();
    await storeHeatmapRecords(dashboard.reader.client, project.id, [
      pageview(0.3),
      pageview(0.6),
      pageview(1),
      pageview(0.5, { device: "mobile", viewportWidth: 390 }),
      // Three on the call to action: two in one cell, one rage click elsewhere
      // that was also a dead click; a dead click on the menu.
      click({ x: 0.2, y: 0.4 }),
      click({ x: 0.24, y: 0.49 }),
      click({ x: 0.99, y: 1, rage: true, dead: true }),
      click({ label: "", element: "body>header>nav>a:2", x: 0.5, y: 0.5, dead: true }),
      click({ device: "mobile", viewportWidth: 390 }),
      click({ path: "/other" }),
      click({ environment: "staging" }),
    ]);
  });

  test("returns aggregates only: totals, devices, reach per 5%, and clicks per element in an 8 by 8 grid", async () => {
    const session = await sessionFor(project.id);
    const response = await read(project.id, `Bearer ${session}`);
    expect(response.statusCode).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBe(SITE);
    expect(response.headers["access-control-allow-credentials"]).toBeUndefined();
    expect(response.headers["cache-control"]).toBe("no-store");
    const body: Record<string, unknown> & { reach: { depth: number; share: number }[] } =
      response.json();
    expect(Object.keys(body).toSorted()).toEqual(
      [
        "path",
        "device",
        "period",
        "environment",
        "firstDay",
        "lastDay",
        "clipped",
        "totals",
        "devices",
        "reach",
        "elements",
      ].toSorted(),
    );
    expect(body).toMatchObject({
      path: "/pricing",
      device: "desktop",
      period: "30d",
      environment: "production",
      clipped: false,
      totals: { pageviews: 3, clicks: 4, rageClicks: 1, deadClicks: 2 },
      devices: [
        { device: "desktop", pageviews: 3 },
        { device: "mobile", pageviews: 1 },
      ],
      elements: [
        {
          label: "hero-cta",
          element: "section>a",
          clicks: 3,
          rageClicks: 1,
          deadClicks: 1,
          cells: [
            [1, 3, 2],
            [7, 7, 1],
          ],
        },
        {
          label: null,
          element: "body>header>nav>a:2",
          clicks: 1,
          rageClicks: 0,
          deadClicks: 1,
          cells: [[4, 4, 1]],
        },
      ],
    });
    expect(body.reach).toHaveLength(20);
    expect(body.reach[0]).toEqual({ depth: 5, share: 1 });
    expect(body.reach.find((step) => step.depth === 50)).toEqual({ depth: 50, share: 0.6667 });
    expect(body.reach.at(-1)).toEqual({ depth: 100, share: 0.3333 });

    const mobile = await read(project.id, `Bearer ${session}`, {
      query: "path=%2Fpricing&device=mobile&period=7d",
    });
    expect(mobile.json()).toMatchObject({ period: "7d", totals: { pageviews: 1, clicks: 1 } });
    const staging = await read(project.id, `Bearer ${session}`, {
      query: "path=%2Fpricing&device=desktop&environment=staging",
    });
    expect(staging.json()).toMatchObject({ environment: "staging", totals: { clicks: 1 } });
  });

  test("a session ends after its 30 minutes", async () => {
    const session = await sessionFor(project.id);
    expect((await read(project.id, `Bearer ${session}`)).statusCode).toBe(200);
    await dashboard.db
      .updateTable("heatmap_overlay_tokens")
      .set({ expires_at: new Date(Date.now() - 1000) } as never)
      .where("token_hash", "=", sha256(session))
      .execute();
    const ended = await read(project.id, `Bearer ${session}`);
    expect(ended.statusCode).toBe(401);
    expect(ended.json()).toMatchObject({ error: "session_expired" });
    // Readable by the site, so the overlay can say so.
    expect(ended.headers["access-control-allow-origin"]).toBe(SITE);
  });

  test("a revoked grant, a removed member, or a deleted project fails on the next read", async () => {
    const own = await newProject();
    const grants = { projects: [own.id], areas: { web_analytics: "view" as const } };
    const revoked = await signedInUser(dashboard, {
      name: "Revoked",
      email: `revoked-${randomUUID()}@example.com`,
      grants,
    });
    const removed = await signedInUser(dashboard, {
      name: "Removed",
      email: `removed-${randomUUID()}@example.com`,
      grants,
    });
    const revokedSession = await sessionFor(own.id, revoked.cookie);
    const removedSession = await sessionFor(own.id, removed.cookie);
    const ownerSession = await sessionFor(own.id);
    for (const session of [revokedSession, removedSession, ownerSession]) {
      expect((await read(own.id, `Bearer ${session}`)).statusCode).toBe(200);
    }
    await setUserAccess(dashboard.db, revoked.userId, {
      role: "member",
      projects: [own.id],
      areas: {
        web_analytics: "none",
        product_analytics: "view",
        errors: "none",
        replays: "none",
        users: "none",
        monitoring: "none",
        ai: "none",
        uptime_alerts: "none",
      },
    });
    const forbidden = await read(own.id, `Bearer ${revokedSession}`);
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json()).toMatchObject({ error: "forbidden" });
    // Its project is known: the site may read it, so the overlay says "no access".
    expect(forbidden.headers["access-control-allow-origin"]).toBe(SITE);
    // The project taken away, the area kept: unknown, as in the dashboard.
    await setUserAccess(dashboard.db, revoked.userId, {
      role: "member",
      projects: [],
      areas: {
        web_analytics: "view",
        product_analytics: "none",
        errors: "none",
        replays: "none",
        users: "none",
        monitoring: "none",
        ai: "none",
        uptime_alerts: "none",
      },
    });
    expect((await read(own.id, `Bearer ${revokedSession}`)).statusCode).toBe(404);

    await dashboard.db.deleteFrom("dashboard_users").where("id", "=", removed.userId).execute();
    const gone = await read(own.id, `Bearer ${removedSession}`);
    expect(gone.statusCode).toBe(401);
    expect(gone.json()).toMatchObject({ error: "session_expired" });

    await dashboard.db.deleteFrom("projects").where("id", "=", own.id).execute();
    const deleted = await read(own.id, `Bearer ${ownerSession}`);
    expect(deleted.statusCode).toBe(403);
    expect(deleted.json()).toMatchObject({ error: "origin_not_allowed" });
    // No project any more: no site may read it.
    expect(deleted.headers["access-control-allow-origin"]).toBeUndefined();
  });

  test("a session for one project cannot read another's, even on the same site", async () => {
    const other = await newProject();
    await storeHeatmapRecords(dashboard.reader.client, other.id, [pageview(1), click()]);
    const session = await sessionFor(project.id);
    const refused = await read(other.id, `Bearer ${session}`);
    expect(refused.statusCode).toBe(401);
    expect(refused.json()).toMatchObject({ error: "session_expired" });
    expect(JSON.stringify(refused.json())).not.toContain("hero-cta");
  });

  test("neither the public key, a link token, nor the dashboard's cookie reads it", async () => {
    const { public_key: publicKey } = await dashboard.db
      .selectFrom("projects")
      .select("public_key")
      .where("id", "=", project.id)
      .executeTakeFirstOrThrow();
    for (const authorization of [`Bearer ${publicKey}`, publicKey, "Bearer ", null]) {
      const refused = await read(project.id, authorization, { cookie: dashboard.cookie });
      expect(refused.statusCode).toBe(401);
      expect(refused.json()).toMatchObject({ error: "invalid_token" });
    }
    // The key in the query is not a parameter at all.
    expect(
      (
        await read(project.id, `Bearer ${"A".repeat(43)}`, {
          query: `path=%2Fpricing&device=desktop&key=${publicKey}`,
          cookie: dashboard.cookie,
        })
      ).statusCode,
    ).toBe(400);
    // A link is for the exchange only.
    const link = await linkFor(project.id);
    const withLink = await read(project.id, `Bearer ${link}`);
    expect(withLink.statusCode).toBe(401);
    expect(withLink.json()).toMatchObject({ error: "session_expired" });
    // And a session token never in the address.
    const session = await sessionFor(project.id);
    expect(
      (await read(project.id, null, { query: `path=%2Fpricing&device=desktop&token=${session}` }))
        .statusCode,
    ).toBe(401);
    expect(
      (
        await read(project.id, `Bearer ${"A".repeat(43)}`, {
          query: `path=%2Fpricing&device=desktop&token=${session}`,
        })
      ).statusCode,
    ).toBe(400);
  });

  test("CORS and the preflight only for the project's allowed hostnames, never with credentials", async () => {
    const session = await sessionFor(project.id);
    const preflight = (origin: string | null) =>
      dashboard.app.inject({
        method: "OPTIONS",
        url: `/api/heatmap-overlay/${project.id}/heatmap?path=%2F&device=desktop`,
        headers: {
          ...(origin === null ? {} : { origin }),
          "access-control-request-method": "GET",
          "access-control-request-headers": "authorization",
        },
      });
    const allowed = await preflight("https://www.example.com");
    expect(allowed.statusCode).toBe(204);
    expect(allowed.headers).toMatchObject({
      "access-control-allow-origin": "https://www.example.com",
      "access-control-allow-methods": "GET",
      "access-control-allow-headers": "Authorization",
      "cache-control": "no-store",
      vary: "Origin",
    });
    expect(allowed.headers["access-control-allow-credentials"]).toBeUndefined();
    for (const origin of [OTHER_SITE, "null", null]) {
      const refused = await preflight(origin);
      expect(refused.statusCode).toBe(403);
      expect(refused.headers["access-control-allow-origin"]).toBeUndefined();
      const readRefused = await read(project.id, `Bearer ${session}`, { origin });
      expect(readRefused.statusCode).toBe(403);
      expect(readRefused.headers["access-control-allow-origin"]).toBeUndefined();
      expect(readRefused.headers["cache-control"]).toBe("no-store");
      expect(readRefused.body).not.toContain("hero-cta");
    }
    expect((await preflight(SITE)).statusCode).toBe(204);
    // A project that does not exist: no CORS either.
    const nowhere = await dashboard.app.inject({
      method: "OPTIONS",
      url: `/api/heatmap-overlay/${randomUUID()}/heatmap`,
      headers: { origin: SITE },
    });
    expect(nowhere.statusCode).toBe(403);
    expect(nowhere.headers["access-control-allow-origin"]).toBeUndefined();
  });

  test("refuses bad queries (400)", async () => {
    const session = await sessionFor(project.id);
    for (const query of [
      "device=desktop",
      "path=%2Fpricing",
      "path=pricing&device=desktop",
      "path=%2F&device=watch",
      "path=%2F&device=desktop&period=12m",
      "path=%2F&device=desktop&period=today",
      "path=%2F&device=desktop&environment=a%20b",
    ]) {
      const answer = await read(project.id, `Bearer ${session}`, { query });
      expect({ query, status: answer.statusCode }).toEqual({ query, status: 400 });
    }
  });
});

describe("limits", () => {
  test("exchanges and reads are limited per client address", async () => {
    const app = appWith({
      overlayExchangeLimit: { capacity: 2, refillPerSecond: 0.001 },
      overlayReadLimit: { capacity: 2, refillPerSecond: 0.001 },
    });
    const project = await newProject();
    for (let index = 0; index < 2; index += 1) {
      expect((await exchange("A".repeat(43), { app })).statusCode).toBe(410);
    }
    const limited = await exchange(await linkFor(project.id), { app });
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
    const unknown = `Bearer ${"A".repeat(43)}`;
    for (let index = 0; index < 2; index += 1) {
      expect((await read(project.id, unknown, { app })).statusCode).toBe(401);
    }
    expect((await read(project.id, unknown, { app })).statusCode).toBe(429);
  });

  test("requests with a token of the wrong form spend a bucket of their own, not the owner's", async () => {
    const app = appWith({
      overlayExchangeLimit: { capacity: 1, refillPerSecond: 0.001 },
      overlayReadLimit: { capacity: 1, refillPerSecond: 0.001 },
    });
    const project = await newProject();
    for (let index = 0; index < 40; index += 1) {
      await exchange("short", { app });
      await exchange(undefined, { app, body: "not json" });
      await read(project.id, "Bearer nope", { app });
      await read(project.id, null, { app });
    }
    // Their own bucket is empty by now.
    expect((await exchange("short", { app })).statusCode).toBe(429);
    // Minted on this app: the shared app's links per user are this file's other tests'.
    const link = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/heatmaps/overlay-link`,
      headers: { cookie: dashboard.cookie, origin: PUBLIC_URL },
    });
    const session = await exchange(link.json().token, { app });
    expect(session.statusCode).toBe(200);
    const answer = await read(project.id, `Bearer ${session.json().token}`, { app });
    expect(answer.statusCode).toBe(200);
  });

  test("malformed requests are refused before any database work", async () => {
    // An app whose databases cannot be reached: anything that touched them would fail with 500.
    const db = createDatabase({ connectionString: "postgres://nobody@127.0.0.1:1/none" });
    const auth = createAuth({
      db,
      publicUrl: PUBLIC_URL,
      trustedOrigins: [PUBLIC_URL],
      secret: "a-secret-only-these-tests-use-0123456789",
    });
    const clickhouse = createClickHouse({
      url: "http://127.0.0.1:1",
      username: "nobody",
      password: "none",
      database: "none",
    });
    const app = buildApp({
      db,
      dashboard: { auth, clickhouse, publicUrl: PUBLIC_URL, trustedOrigins: [PUBLIC_URL] },
      trackerScriptPath: "tracker.js",
      dashboardPath: tmpdir(),
    });
    try {
      const exchanges = await Promise.all([
        exchange("short", { app }),
        exchange(`${"A".repeat(42)}!`, { app }),
        exchange(undefined, { app, body: "not json" }),
        exchange(undefined, { app, body: JSON.stringify({ token: "A".repeat(43), more: 1 }) }),
        exchange(undefined, { app, body: JSON.stringify({ token: "A".repeat(2000) }) }),
        exchange(undefined, { app, body: `{"token":"${"A".repeat(43)}","__proto__":{"x":1}}` }),
      ]);
      expect(exchanges.map((answer) => answer.statusCode)).toEqual([400, 400, 400, 400, 413, 400]);
      expect((await exchange("A".repeat(43), { app, origin: null })).statusCode).toBe(403);
      const projectId = randomUUID();
      const reads = await Promise.all([
        read(projectId, null, { app }),
        read(projectId, "Bearer short", { app }),
        read(projectId, `Basic ${"A".repeat(43)}`, { app }),
        read(projectId, `Bearer ${"A".repeat(43)}`, { app, origin: null }),
        read(projectId, `Bearer ${"A".repeat(43)}`, { app, query: "path=%2F" }),
        read("not-a-uuid", `Bearer ${"A".repeat(43)}`, { app }),
      ]);
      expect(reads.map((answer) => answer.statusCode)).toEqual([401, 401, 401, 403, 400, 400]);
      for (const answer of [...exchanges, ...reads]) {
        expect(answer.headers["cache-control"]).toBe("no-store");
        expect(answer.headers["access-control-allow-origin"]).toBeUndefined();
      }
    } finally {
      await app.close();
      await db.destroy();
      await clickhouse.close();
    }
  });
});

describe("o.js", () => {
  test("is served beside the tracker, as h.js is", async () => {
    const app = buildApp({ db: dashboard.db, trackerScriptPath: "/nowhere/tracker.js" });
    extraApps.push(app);
    // Not built here: the route exists and says so.
    const response = await app.inject({ url: "/o.js" });
    expect(response.statusCode).toBe(503);
    expect(response.body).toContain("has not been built");
  });
});

describe("the dashboard session that made them", () => {
  test("signing out ends its overlay links and sessions", async () => {
    const project = await newProject();
    const viewer = await signedInUser(dashboard, {
      name: "Viewer",
      email: `signout-${randomUUID()}@example.com`,
      grants: { projects: [project.id], areas: { web_analytics: "view" } },
    });
    const session = await sessionFor(project.id, viewer.cookie);
    const link = await linkFor(project.id, viewer.cookie);
    expect((await read(project.id, `Bearer ${session}`)).statusCode).toBe(200);
    const out = await dashboard.app.inject({
      method: "POST",
      url: "/api/auth/sign-out",
      headers: { origin: PUBLIC_URL, cookie: viewer.cookie },
    });
    expect(out.statusCode).toBe(200);
    expect((await read(project.id, `Bearer ${session}`)).json()).toMatchObject({
      error: "session_expired",
    });
    expect((await exchange(link)).json()).toMatchObject({ error: "link_unknown" });
    // Gone with the session, not only refused.
    const left = await dashboard.db
      .selectFrom("heatmap_overlay_tokens")
      .select("kind")
      .where("user_id", "=", viewer.userId)
      .execute();
    expect(left).toEqual([]);
  });

  test("a password reset ends them; the dashboard session's own end does too", async () => {
    const project = await newProject();
    const viewer = await signedInUser(dashboard, {
      name: "Viewer",
      email: `reset-${randomUUID()}@example.com`,
      grants: { projects: [project.id], areas: { web_analytics: "view" } },
    });
    const session = await sessionFor(project.id, viewer.cookie);
    const reset = await dashboard.app.inject({
      method: "POST",
      url: `/api/members/${viewer.userId}/reset-link`,
      headers: { origin: PUBLIC_URL, cookie: dashboard.cookie },
    });
    const made: { url: string } = reset.json();
    const token = new URL(made.url).hash.replace(/^#token=/, "");
    const used = await dashboard.app.inject({
      method: "POST",
      url: "/api/reset-password",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({
        token,
        password: "a brand new password",
        confirmPassword: "a brand new password",
      }),
    });
    expect(used.statusCode).toBeLessThan(300);
    expect((await read(project.id, `Bearer ${session}`)).json()).toMatchObject({
      error: "session_expired",
    });

    // A dashboard session past its end, not yet deleted: its overlay session ends with it.
    const other = await signedInUser(dashboard, {
      name: "Other",
      email: `expiry-${randomUUID()}@example.com`,
      grants: { projects: [project.id], areas: { web_analytics: "view" } },
    });
    const otherSession = await sessionFor(project.id, other.cookie);
    const otherLink = await linkFor(project.id, other.cookie);
    await dashboard.db
      .updateTable("dashboard_sessions")
      .set({ expires_at: new Date(Date.now() - 1000) })
      .where("user_id", "=", other.userId)
      .execute();
    expect((await read(project.id, `Bearer ${otherSession}`)).json()).toMatchObject({
      error: "session_expired",
    });
    expect((await exchange(otherLink)).json()).toMatchObject({ error: "link_expired" });
  });
});

describe("answers before the project is known", () => {
  test("a limit or a malformed token carries no CORS", async () => {
    const app = appWith({
      overlayExchangeLimit: { capacity: 1, refillPerSecond: 0.001 },
      overlayReadLimit: { capacity: 1, refillPerSecond: 0.001 },
    });
    const project = await newProject();
    await exchange("A".repeat(43), { app });
    const limited = await exchange("A".repeat(43), { app });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["access-control-allow-origin"]).toBeUndefined();
    const invalid = await read(project.id, "Bearer nope", { app });
    expect(invalid.json()).toMatchObject({ error: "invalid_token" });
    expect(invalid.headers["access-control-allow-origin"]).toBeUndefined();
  });

  test("links are limited per user (429)", async () => {
    const app = appWith({ overlayMintLimit: { capacity: 2, refillPerSecond: 0.001 } });
    const project = await newProject();
    const mintOn = () =>
      app.inject({
        method: "POST",
        url: `/api/projects/${project.id}/heatmaps/overlay-link`,
        headers: { cookie: dashboard.cookie, origin: PUBLIC_URL },
      });
    expect((await mintOn()).statusCode).toBe(200);
    expect((await mintOn()).statusCode).toBe(200);
    const limited = await mintOn();
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ error: "rate_limited" });
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
  });
});

describe("refusals before any database work", () => {
  test("a 400 or a 429 makes no database call", async () => {
    let queries = 0;
    const counted = dashboard.db.withPlugin({
      transformQuery: (args) => {
        queries += 1;
        return args.node;
      },
      transformResult: async (args) => args.result,
    });
    const app = buildApp({
      db: counted,
      dashboard: {
        auth: dashboard.auth,
        clickhouse: dashboard.reader.client,
        publicUrl: PUBLIC_URL,
        trustedOrigins: [PUBLIC_URL],
      },
      heatmaps: { overlayExchangeLimit: { capacity: 1, refillPerSecond: 0.001 } },
    });
    extraApps.push(app);
    await app.ready();
    // A token of the right form spends the exchange's bucket; this one is unknown.
    expect((await exchange("A".repeat(43), { app })).statusCode).toBe(410);
    queries = 0;
    const malformed = await exchange("short", { app });
    expect(malformed.statusCode).toBe(400);
    await exchange("short", { app });
    const limited = await exchange("A".repeat(43), { app });
    expect(limited.statusCode).toBe(429);
    expect(queries).toBe(0);
  });
});
