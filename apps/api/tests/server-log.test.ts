import { randomBytes } from "node:crypto";
import { connect } from "node:net";

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, test, vi } from "vite-plus/test";

import { buildApp, requestLogFields } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { createDatabase } from "../src/db/database.ts";
import { fitLine, type LogRecord, ServerLogBuffer } from "../src/server-log/buffer.ts";
import { serverLogDestination } from "../src/server-log/destination.ts";
import { WorkerLogListener } from "../src/server-log/listener.ts";
import { redactRecord, redactText, redactUrl } from "../src/server-log/redact.ts";
import { NOTIFY_MAX_BYTES, WorkerLogRelay } from "../src/server-log/relay.ts";
import { signedInDashboard, signedInUser } from "./helpers/dashboard.ts";

/*
 * The Settings page's Server log (docs/dashboard.md, "Server log"): the
 * buffer's bounds, the masking every log line gets, the stream route and
 * who may open it, and the worker's lines over NOTIFY.
 */

const line = (msg: string, fields: LogRecord = {}): LogRecord => ({
  level: 30,
  time: 1_795_000_000_000,
  msg,
  ...fields,
});

/** Polls until `check` holds, at most `ms`. */
async function until(check: () => boolean, ms = 5000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > ms) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("the buffer", () => {
  test("keeps the newest lines, at most maxLines", () => {
    const buffer = new ServerLogBuffer({ maxLines: 3 });
    for (let index = 1; index <= 5; index += 1) buffer.add("api", line(`line ${index}`));
    expect(buffer.size).toBe(3);
    expect(buffer.entries().map((entry) => JSON.parse(entry.text).msg)).toEqual([
      "line 3",
      "line 4",
      "line 5",
    ]);
    expect(buffer.entries().map((entry) => entry.seq)).toEqual([3, 4, 5]);
  });

  test("keeps at most maxBytes, all lines together", () => {
    const buffer = new ServerLogBuffer({ maxLines: 1000, maxBytes: 1000, maxLineBytes: 1000 });
    for (let index = 0; index < 50; index += 1) buffer.add("api", line("x".repeat(80)));
    expect(buffer.bytes).toBeLessThanOrEqual(1000);
    expect(buffer.size).toBeGreaterThan(5);
    expect(buffer.bytes).toBe(buffer.entries().reduce((sum, entry) => sum + entry.bytes, 0));
  });

  test("stays bounded over many lines, the oldest dropped", () => {
    const buffer = new ServerLogBuffer({ maxLines: 10 });
    for (let index = 1; index <= 5000; index += 1) buffer.add("worker", line(`${index}`));
    expect(buffer.size).toBe(10);
    expect(JSON.parse(buffer.entries()[0]?.text ?? "{}").msg).toBe("4991");
  });

  test("cuts a long line and says so", () => {
    const buffer = new ServerLogBuffer({ maxLineBytes: 2000 });
    buffer.add("api", line("a long one", { name: "api", err: { stack: "frame\n".repeat(2000) } }));
    const [entry] = buffer.entries();
    expect(entry?.bytes).toBeLessThanOrEqual(2000);
    const kept = JSON.parse(entry?.text ?? "{}");
    expect(kept).toMatchObject({
      level: 30,
      time: 1_795_000_000_000,
      name: "api",
      msg: "a long one",
      truncated: { keptBytes: 2000 },
    });
    expect(kept.truncated.bytes).toBeGreaterThan(12_000);
    expect(kept.excerpt).toMatch(/^\{"level":30/);
  });

  test("fitLine leaves a line that fits as it is, and cuts multi-byte text by bytes", () => {
    const short = line("short");
    expect(fitLine(short, 1000)).toEqual({ record: short, text: JSON.stringify(short) });
    const cut = fitLine(line("ü".repeat(10_000)), 3000);
    expect(Buffer.byteLength(cut.text)).toBeLessThanOrEqual(3000);
  });

  test("hands each new line to its listeners until they stop, and lists the lines after one", () => {
    const buffer = new ServerLogBuffer();
    const heard: string[] = [];
    const stop = buffer.subscribe((entry) => heard.push(`${entry.process}:${entry.seq}`));
    buffer.add("api", line("one"));
    buffer.add("worker", line("two"));
    stop();
    buffer.add("api", line("three"));
    expect(heard).toEqual(["api:1", "worker:2"]);
    expect(buffer.entries(2).map((entry) => entry.seq)).toEqual([3]);
  });

  test("a listener that throws doesn't stop the others", () => {
    const buffer = new ServerLogBuffer();
    const heard: number[] = [];
    buffer.subscribe(() => {
      throw new Error("a broken stream");
    });
    buffer.subscribe((entry) => heard.push(entry.seq));
    buffer.add("api", line("one"));
    expect(heard).toEqual([1]);
  });
});

describe("masking", () => {
  test.each([
    [
      "a connection string's password",
      "connect ECONNREFUSED postgres://ottertrail:s3cret-pw@postgres:5432/ottertrail",
      "connect ECONNREFUSED postgres://…@postgres:5432/ottertrail",
    ],
    [
      "an SMTP_URL",
      "smtps://alerts%40example.com:p%40ss@smtp.example.com:465 refused",
      "smtps://…@smtp.example.com:465 refused",
    ],
    [
      "a bearer token",
      "Authorization: Bearer sk_0123456789abcdef0123456789abcdef",
      "Authorization: Bearer …",
    ],
    ["a basic credential", "Basic dXNlcjpwYXNzd29yZA==", "Basic …"],
    [
      "a bearer token in lower case",
      "authorization: bearer abcdef0123456789",
      "authorization: bearer …",
    ],
    ["a basic credential in capitals", "BASIC dXNlcjpwYXNzMQ==", "BASIC …"],
    [
      "a password holding @",
      "postgres://u:p@ss@db:5432/x and smtp://a@b:c@@mail:25",
      "postgres://…@db:5432/x and smtp://…@mail:25",
    ],
    ["a secret key in text", "key sk_0123456789abcdef0123456789abcdef refused", "key sk_… refused"],
    [
      "a token in a URL",
      "GET https://example.com/hook?token=abc123&x=1",
      "GET https://example.com/hook?token=…&x=1",
    ],
    ["an API key parameter", "/send?api_key=xyz&b=2", "/send?api_key=…&b=2"],
    [
      "a signature",
      "/file?X-Amz-Signature=abcdef&X-Amz-Credential=AKIA/x",
      "/file?X-Amz-Signature=…&X-Amz-Credential=…",
    ],
    ["an OAuth code and state", "/callback?code=c0de&state=st8", "/callback?code=…&state=…"],
    ["a password parameter", "/login?password=hunter2", "/login?password=…"],
    ["a percent-encoded name", "/hook?%74oken=secret&x=1", "/hook?%74oken=…&x=1"],
    ["an encoded capital", "/send?api_%4Bey=xyz", "/send?api_%4Bey=…"],
    ["mixed-case escapes", "/a?%50a%73%53word=hunter2", "/a?%50a%73%53word=…"],
    ["an encoded name after ;", "/a?x=1;%73ession=s1", "/a?x=1;%73ession=…"],
    ["a malformed escape stays", "/a?%zztoken=t0k&b=%7", "/a?%zztoken=…&b=%7"],
    ["a parameter inside another's value", "/go?next=/cb?token=t0k", "/go?next=/cb?token=…"],
  ])("%s", (_name, text, masked) => {
    expect(redactText(text)).toBe(masked);
  });

  test("an encoded name that only looks like one stays, and a long query takes linear time", () => {
    expect(redactText("/a?%74ok=1&%6Ey=2&%E9=3")).toBe("/a?%74ok=1&%6Ey=2&%E9=3");
    const long = `/a?${"%7".repeat(50_000)}${"?x".repeat(50_000)}=1`;
    const started = performance.now();
    expect(redactText(long)).toBe(long);
    expect(performance.now() - started).toBeLessThan(500);
  });

  test("prose and plain URLs stay as they are", () => {
    for (const text of [
      "Basic authentication failed",
      "Bearer token required",
      "GET /api/projects/p1/analytics?period=7d&environment=staging",
      "https://download.db-ip.com/free/dbip-city-lite-2026-11.mmdb.gz",
      "an email to ada@example.com bounced",
    ]) {
      expect(redactText(text)).toBe(text);
    }
  });

  test.each([
    // Collection with the public key in the query.
    [
      "/api/replays?key=pk_0123456789abcdef0123456789abcdef&replay=r1&seq=0&last=0&cut=0",
      "/api/replays?key=…&replay=r1&seq=0&last=0&cut=0",
    ],
    // Better Auth's own link routes, should anyone call them.
    [
      "/api/auth/reset-password/AbCdEf123?callbackURL=/x",
      "/api/auth/reset-password/…?callbackURL=/x",
    ],
    [
      "/api/auth/verify-email?token=eyJhbGci&callbackURL=/",
      "/api/auth/verify-email?token=…&callbackURL=/",
    ],
    // A dashboard page opened with a token in the query instead of the fragment.
    ["/invite?token=abc", "/invite?token=…"],
    // A site user's ID, a search, and an event property filter's value.
    ["/api/projects/p1/users/ada%40example.com", "/api/projects/p1/users/…"],
    ["/api/projects/p1/users?search=ada&offset=50", "/api/projects/p1/users?search=…&offset=50"],
    [
      "/api/projects/p1/events/signed_up?period=7d&p.email=ada%40example.com&p.plan=pro",
      "/api/projects/p1/events/signed_up?period=7d&p.email=…&p.plan=…",
    ],
    [
      "/api/projects/p1/heatmaps/pages?search=%2Fcheckout",
      "/api/projects/p1/heatmaps/pages?search=…",
    ],
    // A dashboard user's avatar: their ID, as a site user's is.
    ["/api/avatars/users/u1/1f0e.png", "/api/avatars/users/…/1f0e.png"],
    // A site user's ID in a query: the replays list's, and the dashboard's pages'.
    [
      "/api/projects/p1/replays/list?period=7d&userId=alice",
      "/api/projects/p1/replays/list?period=7d&userId=…",
    ],
    ["/projects/p1/replays?user=alice%40x.com", "/projects/p1/replays?user=…"],
    ["/projects/p1/users?user=bob&env=staging", "/projects/p1/users?user=…&env=staging"],
    ["/projects/p1/errors?user=bob", "/projects/p1/errors?user=…"],
    // The same names percent-encoded, as a server reads them.
    ["/projects/p1/errors?%75ser=bob", "/projects/p1/errors?%75ser=…"],
    ["/api/projects/p1/logs?%53EARCH=bob&period=1h", "/api/projects/p1/logs?%53EARCH=…&period=1h"],
    // Text a user typed: the Logs page's search, the logs' and reports' API.
    ["/projects/p1/logs?q=bob%40x.com&live=1", "/projects/p1/logs?q=…&live=1"],
    ["/api/projects/p1/logs?search=bob&period=1h", "/api/projects/p1/logs?search=…&period=1h"],
    ["/api/projects/p1/analytics/list?search=%2Fcart", "/api/projects/p1/analytics/list?search=…"],
    // An email anywhere.
    ["/anything?email=ada%40example.com", "/anything?email=…"],
    // What stays: periods, services, models, features, Ottertrail's own IDs.
    [
      "/api/projects/p1/ai?period=7d&model=gpt-5&feature=chat&service=web",
      "/api/projects/p1/ai?period=7d&model=gpt-5&feature=chat&service=web",
    ],
  ])("a request to %s", (url, masked) => {
    expect(redactUrl(url)).toBe(masked);
    expect(requestLogFields({ method: "GET", url })).toEqual({ method: "GET", url: masked });
  });

  test("masks the paths in a message as a request's URL", () => {
    const { value } = redactRecord(
      line("Route GET:/api/projects/p1/users/ada?userId=bob&token=t0k not found"),
    );
    expect(value.msg).toBe("Route GET:/api/projects/p1/users/…?userId=…&token=… not found");
  });

  test("masks every string of a line, deep, and says whether it changed", () => {
    const record = line("failed", {
      err: { message: "postgres://a:b@c/d", details: ["Bearer abcdef123456"] },
      count: 3,
    });
    const { value, changed } = redactRecord(record);
    expect(changed).toBe(true);
    expect(value).toEqual(
      line("failed", { err: { message: "postgres://…@c/d", details: ["Bearer …"] }, count: 3 }),
    );
    // The original is left as it was.
    expect(record.err).toEqual({ message: "postgres://a:b@c/d", details: ["Bearer abcdef123456"] });
    expect(redactRecord(line("fine"))).toEqual({ value: line("fine"), changed: false });
  });

  test("the destination masks stdout and the buffer, and passes a clean line byte for byte", () => {
    const written: string[] = [];
    const buffer = new ServerLogBuffer();
    const destination = serverLogDestination({ write: (text) => written.push(text) }, buffer);
    const clean = `${JSON.stringify(line("listening"))}\n`;
    destination.write(clean);
    destination.write(`${JSON.stringify(line("down", { err: "postgres://u:pw@db/x" }))}\n`);
    destination.write("not json\n");
    expect(written[0]).toBe(clean);
    expect(written[1]).toBe(`${JSON.stringify(line("down", { err: "postgres://…@db/x" }))}\n`);
    expect(written[2]).toBe("not json\n");
    expect(buffer.entries().map((entry) => entry.text)).toEqual([
      JSON.stringify(line("listening")),
      JSON.stringify(line("down", { err: "postgres://…@db/x" })),
    ]);
  });

  test("a request's log lines hold no header, mask its URL, and the completed line names the request", async () => {
    const written: string[] = [];
    const buffer = new ServerLogBuffer();
    const db = createDatabase({ connectionString: "postgres://nobody@127.0.0.1:1/none" });
    const app = buildApp({
      db,
      log: { level: "info", stream: { write: (text) => written.push(text) } },
      serverLog: { buffer },
    });
    try {
      // Fastify's own "Route … not found" line names the raw URL in its message.
      await app.inject({ method: "GET", url: "/api/nowhere?userId=al1ce-id&q=typed-text" });
      await app.inject({
        method: "GET",
        url: "/api/health?token=tok3n-value",
        headers: {
          authorization: "Bearer sk_0123456789abcdef0123456789abcdef",
          cookie: "better-auth.session_token=s3ssion-value",
        },
      });
    } finally {
      await app.close();
      await db.destroy();
    }
    const text = written.join("");
    for (const secret of [
      "tok3n-value",
      "sk_0123456789abcdef",
      "s3ssion-value",
      "authorization",
      "cookie",
    ]) {
      expect(text).not.toContain(secret);
    }
    const lines = written.map((item) => JSON.parse(item));
    expect(lines.findLast((item) => item.msg === "incoming request")?.req).toEqual({
      method: "GET",
      url: "/api/health?token=…",
    });
    expect(lines.findLast((item) => item.msg === "request completed")?.res).toEqual({
      statusCode: 200,
      method: "GET",
      url: "/api/health?token=…",
    });
    // The same lines are in the buffer, as the API's.
    expect(buffer.entries().map((entry) => entry.process)).toContain("api");
    expect(buffer.size).toBe(written.length);
    expect(text).toContain("Route GET:/api/nowhere?userId=…&q=… not found");
  });
});

/** An open stream: its status, headers, and its events as they come. */
async function openStream(
  baseUrl: string,
  cookie: string | null,
  query = "",
  extraHeaders: Record<string, string> = {},
) {
  const controller = new AbortController();
  const response = await fetch(`${baseUrl}/api/settings/server-log${query}`, {
    headers: { ...(cookie === null ? {} : { cookie }), ...extraHeaders },
    signal: controller.signal,
  });
  const events: { event: string; id?: string; data: string; comment?: boolean }[] = [];
  let ended = false;
  if (
    response.body !== null &&
    response.headers.get("content-type")?.startsWith("text/event-stream")
  ) {
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    void (async () => {
      let pending = "";
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          pending += value;
          let at = pending.indexOf("\n\n");
          while (at >= 0) {
            const block = pending.slice(0, at);
            pending = pending.slice(at + 2);
            if (block.startsWith(":")) {
              events.push({ event: "comment", data: block, comment: true });
            } else {
              const fields = Object.fromEntries(
                block.split("\n").map((field) => {
                  const colon = field.indexOf(": ");
                  return [field.slice(0, colon), field.slice(colon + 2)];
                }),
              );
              events.push({
                event: fields.event ?? "message",
                id: fields.id,
                data: fields.data ?? "",
              });
            }
            at = pending.indexOf("\n\n");
          }
        }
      } catch {
        // Aborted.
      }
      ended = true;
    })();
  }
  return {
    response,
    events,
    get ended() {
      return ended;
    },
    lines: () =>
      events
        .filter((item) => item.event === "message")
        .map((item) => JSON.parse(item.data) as { process: string; line: LogRecord }),
    close: () => controller.abort(),
  };
}

