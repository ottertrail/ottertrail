import { describe, expect, test } from "vite-plus/test";

import {
  MAX_REQUESTS,
  newTraceparent,
  pageLoadTrace,
  parseTraceparent,
  type RequestTracingOptions,
  tracedOrigins,
  traceRequests,
} from "../src/traces.ts";

const TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";
const SPAN = "00f067aa0ba902b7";

const navigation = (serverTiming: unknown) => ({
  getEntriesByType: (type: string) => (type === "navigation" ? [{ serverTiming }] : []),
});

describe("the page load's trace from Server-Timing", () => {
  test("reads the entry named traceparent", () => {
    expect(
      pageLoadTrace(
        navigation([
          { name: "db", duration: 12, description: "" },
          { name: "traceparent", duration: 0, description: `00-${TRACE}-${SPAN}-01` },
        ]),
      ),
    ).toEqual({ traceId: TRACE, spanId: SPAN });
  });

  test.each([
    ["uppercase hex", `00-${TRACE.toUpperCase()}-${SPAN}-01`],
    ["an all-zero trace ID", `00-${"0".repeat(32)}-${SPAN}-01`],
    ["an all-zero span ID", `00-${TRACE}-${"0".repeat(16)}-01`],
    ["another version", `01-${TRACE}-${SPAN}-01`],
    ["a version's extra field", `00-${TRACE}-${SPAN}-01-ab`],
    ["a short trace ID", `00-${TRACE.slice(1)}-${SPAN}-01`],
    ["no flags", `00-${TRACE}-${SPAN}`],
    ["something else", "<script>"],
    ["nothing", ""],
  ])("refuses %s", (_label, description) => {
    expect(pageLoadTrace(navigation([{ name: "traceparent", description }]))).toBeUndefined();
  });

  test("takes only the first entry of that name", () => {
    expect(
      pageLoadTrace(
        navigation([
          { name: "traceparent", description: "bad" },
          { name: "traceparent", description: `00-${TRACE}-${SPAN}-01` },
        ]),
      ),
    ).toBeUndefined();
  });

  test("is none without the entry, Server-Timing, or the API", () => {
    expect(pageLoadTrace(navigation([]))).toBeUndefined();
    expect(pageLoadTrace(navigation(undefined))).toBeUndefined();
    expect(pageLoadTrace({ getEntriesByType: () => [] })).toBeUndefined();
    expect(pageLoadTrace({})).toBeUndefined();
    expect(
      pageLoadTrace({
        getEntriesByType: () => {
          throw new Error("old browser");
        },
      }),
    ).toBeUndefined();
  });

  test("parses a header value with spaces around it", () => {
    expect(parseTraceparent(` 00-${TRACE}-${SPAN}-00 `)).toEqual({ traceId: TRACE, spanId: SPAN });
    expect(parseTraceparent(42)).toBeUndefined();
  });
});

describe("a new traceparent", () => {
  test("is a valid version 00 header whose parent is the trace ID's first half", () => {
    const { header, traceId } = newTraceparent((size) => new Uint8Array(size));
    expect(header).toMatch(/^00-[\da-f]{32}-[\da-f]{16}-01$/);
    expect(header).toBe(`00-${traceId}-${traceId.slice(0, 16)}-01`);
    // All-zero random bytes still give IDs that are not all zeros.
    expect(parseTraceparent(header)).toEqual({ traceId, spanId: traceId.slice(0, 16) });
  });
});

describe("the allowed origins", () => {
  test("hold the page's own and the listed ones", () => {
    expect(
      tracedOrigins("https://shop.example", "https://api.example.com, http://localhost:8080/"),
    ).toEqual({
      origins: new Set([
        "https://shop.example",
        "https://api.example.com",
        "http://localhost:8080",
      ]),
      invalid: false,
    });
  });

  test("leave out entries that are not origins", () => {
    expect(
      tracedOrigins("https://shop.example", "api.example.com https://a.example/v1 ftp://b.example"),
    ).toEqual({ origins: new Set(["https://shop.example"]), invalid: true });
  });
});

interface Sent {
  url: string;
  init: RequestInit | undefined;
}

