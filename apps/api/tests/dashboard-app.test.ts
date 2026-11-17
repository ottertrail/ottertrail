import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import { buildApp } from "../src/app.ts";
import {
  DASHBOARD_CONTENT_SECURITY_POLICY,
  dashboardAppRoutes,
  sendsHsts,
} from "../src/dashboard-app/routes.ts";
import { createDatabase } from "../src/db/database.ts";

const INDEX_HTML =
  '<!doctype html><div id="root"></div><script src="/assets/app-a1b2.js"></script>';

describe("the built dashboard", () => {
  // These routes never query the database, and the pool only connects on
  // first use, so this placeholder address is never contacted.
  const db = createDatabase({ connectionString: "postgres://unused@127.0.0.1:1/unused" });
  let directory: string;
  let app: ReturnType<typeof buildApp>;
  let notBuilt: ReturnType<typeof buildApp>;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "ottertrail-dashboard-"));
    const root = join(directory, "dist");
    await mkdir(join(root, "assets"), { recursive: true });
    await writeFile(join(root, "index.html"), INDEX_HTML);
    await writeFile(join(root, "assets", "app-a1b2.js"), "console.log('app');\n");
    await writeFile(join(root, "favicon.svg"), "<svg></svg>");
    // Beside the dashboard, never inside it: must stay unreachable.
    await writeFile(join(directory, "secret.txt"), "not for the web");
    await writeFile(join(directory, "tracker.js"), "console.log('tracker');\n");

    app = buildApp({
      db,
      dashboardPath: root,
      trackerScriptPath: join(directory, "tracker.js"),
    });
    notBuilt = buildApp({ db, dashboardPath: join(directory, "not-built") });
    await app.ready();
    await notBuilt.ready();
  });

  afterAll(async () => {
    await app?.close();
    await notBuilt?.close();
    await db.destroy();
    await rm(directory, { recursive: true, force: true });
  });

  test("serves index.html at /, revalidated on every load", async () => {
    const response = await app.inject({ url: "/" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toMatch(/^text\/html/);
    expect(response.headers["cache-control"]).toBe("no-cache");
    expect(response.body).toBe(INDEX_HTML);
  });

  test.each([
    "/projects",
    "/projects/0b9f3c1e-58a4-4c39-9a0e-3f2b7d6a1c55/web-analytics?period=7d",
    "/setup",
  ])("answers the dashboard's own paths with index.html: %s", async (url) => {
    const response = await app.inject({ url });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-cache");
    expect(response.body).toBe(INDEX_HTML);
  });

  test("caches hashed build files for a year, and other files for an hour", async () => {
    const asset = await app.inject({ url: "/assets/app-a1b2.js" });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers["content-type"]).toMatch(/javascript/);
    expect(asset.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(asset.body).toBe("console.log('app');\n");

    const icon = await app.inject({ url: "/favicon.svg" });
    expect(icon.statusCode).toBe(200);
    expect(icon.headers["cache-control"]).toBe("public, max-age=3600");
  });

  test("answers HEAD like GET", async () => {
    const response = await app.inject({ method: "HEAD", url: "/projects" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toMatch(/^text\/html/);
  });

  test("keeps a missing file a 404 instead of a page", async () => {
    // An old build's file, asked for by a page loaded before a release.
    const response = await app.inject({ url: "/assets/app-old.js" });
    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain("<!doctype html>");
  });

  test("leaves /api to the API: unknown API paths stay JSON 404s", async () => {
    const urls = ["/api", "/api/unknown", "/api/projects/x/nothing"];
    const answers = await Promise.all(
      urls.map(async (url) => {
        const response = await app.inject({ url });
        return { url, status: response.statusCode, type: response.headers["content-type"] };
      }),
    );
    expect(answers).toEqual(
      urls.map((url) => ({ url, status: 404, type: expect.stringMatching(/^application\/json/) })),
    );
    const health = await app.inject({ url: "/api/health" });
    expect(health.json()).toEqual({ status: "ok" });
    const tracker = await app.inject({ url: "/t.js" });
    expect(tracker.body).toBe("console.log('tracker');\n");
  });

  test("never serves files from outside the dashboard's directory", async () => {
    const urls = [
      "/../secret.txt",
      "/..%2fsecret.txt",
      "/%2e%2e/secret.txt",
      "/assets/..%2f..%2fsecret.txt",
    ];
    const leaked = [];
    for (const url of urls) {
      const response = await app.inject({ url });
      if (response.body.includes("not for the web")) {
        leaked.push(url);
      }
    }
    expect(leaked).toEqual([]);
  });

  test("sends security headers with every dashboard file", async () => {
    const urls = ["/", "/projects", "/assets/app-a1b2.js"];
    const answers = await Promise.all(
      urls.map(async (url) => {
        const { headers } = await app.inject({ url });
        return {
          url,
          csp: headers["content-security-policy"],
          frame: headers["x-frame-options"],
          sniff: headers["x-content-type-options"],
          referrer: headers["referrer-policy"],
        };
      }),
    );
    expect(answers).toEqual(
      urls.map((url) => ({
        url,
        csp: DASHBOARD_CONTENT_SECURITY_POLICY,
        frame: "DENY",
        sniff: "nosniff",
        referrer: "same-origin",
      })),
    );
    // Without a public HTTPS URL there is no HSTS: local development is plain HTTP.
    expect((await app.inject({ url: "/" })).headers["strict-transport-security"]).toBeUndefined();
    // The tracker is loaded by other sites: the dashboard's policy is not its business.
    expect((await app.inject({ url: "/t.js" })).headers["content-security-policy"]).toBeUndefined();
  });

  test("tells browsers to use HTTPS only when the public URL is HTTPS", async () => {
    const https = Fastify();
    https.register(dashboardAppRoutes, { root: join(directory, "dist"), hsts: true });
    try {
      const response = await https.inject({ url: "/projects" });
      expect(response.headers["strict-transport-security"]).toBe("max-age=31536000");
    } finally {
      await https.close();
    }
  });

  test.each([
    ["https://analytics.example.com", true],
    ["https://analytics.example.com:8443", true],
    ["http://analytics.example.com", false],
    ["https://localhost", false],
    ["https://localhost:8443", false],
    ["https://ottertrail.localhost", false],
    ["https://127.0.0.1", false],
    ["https://[::1]:8443", false],
  ])("HSTS for %s: %s", (publicUrl, expected) => {
    expect(sendsHsts(publicUrl)).toBe(expected);
  });

  test("answers pages with 503 when the dashboard has not been built", async () => {
    const page = await notBuilt.inject({ url: "/projects" });
    expect(page.statusCode).toBe(503);
    expect(page.headers["cache-control"]).toBe("no-store");
    expect((await notBuilt.inject({ url: "/api/unknown" })).statusCode).toBe(404);
    expect((await notBuilt.inject({ url: "/favicon.svg" })).statusCode).toBe(404);
  });
});