describe("the stream route", () => {
  let dashboard: Awaited<ReturnType<typeof signedInDashboard>>;
  let baseUrl: string;
  const buffer = new ServerLogBuffer();

  beforeAll(async () => {
    buffer.add("api", line("before anyone looked"));
    buffer.add("worker", line("the worker started", { level: "info", name: "worker" }));
    dashboard = await signedInDashboard({
      serverLog: { buffer, maxStreams: 2, heartbeatMs: 100, recheckMs: 100 },
    });
    baseUrl = await dashboard.app.listen({ host: "127.0.0.1", port: 0 });
  });

  afterAll(async () => {
    await dashboard.close();
  });

  test("the owner gets hello, the lines kept, ready, then each new line, and heartbeats", async () => {
    const stream = await openStream(baseUrl, dashboard.cookie);
    try {
      expect(stream.response.status).toBe(200);
      expect(stream.response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
      expect(stream.response.headers.get("cache-control")).toBe("no-store, no-transform");
      expect(stream.response.headers.get("x-accel-buffering")).toBe("no");
      expect(stream.response.headers.get("content-encoding")).toBeNull();
      await until(() => stream.events.some((item) => item.event === "ready"));
      const [hello] = stream.events;
      expect(hello?.event).toBe("hello");
      expect(JSON.parse(hello?.data ?? "{}")).toEqual({
        apiLevel: "silent",
        maxLines: 2000,
        run: buffer.boot,
      });
      expect(stream.lines().slice(0, 2)).toEqual([
        { process: "api", line: line("before anyone looked") },
        { process: "worker", line: line("the worker started", { level: "info", name: "worker" }) },
      ]);
      expect(stream.events.find((item) => item.event === "message")?.id).toBe(`${buffer.boot}:1`);

      buffer.add("worker", line("a live one"));
      await until(() => stream.lines().some((item) => item.line.msg === "a live one"));
      await until(() => stream.events.some((item) => item.comment === true));
    } finally {
      stream.close();
    }
  });

  test("a stream that reconnects gets only the lines after its last; one from before a restart gets all", async () => {
    const last = buffer.entries().at(-1)?.seq ?? 0;
    buffer.add("api", line("after the gap"));
    const resumed = await openStream(baseUrl, dashboard.cookie, `?after=${buffer.boot}:${last}`);
    const older = await openStream(baseUrl, dashboard.cookie, "?after=abcdef:999999");
    try {
      await until(() => resumed.events.some((item) => item.event === "ready"));
      expect(resumed.lines().map((item) => item.line.msg)).toEqual(["after the gap"]);
      await until(() => older.events.some((item) => item.event === "ready"));
      expect(older.lines()).toHaveLength(buffer.size);
    } finally {
      resumed.close();
      older.close();
    }
  });

  test("past the limit of streams, a new one is told it is busy and closed; a closed one frees its place", async () => {
    const first = await openStream(baseUrl, dashboard.cookie);
    const second = await openStream(baseUrl, dashboard.cookie);
    await until(() => second.events.some((item) => item.event === "ready"));
    const third = await openStream(baseUrl, dashboard.cookie);
    await until(() => third.ended);
    expect(third.events).toEqual([{ event: "end", data: '{"reason":"busy","maxStreams":2}' }]);
    first.close();
    second.close();
    // Once the API hears the two close, a new stream gets in.
    let fourth = await openStream(baseUrl, dashboard.cookie);
    const started = Date.now();
    while (!fourth.events.some((item) => item.event === "ready")) {
      if (fourth.ended) fourth = await openStream(baseUrl, dashboard.cookie);
      if (Date.now() - started > 5000) throw new Error("no place freed");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    fourth.close();
  });

  test("admins, members, and anyone signed out get no stream", async () => {
    const admin = await signedInUser(dashboard, {
      name: "Ann Admin",
      email: "ann@example.com",
      role: "admin",
    });
    const member = await signedInUser(dashboard, {
      name: "Max Member",
      email: "max@example.com",
      grants: { projects: "all", areas: { monitoring: "view" } },
    });
    for (const [cookie, status] of [
      [admin.cookie, 403],
      [member.cookie, 403],
      [null, 401],
    ] as const) {
      const response = await fetch(`${baseUrl}/api/settings/server-log`, {
        headers: cookie === null ? {} : { cookie },
      });
      expect({ cookie: cookie !== null, status: response.status }).toEqual({
        cookie: cookie !== null,
        status,
      });
      expect(response.headers.get("content-type")).toMatch(/^application\/json/);
    }
  });

  test("a request from another site is refused: Sec-Fetch-Site, or an Origin not the dashboard's", async () => {
    for (const headers of [
      { "sec-fetch-site": "cross-site" },
      { "sec-fetch-site": "same-site" },
      { origin: "https://evil.example" },
    ]) {
      const response = await fetch(`${baseUrl}/api/settings/server-log`, {
        headers: { cookie: dashboard.cookie, ...headers },
      });
      expect({ headers, status: response.status }).toEqual({ headers, status: 403 });
      expect(await response.json()).toEqual({
        error: "untrusted_origin",
        message: "This request must come from the dashboard.",
      });
    }
    const own = await openStream(baseUrl, dashboard.cookie, "", {
      "sec-fetch-site": "same-origin",
      origin: "http://localhost:5173",
    });
    try {
      expect(own.response.status).toBe(200);
    } finally {
      own.close();
    }
  });

  test("a malformed after is refused before anything else", async () => {
    const response = await fetch(`${baseUrl}/api/settings/server-log?after=nope`, {
      headers: { cookie: dashboard.cookie },
    });
    expect(response.status).toBe(400);
  });

  test("a stream whose session ends is told so and closed", async () => {
    // A second session of the owner's, signed in again, which then ends.
    const signedIn = await dashboard.app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: { origin: "http://localhost:5173", "content-type": "application/json" },
      payload: JSON.stringify({ email: "ada@example.com", password: "correct horse battery" }),
    });
    const cookie = signedIn.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const stream = await openStream(baseUrl, cookie);
    await until(() => stream.events.some((item) => item.event === "ready"));
    const owner = await dashboard.db
      .selectFrom("dashboard_users")
      .select("id")
      .where("role", "=", "owner")
      .executeTakeFirstOrThrow();
    const newest = await dashboard.db
      .selectFrom("dashboard_sessions")
      .select("id")
      .where("user_id", "=", owner.id)
      .orderBy("created_at", "desc")
      .executeTakeFirstOrThrow();
    await dashboard.db.deleteFrom("dashboard_sessions").where("id", "=", newest.id).execute();
    await until(() => stream.ended);
    expect(stream.events.at(-1)).toEqual({ event: "end", data: '{"reason":"access"}' });
  });

  test("a client that stops reading is cut off, and its place freed", async () => {
    const slowBuffer = new ServerLogBuffer();
    const slow = await signedInDashboard({
      serverLog: { buffer: slowBuffer, maxStreams: 1, heartbeatMs: 50 },
    });
    const url = new URL(await slow.app.listen({ host: "127.0.0.1", port: 0 }));
    try {
      // A raw connection that asks for the stream and never reads it.
      const socket = connect(Number(url.port), url.hostname);
      socket.pause();
      socket.on("error", () => undefined);
      socket.write(
        `GET /api/settings/server-log HTTP/1.1\r\nHost: ${url.host}\r\nCookie: ${slow.cookie}\r\n\r\n`,
      );
      await new Promise((resolve) => setTimeout(resolve, 200));
      const big = "x".repeat(15_000);
      let freed = false;
      for (let round = 0; round < 40 && !freed; round += 1) {
        for (let index = 0; index < 200; index += 1) slowBuffer.add("api", line(big));
        await new Promise((resolve) => setTimeout(resolve, 100));
        const probe = await openStream(url.origin, slow.cookie);
        await until(() => probe.ended || probe.events.some((item) => item.event === "ready"));
        freed = probe.events.some((item) => item.event === "ready");
        probe.close();
      }
      expect(freed).toBe(true);
      socket.destroy();
    } finally {
      await slow.close();
    }
  }, 60_000);

  test("closing the app ends every open stream", async () => {
    const extraBuffer = new ServerLogBuffer();
    const second = await signedInDashboard({ serverLog: { buffer: extraBuffer } });
    const url = await second.app.listen({ host: "127.0.0.1", port: 0 });
    const stream = await openStream(url, second.cookie);
    await until(() => stream.events.some((item) => item.event === "ready"));
    await second.close();
    await until(() => stream.ended);
    expect(stream.events.at(-1)?.event).toBe("ready");
  });
});