function setUp(overrides: Partial<RequestTracingOptions> = {}) {
  const sent: Sent[] = [];
  let respond: ((status: number) => void) | undefined;
  let fail: (() => void) | undefined;
  let clock = 1000;
  const target: { fetch?: unknown } = {
    fetch: (input: unknown, init?: RequestInit) => {
      sent.push({ url: input instanceof Request ? input.url : String(input), init });
      return new Promise<{ status: number }>((resolve, reject) => {
        respond = (status) => resolve({ status });
        fail = () => reject(new TypeError("Failed to fetch"));
      });
    },
  };
  let sampled = true;
  const recent = traceRequests({
    target,
    base: () => "https://shop.example/cart?id=1",
    origins: new Set(["https://shop.example", "https://api.example.com"]),
    sampled: () => sampled,
    skip: (url) => url.href.startsWith("https://ottertrail.example/api/"),
    random: (size) => new Uint8Array(size).fill(0xab),
    now: () => clock,
    ...overrides,
  });
  const fetch = target.fetch as (input: unknown, init?: RequestInit) => Promise<unknown>;
  const header = (index: number) => new Headers(sent[index]?.init?.headers).get("traceparent");
  return {
    fetch,
    sent,
    recent,
    header,
    respond: (status: number) => respond?.(status),
    fail: () => fail?.(),
    tick: (ms: number) => {
      clock += ms;
    },
    sample: (on: boolean) => {
      sampled = on;
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const OURS = `00-${"ab".repeat(16)}-${"ab".repeat(8)}-01`;

describe("requests", () => {
  test("to the page's origin and listed ones get the header", async () => {
    const page = setUp();
    void page.fetch("/api/orders?secret=1#top", { method: "post", headers: { a: "b" } });
    void page.fetch(new URL("https://api.example.com/v1/items"));
    expect(page.header(0)).toBe(OURS);
    expect(new Headers(page.sent[0]?.init?.headers).get("a")).toBe("b");
    expect(page.sent[0]?.init?.method).toBe("post");
    expect(page.header(1)).toBe(OURS);
  });

  test("to other origins and to Ottertrail go as they were", () => {
    const page = setUp();
    void page.fetch("https://cdn.example.net/app.js");
    void page.fetch("https://ottertrail.example/api/events", { method: "POST", body: "{}" });
    expect(page.sent[0]?.init).toBeUndefined();
    expect(page.header(1)).toBeNull();
    expect(page.recent()).toEqual([]);
  });

  test("keep the app's own traceparent, and its trace", async () => {
    const page = setUp();
    const own = `00-${TRACE}-${SPAN}-01`;
    void page.fetch("/api/cart", { headers: { TraceParent: own } });
    expect(page.header(0)).toBe(own);
    page.respond(200);
    await settle();
    expect(page.recent()[0]?.traceId).toBe(TRACE);
  });

  test("of a Request keep its headers", () => {
    const page = setUp();
    void page.fetch(new Request("https://shop.example/api/me", { headers: { x: "1" } }));
    const headers = new Headers(page.sent[0]?.init?.headers);
    expect(headers.get("x")).toBe("1");
    expect(headers.get("traceparent")).toBe(OURS);
  });

  test("of a page view outside the sample get no header and are not kept", async () => {
    const page = setUp();
    page.sample(false);
    void page.fetch("/api/orders");
    expect(page.sent[0]?.init).toBeUndefined();
    page.respond(200);
    await settle();
    expect(page.recent()).toEqual([]);
  });

  test("keep the last 5, with their path only, status, and duration", async () => {
    const page = setUp();
    for (let index = 0; index < 7; index++) {
      const done = page.fetch(`/api/step/${index}?token=secret#part`, { method: "put" });
      page.tick(10 + index);
      if (index === 6) page.fail();
      else page.respond(200 + index);
      await done.catch(() => {});
      await settle();
    }
    const kept = page.recent();
    expect(kept).toHaveLength(MAX_REQUESTS);
    expect(kept[0]).toEqual({
      method: "PUT",
      path: "/api/step/2",
      status: 202,
      durationMs: 12,
      traceId: "ab".repeat(16),
    });
    expect(kept.at(-1)).toMatchObject({ path: "/api/step/6", status: 0, durationMs: 16 });
    expect(JSON.stringify(kept)).not.toContain("secret");
  });

  test("give the app the same answer and failure", async () => {
    const page = setUp();
    const answer = page.fetch("/api/a");
    page.respond(404);
    await expect(answer).resolves.toEqual({ status: 404 });
    const failure = page.fetch("/api/b");
    page.fail();
    await expect(failure).rejects.toThrow("Failed to fetch");
  });
});

describe("XMLHttpRequest", () => {
  class FakeXhr {
    headers: [string, string][] = [];
    status = 0;
    listeners: (() => void)[] = [];
    url = "";
    open(_method: string, url: string) {
      this.url = url;
    }
    setRequestHeader(name: string, value: string) {
      this.headers.push([name, value]);
    }
    send() {}
    addEventListener(_type: string, listener: () => void) {
      this.listeners.push(listener);
    }
    finish(status: number) {
      this.status = status;
      for (const listener of this.listeners) listener();
    }
  }

  test("gets the header and is kept when it ends", () => {
    const target = { XMLHttpRequest: FakeXhr };
    const recent = traceRequests({
      target,
      base: () => "https://shop.example/",
      origins: new Set(["https://shop.example"]),
      sampled: () => true,
      skip: () => false,
      random: (size) => new Uint8Array(size).fill(0xab),
      now: () => 5,
    });
    const xhr = new FakeXhr();
    xhr.open("get", "/api/search?q=private");
    xhr.send();
    expect(xhr.headers).toEqual([["traceparent", OURS]]);
    xhr.finish(500);
    expect(recent()).toEqual([
      { method: "GET", path: "/api/search", status: 500, durationMs: 0, traceId: "ab".repeat(16) },
    ]);

    const own = new FakeXhr();
    own.open("POST", "/api/save");
    own.setRequestHeader("traceparent", `00-${TRACE}-${SPAN}-01`);
    own.send();
    expect(own.headers).toEqual([["traceparent", `00-${TRACE}-${SPAN}-01`]]);

    const elsewhere = new FakeXhr();
    elsewhere.open("GET", "https://other.example/");
    elsewhere.send();
    expect(elsewhere.headers).toEqual([]);
  });
});
