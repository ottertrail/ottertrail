import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import { FaviconJob, faviconPolicy, fetchFavicon, iconLinksOf } from "../src/avatars/favicons.ts";
import { faviconKind } from "../src/avatars/images.ts";
import { LOCAL_OBJECT_STORE } from "../src/config.ts";
import { addressPolicy } from "../src/outbound/addresses.ts";
import { s3ObjectStore } from "../src/storage/object-store.ts";
import { signedInDashboard } from "./helpers/dashboard.ts";
import { gif, ICO, ico, jpeg, png, SVG, webp } from "./helpers/images.ts";

/** Loopback is allowed only here, for the test's own server. */
const LOCAL = { policy: addressPolicy({ allowPrivate: true }), timeoutMs: 3000 };
const STRICT = { policy: addressPolicy({ allowPrivate: false }), timeoutMs: 3000 };

const PAGE = new URL("https://shop.example/en/index.html");

describe("the icon links a page names", () => {
  test("an Apple touch icon first, then PNGs by size, then the rest; never SVG", () => {
    const html = `<html><head>
      <link rel="stylesheet" href="/app.css">
      <link rel="icon" href="/favicon.svg" type="image/svg+xml">
      <link rel="shortcut icon" href="favicon.ico">
      <link rel="icon" type="image/png" sizes="16x16" href="/icons/16.png">
      <LINK REL="icon" sizes="32x32 64x64" href='/icons/64.png?v=1&amp;x=2'>
      <link rel="apple-touch-icon" href="https://cdn.shop.example/touch.png">
      <link rel="icon" href="javascript:alert(1)">
      <link rel="icon" href="data:image/png;base64,AAAA">
      <link rel="icon" href="/drawn.SVG">
    </head></html>`;
    expect(iconLinksOf(html, PAGE).map((url) => url.href)).toEqual([
      "https://cdn.shop.example/touch.png",
      "https://shop.example/icons/64.png?v=1&x=2",
      "https://shop.example/icons/16.png",
      "https://shop.example/en/favicon.ico",
    ]);
  });

  test("relative addresses follow <base href>", () => {
    const html = '<base href="https://static.shop.example/assets/"><link rel=icon href=fav.png>';
    expect(iconLinksOf(html, PAGE).map((url) => url.href)).toEqual([
      "https://static.shop.example/assets/fav.png",
    ]);
  });

  test("a page without icons names none", () => {
    expect(iconLinksOf("<p>Hello</p>", PAGE)).toEqual([]);
  });

  test("only the head is read: links after </head>, or past 64 KiB, are not", () => {
    const late = '<link rel="icon" href="/late.png">';
    expect(iconLinksOf(`<head></head><body>${late}</body>`, PAGE)).toEqual([]);
    expect(iconLinksOf(`<head>${" ".repeat(64 * 1024)}${late}`, PAGE)).toEqual([]);
  });

  test("a hostile page costs one pass, not seconds", () => {
    const pages = [
      "<link".repeat((512 * 1024) / 5),
      "<base ".repeat((512 * 1024) / 6),
      '<link rel="icon" href="'.repeat((512 * 1024) / 23),
      `<link ${"a=".repeat(256 * 1024)}`,
    ];
    for (const page of pages) {
      const started = performance.now();
      expect(iconLinksOf(page, PAGE)).toEqual([]);
      expect(performance.now() - started).toBeLessThan(1000);
    }
  });
});