describe("worker lines over NOTIFY", () => {
  const { databaseUrl } = loadConfig();
  /** A channel of this file's own: NOTIFY reaches every listener on the server. */
  const channel = `test_server_log_${randomBytes(6).toString("hex")}`;
  const applicationName = `test-server-log-${randomBytes(6).toString("hex")}`;
  const buffer = new ServerLogBuffer();
  const warnings: string[] = [];
  const listener = new WorkerLogListener({
    connectionString: databaseUrl,
    buffer,
    channel,
    applicationName,
    log: { info: (msg) => warnings.push(msg), warn: (_fields, msg) => warnings.push(msg) },
  });
  const workerLines = () =>
    buffer
      .entries()
      .filter((entry) => entry.process === "worker")
      .map((entry) => JSON.parse(entry.text) as LogRecord);

  beforeAll(async () => {
    listener.start();
    await until(() => listener.listening);
  });

  afterAll(async () => {
    await listener.stop();
  });

  test("a worker line reaches the buffer as the worker's", async () => {
    const relay = new WorkerLogRelay({ connectionString: databaseUrl, channel });
    try {
      relay.send({ level: "info", time: 1, name: "worker", msg: "retention ran", deleted: 3 });
      await until(() => workerLines().some((item) => item.msg === "retention ran"));
      expect(workerLines().find((item) => item.msg === "retention ran")).toEqual({
        level: "info",
        time: 1,
        name: "worker",
        msg: "retention ran",
        deleted: 3,
      });
    } finally {
      await relay.close();
    }
  });

  test("a line too long for a notification is cut and says so", async () => {
    const relay = new WorkerLogRelay({ connectionString: databaseUrl, channel });
    try {
      relay.send({ level: "error", time: 2, name: "worker", msg: "huge", err: "e".repeat(20_000) });
      await until(() => workerLines().some((item) => item.msg === "huge"));
      const cut = workerLines().find((item) => item.msg === "huge");
      expect(cut).toMatchObject({
        level: "error",
        name: "worker",
        truncated: { keptBytes: NOTIFY_MAX_BYTES },
      });
      expect(Buffer.byteLength(JSON.stringify(cut))).toBeLessThan(8000);
    } finally {
      await relay.close();
    }
  });

  test("past its rate, lines are dropped and counted, and the count goes out as one line", async () => {
    let now = 1_000_000;
    const relay = new WorkerLogRelay({
      connectionString: databaseUrl,
      channel,
      limit: { capacity: 2, refillPerSecond: 1 },
      now: () => now,
    });
    try {
      for (let index = 1; index <= 5; index += 1) {
        relay.send({ level: "info", time: index, name: "worker", msg: `burst ${index}` });
      }
      expect(relay.dropped).toBe(3);
      await until(() => workerLines().some((item) => item.msg === "burst 2"));
      now += 1000;
      relay.send({ level: "info", time: 9, name: "worker", msg: "after the burst" });
      await until(() => workerLines().some((item) => item.msg === "after the burst"));
      const messages = workerLines().map((item) => item.msg);
      expect(messages).not.toContain("burst 3");
      const counted = workerLines().find((item) => item.dropped !== undefined);
      expect(counted).toMatchObject({ level: "warn", name: "worker", dropped: 3 });
      expect(counted?.msg).toBe(
        "3 worker lines didn't reach the Server log: the worker sends at most 1 a second, and none while PostgreSQL is unreachable. docker compose logs worker has every line.",
      );
      // The count comes right before the line that follows the drop.
      expect(messages.indexOf(counted?.msg)).toBe(messages.indexOf("after the burst") - 1);
      expect(relay.dropped).toBe(0);
    } finally {
      await relay.close();
    }
  });

  test("with PostgreSQL unreachable, send never throws or waits, and counts what it dropped", async () => {
    const relay = new WorkerLogRelay({ connectionString: "postgres://nobody@127.0.0.1:1/none" });
    const started = performance.now();
    for (let index = 0; index < 50; index += 1) {
      relay.send({ level: "info", time: index, msg: "nowhere" });
    }
    expect(performance.now() - started).toBeLessThan(50);
    await until(() => relay.dropped === 50);
    // The count's own line, dropped too, adds the lines it counted, not one more.
    for (let index = 0; index < 10; index += 1) {
      relay.send({ level: "info", time: index, msg: "still nowhere" });
      await until(() => relay.dropped === 51 + index);
    }
    expect(relay.dropped).toBe(60);
    await relay.close();
  });

  test("a notification that keeps failing waits before connecting again", async () => {
    const connects = vi.spyOn(Client.prototype, "connect");
    // An empty channel name: PostgreSQL refuses every pg_notify on it.
    const relay = new WorkerLogRelay({ connectionString: databaseUrl, channel: "" });
    try {
      for (let index = 0; index < 20; index += 1) {
        relay.send({ level: "info", time: index, msg: `refused ${index}` });
      }
      await until(() => relay.dropped === 20);
      expect(connects).toHaveBeenCalledTimes(1);
    } finally {
      connects.mockRestore();
      await relay.close();
    }
  });

  test("a lost connection is opened again, and lines arrive after it", async () => {
    const admin = new Client({ connectionString: databaseUrl });
    await admin.connect();
    try {
      await admin.query(
        "select pg_terminate_backend(pid) from pg_stat_activity where application_name = $1",
        [applicationName],
      );
      await until(() => warnings.some((text) => text.startsWith("the Server log lost")));
      await until(() => warnings.includes("the Server log hears the worker again"), 10_000);
    } finally {
      await admin.end();
    }
    const relay = new WorkerLogRelay({ connectionString: databaseUrl, channel });
    try {
      relay.send({ level: "info", time: 3, name: "worker", msg: "back again" });
      await until(() => workerLines().some((item) => item.msg === "back again"));
      expect(listener.listening).toBe(true);
    } finally {
      await relay.close();
    }
  });

  test("a payload that is no log line is shown as a warning, not dropped silently", async () => {
    const sender = new Client({ connectionString: databaseUrl });
    await sender.connect();
    try {
      await sender.query("select pg_notify($1, $2)", [channel, "not json"]);
    } finally {
      await sender.end();
    }
    await until(() =>
      workerLines().some((item) => item.msg === "a worker log line could not be read"),
    );
    expect(workerLines().at(-1)).toMatchObject({ level: "warn" });
  });
});
