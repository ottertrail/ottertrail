import { existsSync } from "node:fs";
import { symlink } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

import { afterEach, describe, expect, test } from "vite-plus/test";

import { parseRetryAfter } from "../src/upload.ts";
import {
  buildDirectory,
  type Handler,
  reply,
  runCommand,
  SECRET_KEY,
  sourceMap,
  startServer,
} from "./helpers.ts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function setup(files: Record<string, string>, handler: Handler) {
  const build = await buildDirectory(files);
  const server = await startServer(handler);
  cleanups.push(build.remove, server.close);
  return { directory: build.directory, server };
}

const upload = (directory: string, host: string, ...more: string[]) => [
  "upload",
  directory,
  "--release",
  "1.4.2",
  "--host",
  host,
  ...more,
];

describe("upload", () => {
  test("sends each map gzip-compressed, with the key, release, and URL path", async () => {
    const { directory, server } = await setup(
      {
        "assets/index-4f3a.js": "console.log(1)",
        "assets/index-4f3a.js.map": sourceMap("index"),
        "assets/chunks/worker.mjs": "",
        "assets/chunks/worker.mjs.map": sourceMap("worker"),
        "assets/style.css": "",
        "assets/style.css.map": "{}",
      },
      (request, response) =>
        reply(response, request.url.searchParams.get("path")?.includes("worker") ? 200 : 201),
    );

    const result = await runCommand(upload(directory, server.host, "--url-prefix", "static"));

    expect(result.code).toBe(0);
    expect(server.requests).toHaveLength(2);
    const byPath = new Map(server.requests.map((r) => [r.url.searchParams.get("path"), r]));
    const index = byPath.get("/static/assets/index-4f3a.js");
    expect(index).toBeDefined();
    expect(index?.method).toBe("PUT");
    expect(index?.url.pathname).toBe("/api/source-maps");
    expect(index?.url.searchParams.get("release")).toBe("1.4.2");
    expect(index?.headers.authorization).toBe(`Bearer ${SECRET_KEY}`);
    expect(index?.headers["content-type"]).toBe("application/json");
    expect(index?.headers["content-encoding"]).toBe("gzip");
    expect(gunzipSync(index?.body ?? Buffer.alloc(0)).toString()).toBe(sourceMap("index"));
    expect(byPath.has("/static/assets/chunks/worker.mjs")).toBe(true);

    expect(result.stdout).toMatch(/stored\s+\/static\/assets\/index-4f3a\.js/u);
    expect(result.stdout).toMatch(/replaced\s+\/static\/assets\/chunks\/worker\.mjs/u);
    expect(result.stdout).toContain("1 stored, 1 replaced, 0 failed");
    expect(result.stdout + result.stderr).not.toContain(SECRET_KEY);
    expect(result.stdout + result.stderr).not.toContain(SECRET_KEY.slice(3, 12));
  });

  test("tries again after a 503, waiting as Retry-After says", async () => {
    let calls = 0;
    const { directory, server } = await setup(
      { "app.js": "", "app.js.map": sourceMap("app") },
      (_request, response) => {
        calls++;
        if (calls === 1) {
          reply(
            response,
            503,
            { error: "storage_unavailable", message: "Try again." },
            {
              "retry-after": "7",
            },
          );
        } else {
          reply(response, 201);
        }
      },
    );
    const waits: number[] = [];

    const result = await runCommand(upload(directory, server.host), {
      sleep: async (milliseconds) => {
        waits.push(milliseconds);
      },
    });

    expect(result.code).toBe(0);
    expect(server.requests).toHaveLength(2);
    expect(waits).toEqual([7000]);
    expect(result.stdout).toContain("1 stored");
  });

  test("waits as often as the server asks, without counting it as a failed attempt", async () => {
    // Six server waits exceed the failed-attempt limit.
    let calls = 0;
    const { directory, server } = await setup(
      { "app.js": "", "app.js.map": sourceMap("app") },
      (_request, response) => {
        calls++;
        if (calls <= 6) {
          reply(response, 503, { error: "busy", message: "Try again." }, { "retry-after": "2" });
        } else {
          reply(response, 201);
        }
      },
    );
    const waits: number[] = [];

    const result = await runCommand(upload(directory, server.host), {
      sleep: async (milliseconds) => {
        waits.push(milliseconds);
      },
    });

    expect(result.code).toBe(0);
    expect(server.requests).toHaveLength(7);
    expect(waits).toEqual(Array.from({ length: 6 }, () => 2000));
  });

  test("gives up after a few attempts, with backoff when no Retry-After is sent", async () => {
    const { directory, server } = await setup(
      { "app.js": "", "app.js.map": sourceMap("app") },
      (_request, response) =>
        reply(response, 429, { error: "rate_limited", message: "Slow down." }),
    );
    const waits: number[] = [];

    const result = await runCommand(upload(directory, server.host), {
      sleep: async (milliseconds) => {
        waits.push(milliseconds);
      },
    });

    expect(result.code).toBe(1);
    expect(server.requests).toHaveLength(4);
    expect(waits).toEqual([1000, 2000, 4000]);
    expect(result.stderr).toContain("429 rate_limited: Slow down. (after 4 attempts)");
  });

  test("reports a 400 with the server's message and exits non-zero", async () => {
    const { directory, server } = await setup(
      { "good.js": "", "good.js.map": sourceMap("good"), "bad.js": "", "bad.js.map": "nope" },
      (request, response) => {
        if (request.url.searchParams.get("path") === "/bad.js") {
          reply(response, 400, {
            error: "invalid_source_map",
            message: "The body is not a source map.",
          });
        } else {
          reply(response, 201);
        }
      },
    );

    const result = await runCommand(upload(directory, server.host));

    expect(result.code).toBe(1);
    expect(server.requests).toHaveLength(2);
    expect(result.stderr).toMatch(
      /failed\s+\/bad\.js\s+bad\.js\.map: 400 invalid_source_map: The body is not a source map\./u,
    );
    expect(result.stderr).toContain("1 stored, 0 replaced, 1 failed");
  });

  test("stops starting uploads once the key is refused", async () => {
    const files: Record<string, string> = {};
    for (let index = 0; index < 6; index++) {
      files[`chunk-${index}.js`] = "";
      files[`chunk-${index}.js.map`] = sourceMap(String(index));
    }
    const { directory, server } = await setup(files, (_request, response) =>
      reply(response, 401, { error: "unknown_key", message: "No project has this secret key." }),
    );

    const result = await runCommand(upload(directory, server.host, "--concurrency", "1"));

    expect(result.code).toBe(1);
    expect(server.requests).toHaveLength(1);
    expect(result.stderr).toContain("5 not sent");
  });

  test("reports a server that cannot be reached", async () => {
    const { directory, server } = await setup({ "a.js": "", "a.js.map": sourceMap("a") }, () => {});
    await server.close();

    const result = await runCommand(upload(directory, server.host));

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("could not reach the server after 4 attempts");
  });

  test("a dry run lists the maps and sends nothing, even without a key", async () => {
    const { directory, server } = await setup(
      { "assets/a.js": "", "assets/a.js.map": sourceMap("a") },
      (_request, response) => reply(response, 201),
    );

    const result = await runCommand(upload(directory, server.host, "--dry-run"), { env: {} });

    expect(result.code).toBe(0);
    expect(server.requests).toHaveLength(0);
    expect(result.stdout).toMatch(/would send\s+\/assets\/a\.js\s+assets\/a\.js\.map/u);
    expect(result.stdout).toContain("1 source map would be uploaded.");
    expect(existsSync(join(directory, "assets/a.js.map"))).toBe(true);
  });

  test("--delete-after-upload deletes only the maps that were uploaded", async () => {
    const { directory, server } = await setup(
      {
        "ok.js": "",
        "ok.js.map": sourceMap("ok"),
        "again.cjs": "",
        "again.cjs.map": sourceMap("again"),
        "bad.js": "",
        "bad.js.map": sourceMap("bad"),
        "orphan.js.map": sourceMap("orphan"),
        "notes.txt": "keep",
      },
      (request, response) => {
        const path = request.url.searchParams.get("path");
        if (path === "/bad.js") reply(response, 413, { error: "too_large", message: "Too big." });
        else reply(response, path === "/again.cjs" ? 200 : 201);
      },
    );

    const result = await runCommand(upload(directory, server.host, "--delete-after-upload"));

    expect(result.code).toBe(1);
    expect(existsSync(join(directory, "ok.js.map"))).toBe(false);
    expect(existsSync(join(directory, "again.cjs.map"))).toBe(false);
    expect(existsSync(join(directory, "bad.js.map"))).toBe(true);
    expect(existsSync(join(directory, "orphan.js.map"))).toBe(true);
    for (const kept of ["ok.js", "again.cjs", "bad.js", "notes.txt"]) {
      expect(existsSync(join(directory, kept))).toBe(true);
    }
    expect(result.stderr).toContain("2 deleted");
  });

  test("skips maps without their minified file, and does not follow symbolic links", async () => {
    const outside = await buildDirectory({
      "elsewhere.js": "",
      "elsewhere.js.map": sourceMap("x"),
    });
    cleanups.push(outside.remove);
    const { directory, server } = await setup(
      { "app.js": "", "app.js.map": sourceMap("app"), "lost.js.map": sourceMap("lost") },
      (_request, response) => reply(response, 201),
    );
    await symlink(outside.directory, join(directory, "linked"));

    const result = await runCommand(upload(directory, server.host, "--delete-after-upload"));

    expect(result.code).toBe(0);
    expect(server.requests.map((r) => r.url.searchParams.get("path"))).toEqual(["/app.js"]);
    expect(result.stderr).toContain("Skipped lost.js.map");
    expect(existsSync(join(outside.directory, "elsewhere.js.map"))).toBe(true);
  });
});