describe("what counts as a favicon", () => {
  test("PNG, ICO, JPEG, WebP, and GIF by their bytes; SVG and HTML are refused", () => {
    expect(faviconKind(png(32, 32))).toBe("png");
    expect(faviconKind(ICO)).toBe("ico");
    expect(faviconKind(ico(32, 32))).toBe("ico");
    expect(faviconKind(ico(256, 256))).toBe("ico");
    expect(faviconKind(ico(0, 0, png(64, 64)))).toBe("ico");
    expect(faviconKind(jpeg(180, 180))).toBe("jpg");
    // A progressive frame (SOF2) counts too.
    expect(faviconKind(jpeg(16, 16, 0xc2))).toBe("jpg");
    expect(faviconKind(webp("VP8 ", 32, 32))).toBe("webp");
    expect(faviconKind(webp("VP8L", 1024, 1024))).toBe("webp");
    expect(faviconKind(webp("VP8X", 64, 48))).toBe("webp");
    expect(faviconKind(gif(16, 16))).toBe("gif");
    expect(faviconKind(SVG)).toBeNull();
    expect(faviconKind(Buffer.from("<!doctype html><html></html>"))).toBeNull();
    expect(faviconKind(Buffer.from([0, 0, 1, 0, 0, 0]))).toBeNull();
  });

  test("each format is refused when it declares more than 1024 pixels either way, or no size", () => {
    const huge: [string, Buffer][] = [
      ["PNG", png(1, 1, { width: 1025, height: 16 })],
      ["PNG with no pixels", png(1, 1, { width: 0, height: 0 })],
      ["JPEG", jpeg(65_535, 65_535)],
      ["JPEG, tall", jpeg(16, 2000)],
      ["JPEG without a frame", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])],
      ["JPEG whose data starts before a frame", Buffer.from([0xff, 0xd8, 0xff, 0xda, 0, 2, 0])],
      ["GIF", gif(65_535, 65_535)],
      ["GIF, wide", gif(1025, 1)],
      ["GIF cut off", Buffer.from("GIF89a\x01\0")],
      ["WebP VP8", webp("VP8 ", 16_383, 16_383)],
      ["WebP VP8L", webp("VP8L", 16_384, 16)],
      ["WebP VP8X", webp("VP8X", 65_535, 65_535)],
      ["WebP without a known chunk", Buffer.from("RIFF\0\0\0\0WEBPVP8 ")],
      ["ICO with a huge embedded PNG", ico(0, 0, png(1, 1, { width: 65_535, height: 65_535 }))],
      ["ICO with a broken embedded PNG", ico(16, 16, png(1, 1).subarray(0, 20))],
      ["ICO cut off", Buffer.from([0, 0, 1, 0, 2, 0, 16, 16])],
    ];
    expect(huge.map(([what, bytes]) => [what, faviconKind(bytes)])).toEqual(
      huge.map(([what]) => [what, null]),
    );
  });
});

/** A site on loopback: each path answers what `routes` says. */
let server: Server;
let origin: string;
let routes: Record<
  string,
  { status?: number; type?: string; body?: Buffer | string; location?: string }
>;
const requested: string[] = [];

beforeAll(async () => {
  server = createServer((request, response) => {
    const path = request.url ?? "/";
    requested.push(path);
    const route = routes[path] ?? { status: 404, body: "not here" };
    response.writeHead(route.status ?? 200, {
      "content-type": route.type ?? "text/html",
      ...(route.location === undefined ? {} : { location: route.location }),
    });
    response.end(route.body ?? "");
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((done) => server.close(done));
});

describe("fetching a site's favicon", () => {
  test("takes the page's best icon, resolving its address", async () => {
    const icon = png(180, 180);
    routes = {
      "/": {
        body: '<link rel="icon" href="/fav.ico"><link rel="apple-touch-icon" href="touch.png">',
      },
      "/touch.png": { type: "image/png", body: icon },
      "/fav.ico": { type: "image/x-icon", body: ICO },
    };
    const result = await fetchFavicon(new URL(`${origin}/`), LOCAL);
    expect(result).toEqual({
      ok: true,
      favicon: { kind: "png", bytes: new Uint8Array(icon), url: new URL(`${origin}/touch.png`) },
    });
  });

  test("falls back to /favicon.ico, past a redirect and a link that is not an image", async () => {
    routes = {
      "/": { status: 302, location: "/home" },
      "/home": { body: '<link rel="icon" href="/broken.png"><link rel="icon" href="/vector.svg">' },
      "/broken.png": { type: "image/png", body: "<html>oops</html>" },
      "/favicon.ico": { type: "image/x-icon", body: ICO },
    };
    requested.length = 0;
    const result = await fetchFavicon(new URL(`${origin}/`), LOCAL);
    expect(result).toMatchObject({ ok: true, favicon: { kind: "ico" } });
    expect(requested).toEqual(["/", "/home", "/broken.png", "/favicon.ico"]);
  });

  test("refuses SVG, an icon too large, and a site with none", async () => {
    routes = {
      "/": { body: '<link rel="icon" href="/big.png">' },
      "/big.png": { type: "image/png", body: Buffer.concat([png(8, 8), Buffer.alloc(300 * 1024)]) },
      "/favicon.ico": { type: "image/svg+xml", body: SVG },
    };
    const result = await fetchFavicon(new URL(`${origin}/`), LOCAL);
    expect(result).toEqual({
      ok: false,
      reason: expect.stringContaining("is not a PNG, ICO, JPEG, WebP, or GIF"),
    });
    routes = {};
    expect(await fetchFavicon(new URL(`${origin}/`), LOCAL)).toMatchObject({ ok: false });
  });

  test("follows the address rules: loopback is refused unless allowed", async () => {
    routes = { "/favicon.ico": { type: "image/x-icon", body: ICO } };
    requested.length = 0;
    const result = await fetchFavicon(new URL(`${origin}/`), STRICT);
    expect(result).toEqual({
      ok: false,
      reason: expect.stringContaining("favicons may not reach"),
    });
    expect(requested).toEqual([]);
    // A redirect into the refused range is refused too.
    routes = { "/": { status: 301, location: "http://169.254.169.254/latest/meta-data/" } };
    expect(await fetchFavicon(new URL(`${origin}/`), LOCAL)).toMatchObject({ ok: false });
  });

  test("the worker's rules refuse private addresses even when uptime checks may reach them", async () => {
    routes = { "/favicon.ico": { type: "image/x-icon", body: ICO } };
    requested.length = 0;
    // The instance has opted in for its checks: favicons still may not.
    const policy = faviconPolicy({ uptimeAllowPrivateAddresses: true, uptimeDenyAddresses: [] });
    for (const site of [`${origin}/`, "http://10.0.0.1/", "http://192.168.1.1/"]) {
      const result = await fetchFavicon(new URL(site), { policy, timeoutMs: 3000 });
      expect([site, result]).toEqual([
        site,
        { ok: false, reason: expect.stringContaining("favicons may not reach") },
      ]);
    }
    expect(requested).toEqual([]);
    expect(faviconPolicy({ uptimeDenyAddresses: ["203.0.113.0/24"] }).allowPrivate).toBe(false);
  });
});

describe("the worker's favicon job", () => {
  const store = s3ObjectStore(LOCAL_OBJECT_STORE);
  let dashboard: Awaited<ReturnType<typeof signedInDashboard>>;
  const logs: string[] = [];
  let now = new Date("2026-11-20T12:00:00.000Z");

  beforeAll(async () => {
    dashboard = await signedInDashboard({ objectStore: store });
  });

  afterAll(async () => {
    const rows = await dashboard.db.selectFrom("projects").select("id").execute();
    for (const { id } of rows) await store.deletePrefix(`avatars/projects/${id}/`);
    store.close();
    await dashboard?.close();
  });

  const job = (withStore = true) =>
    new FaviconJob({
      db: dashboard.db,
      store: withStore ? store : null,
      ...LOCAL,
      log: (_level, msg) => logs.push(msg),
      now: () => now,
      // Every site is the test's server.
      siteOf: () => new URL(`${origin}/`),
    });

  test("fetches a new project's favicon once, again when its site changes, and weekly", async () => {
    routes = { "/favicon.ico": { type: "image/x-icon", body: ICO } };
    const project = (
      await dashboard.app.inject({
        method: "POST",
        url: "/api/projects",
        headers: { cookie: dashboard.cookie, origin: "http://localhost:5173" },
        payload: { name: "Shop", allowedHostnames: ["shop.example"] },
      })
    ).json().project;
    // Without an object store, nothing.
    expect(await job(false).tick()).toEqual({ tried: 0, kept: 0 });

    expect(await job().tick()).toEqual({ tried: 1, kept: 1 });
    const row = () =>
      dashboard.db
        .selectFrom("projects")
        .select(["favicon_key", "favicon_hostname"])
        .where("id", "=", project.id)
        .executeTakeFirstOrThrow();
    const first = await row();
    expect(first.favicon_hostname).toBe("shop.example");
    expect(first.favicon_key).toMatch(
      /^avatars\/projects\/[0-9a-f-]{36}\/favicon-[0-9a-f-]{36}\.ico$/,
    );
    const shown = await dashboard.app.inject({
      url: `/api/projects/${project.id}`,
      headers: { cookie: dashboard.cookie },
    });
    expect(shown.json().project).toMatchObject({
      avatarUrl: `/api/${first.favicon_key}`,
      iconUrl: null,
    });
    // Not due again.
    expect(await job().tick()).toEqual({ tried: 0, kept: 0 });

    // A week later it is fetched again, and the old object goes.
    now = new Date(now.getTime() + 8 * 24 * 3600 * 1000);
    expect(await job().tick()).toEqual({ tried: 1, kept: 1 });
    const second = await row();
    expect(second.favicon_key).not.toBe(first.favicon_key);
    expect(await store.get(first.favicon_key ?? "")).toBeNull();

    // A new first site whose favicon fails: the old site's goes, the initial shows.
    routes = {};
    await dashboard.db
      .updateTable("projects")
      .set({ allowed_hostnames: ["other.example"] })
      .where("id", "=", project.id)
      .execute();
    expect(await job().tick()).toEqual({ tried: 1, kept: 0 });
    expect(await row()).toEqual({ favicon_key: null, favicon_hostname: "other.example" });
    expect(await store.get(second.favicon_key ?? "")).toBeNull();
    expect(logs).toContain("no favicon for a project; it shows its initial");
  });
});