const KEY_ENV = { OTTERTRAIL_SECRET_KEY: SECRET_KEY };
const BASE = ["upload", "<dir>", "--release", "1.0", "--host", "https://analytics.example.com"];
const withHost = (release: string, host: string) => [
  "upload",
  "<dir>",
  "--release",
  release,
  "--host",
  host,
];

/** Replace "<dir>" in argv with a temporary build directory containing one map. */
async function runOnBuild(argv: string[], env: Record<string, string | undefined>) {
  const build = await buildDirectory({ "a.js": "", "a.js.map": sourceMap("a") });
  cleanups.push(build.remove);
  return runCommand(
    argv.map((arg) => (arg === "<dir>" ? build.directory : arg)),
    { env },
  );
}

describe("input validation", () => {
  test.each<[string, string[], Record<string, string | undefined>, string]>([
    ["a missing key", BASE, {}, "Missing the secret key"],
    [
      "a malformed key",
      BASE,
      { OTTERTRAIL_SECRET_KEY: `pk_${"0123456789abcdef".repeat(2)}` },
      "is not a secret key",
    ],
    [
      "a key given as a flag",
      [...BASE, `--key=${SECRET_KEY}`],
      KEY_ENV,
      "environment variable only",
    ],
    [
      "a host that is not http(s)",
      withHost("1.0", "ftp://example.com"),
      KEY_ENV,
      "--host must start with https://",
    ],
    ["a host with a path", withHost("1.0", "https://example.com/api"), KEY_ENV, "without a path"],
    [
      "a host that is not a URL",
      withHost("1.0", "analytics.example.com"),
      KEY_ENV,
      "--host is not a URL",
    ],
    [
      "a release with a space",
      withHost("1.0 beta", "https://e.com"),
      KEY_ENV,
      "--release may not contain",
    ],
    [
      "a release that is too long",
      withHost("x".repeat(201), "https://e.com"),
      KEY_ENV,
      "at most 200",
    ],
    [
      "a missing release",
      ["upload", "<dir>", "--host", "https://e.com"],
      KEY_ENV,
      "Missing --release",
    ],
    [
      "a missing directory",
      ["upload", "/nonexistent/ottertrail-build", "--release", "1", "--host", "https://e.com"],
      KEY_ENV,
      "does not exist",
    ],
    ["a bad concurrency", [...BASE, "--concurrency", "0"], KEY_ENV, "--concurrency"],
    ["a bad URL prefix", [...BASE, "--url-prefix", "/a?b"], KEY_ENV, "--url-prefix"],
    ["an unknown command", ["send", "<dir>"], KEY_ENV, 'Unknown command "send"'],
  ])("refuses %s, before sending anything", async (_name, argv, env, message) => {
    const result = await runOnBuild(argv, env);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(message);
    expect(result.stdout + result.stderr).not.toContain("0123456789abcdef");
  });

  test("a directory without source maps", async () => {
    const build = await buildDirectory({ "a.js": "" });
    cleanups.push(build.remove);
    const result = await runCommand([
      "upload",
      build.directory,
      "--release",
      "1",
      "--host",
      "https://e.com",
    ]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("no source maps");
  });

  test("--help", async () => {
    const result = await runCommand(["--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Usage: ottertrail-sourcemaps upload");
  });
});

describe("parseRetryAfter", () => {
  test("reads seconds and HTTP dates, and caps the wait", () => {
    expect(parseRetryAfter("3")).toBe(3000);
    expect(parseRetryAfter("100000")).toBe(120_000);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4000)).toBe(6000);
    expect(parseRetryAfter("soon")).toBeNull();
    expect(parseRetryAfter(null)).toBeNull();
  });
});
