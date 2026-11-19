import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import { MAX_ENGAGED_MS } from "../src/engagement.ts";
import { HEATMAP_PROPERTY, type HeatmapConfig } from "../src/heatmap-names.ts";
import { type OverlayConfig, OVERLAY_PROPERTY } from "../src/overlay-names.ts";
import { type Recorder, REPLAY_PROPERTY, type ReplayConfig } from "../src/replay-names.ts";
import type { QueuedEvent } from "../src/tracker.ts";
import { RECORD_PROPERTY } from "../src/vital-names.ts";
import { STAND_IN } from "./stand-in.ts";

interface SentBatch {
  events: QueuedEvent[];
}

type Listener = (event: object) => void;

/** Stands in for the browser's ErrorEvent, which Node lacks. */
class FakeErrorEvent {
  message: string;
  filename: string;
  error: unknown;
  constructor({
    message = "",
    filename = "",
    error = null,
  }: {
    message?: string;
    filename?: string;
    error?: unknown;
  }) {
    this.message = message;
    this.filename = filename;
    this.error = error;
  }
}

/** Just enough of a browser page to run src/script.ts as a <script> tag would. */
function fakePage(
  href: string,
  referrer = "",
  {
    maxTouchPoints = 0,
    attributes = {},
    src = "https://analytics.example.com/t.js",
    nonce = "",
  }: {
    maxTouchPoints?: number;
    attributes?: Record<string, string>;
    src?: string;
    nonce?: string;
  } = {},
) {
  const listeners: Record<string, Listener[]> = {};
  const on = (type: string, listener: Listener) => {
    (listeners[type] ??= []).push(listener);
  };
  const location = {
    href,
    get pathname() {
      return new URL(this.href).pathname;
    },
    get search() {
      return new URL(this.href).search;
    },
    get hash() {
      return new URL(this.href).hash;
    },
  };
  /** Scripts the tracker added to the page: v.js. */
  const added: Record<string, unknown>[] = [];
  const document = {
    currentScript: {
      src,
      nonce,
      dataset: { key: "pk_test", host: "https://analytics.example.com", ...attributes } as Record<
        string,
        string | undefined
      >,
    },
    createElement: (tagName: string) => ({ tagName }) as Record<string, unknown>,
    head: { append: (element: Record<string, unknown>) => added.push(element) },
    referrer,
    visibilityState: "visible" as "visible" | "hidden",
    prerendering: false,
    addEventListener: on,
  };
  const window = {
    location,
    history: {
      state: null as unknown,
      pushState: () => {},
      replaceState: (_state?: unknown, _title?: string, url?: string) => {
        if (url !== undefined) location.href = new URL(url, location.href).href;
      },
    },
    addEventListener: on,
    ottertrail: undefined as
      | {
          track(name: string, properties?: object): void;
          identify(userId: string, signature?: string): void;
          reset(): void;
          captureError(error: unknown, properties?: object): void;
          replay(on: boolean): void;
        }
      | undefined,
  };
  /** Everything the tracker handed over, by beacon or fetch. */
  const events: QueuedEvent[] = [];
  /** Every batch as sent, envelope included. */
  const batches: (SentBatch & { touch?: boolean; environment?: string; release?: string })[] = [];
  const record = (body: string) => {
    const batch = JSON.parse(body) as SentBatch & {
      touch?: boolean;
      environment?: string;
      release?: string;
    };
    batches.push(batch);
    events.push(...batch.events);
  };

  vi.stubGlobal("ErrorEvent", FakeErrorEvent);
  vi.stubGlobal("document", document);
  vi.stubGlobal("location", location);
  vi.stubGlobal("window", window);
  vi.stubGlobal("history", window.history);
  vi.stubGlobal("navigator", {
    maxTouchPoints,
    sendBeacon: (_url: string, blob: Blob) => {
      void blob.text().then(record);
      return true;
    },
  });
  vi.stubGlobal("fetch", (_url: string, init: { body: string }) => {
    record(init.body);
    return Promise.resolve({ status: 202, headers: { get: () => null } });
  });

  const fire = (type: string, event: object = {}) => {
    for (const listener of listeners[type] ?? []) listener(event);
  };
  return {
    window,
    document,
    events,
    batches,
    added,
    /** The visitor hides the tab or locks the phone. */
    hide: () => {
      document.visibilityState = "hidden";
      fire("visibilitychange");
    },
    show: () => {
      document.visibilityState = "visible";
      fire("visibilitychange");
    },
    fire,
    /** Lets beacon bodies (read from Blobs) arrive. */
    settle: () => vi.advanceTimersByTimeAsync(0),
  };
}

async function runScript() {
  vi.resetModules();
  await import("../src/script.ts");
}

const start = Date.parse("2026-11-16T10:00:00.000Z");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(start);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const summary = (events: QueuedEvent[]) =>
  events.map((event) => [event.name, event.url, event.properties?.engagedMs]);

describe("back/forward cache", () => {
  test("a restored page records a pageview and times the new visit from zero", async () => {
    const page = fakePage("https://example.com/pricing");
    await runScript();

    vi.setSystemTime(start + 5000);
    page.fire("pagehide", { persisted: true }); // Into the cache.
    page.hide();
    vi.setSystemTime(start + 65_000); // A minute in the cache.
    page.document.visibilityState = "visible";
    page.fire("pageshow", { persisted: true }); // Back button: restored.
    page.show();
    vi.setSystemTime(start + 68_000);
    page.hide();
    await page.settle();

    expect(summary(page.events)).toEqual([
      ["pageview", "https://example.com/pricing", undefined],
      ["engagement", "https://example.com/pricing", 5000],
      ["pageview", "https://example.com/pricing", undefined],
      ["engagement", "https://example.com/pricing", 3000],
    ]);
  });

  test("time in the cache never counts, even without visibilitychange events", async () => {
    const page = fakePage("https://example.com/pricing");
    await runScript();

    vi.setSystemTime(start + 5000);
    page.fire("pagehide", { persisted: true });
    vi.setSystemTime(start + 65_000);
    page.fire("pageshow", { persisted: true });
    vi.setSystemTime(start + 68_000);
    page.fire("pagehide", { persisted: false });
    await page.settle();

    expect(summary(page.events)).toEqual([
      ["pageview", "https://example.com/pricing", undefined],
      ["engagement", "https://example.com/pricing", 5000],
      ["pageview", "https://example.com/pricing", undefined],
      ["engagement", "https://example.com/pricing", 3000],
    ]);
  });

  test("the first load's pageshow is not a second pageview", async () => {
    const page = fakePage("https://example.com/pricing");
    await runScript();
    page.fire("pageshow", { persisted: false });
    page.hide();
    await page.settle();

    expect(page.events.map((event) => event.name)).toEqual(["pageview"]);
  });
});

describe("limits the API enforces", () => {
  test("engaged time is capped at 24 hours", async () => {
    const page = fakePage("https://example.com/pricing");
    await runScript();

    vi.setSystemTime(start + 25 * 60 * 60 * 1000);
    page.hide();
    await page.settle();

    expect(page.events[1]).toMatchObject({
      name: "engagement",
      properties: { engagedMs: MAX_ENGAGED_MS },
    });
  });

  test("events on a page whose path is too long are dropped; the referrer it leaves is not sent", async () => {
    const longPath = `/${"a".repeat(2048)}`;
    const page = fakePage(`https://example.com${longPath}`);
    await runScript();
    page.window.ottertrail?.track("signup");

    page.window.location.href = "https://example.com/next";
    page.window.history.pushState(); // The wrapped pushState notices the new path.
    page.hide();
    await page.settle();

    expect(page.events).toHaveLength(1);
    expect(page.events[0]).toMatchObject({ name: "pageview", url: "https://example.com/next" });
    expect(page.events[0]).not.toHaveProperty("referrer");
  });

  test("a referrer longer than 8,192 characters is left out, not sent", async () => {
    const page = fakePage("https://example.com/", `https://other.example/${"r".repeat(8192)}`);
    await runScript();
    page.hide();
    await page.settle();

    expect(page.events).toHaveLength(1);
    expect(page.events[0]).not.toHaveProperty("referrer");
  });
});

describe("the touch hint", () => {
  test.each([
    [5, true],
    [1, undefined],
    [0, undefined],
  ])("a device with %i touch points sends touch: %s", async (maxTouchPoints, touch) => {
    const page = fakePage("https://example.com/", "", { maxTouchPoints });
    await runScript();
    page.hide();
    await page.settle();

    expect(page.batches.length).toBeGreaterThan(0);
    for (const batch of page.batches) {
      expect(batch.touch).toBe(touch);
    }
  });
});

describe("environment and release", () => {
  test("data-environment and data-release go with every batch", async () => {
    const page = fakePage("https://staging.example.com/", "", {
      attributes: { environment: "staging", release: "web@1.4.2+3f2a9c1" },
    });
    await runScript();
    page.hide();
    await page.settle();

    expect(page.batches.length).toBeGreaterThan(0);
    for (const batch of page.batches) {
      expect(batch).toMatchObject({ environment: "staging", release: "web@1.4.2+3f2a9c1" });
    }
  });

  test("without them, batches name neither: the API counts them as production's", async () => {
    const page = fakePage("https://example.com/");
    await runScript();
    page.hide();
    await page.settle();

    expect(page.batches[0]).not.toHaveProperty("environment");
    expect(page.batches[0]).not.toHaveProperty("release");
  });

  test("an invalid environment sends nothing, rather than mixing into production", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const page = fakePage("https://example.com/", "", {
      attributes: { environment: "my staging" },
    });
    await runScript();
    page.hide();
    await page.settle();

    expect(page.batches).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("data-environment"));
  });

  test("an invalid release is left out, and the events still go", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const page = fakePage("https://example.com/", "", { attributes: { release: "1.4 beta" } });
    await runScript();
    page.hide();
    await page.settle();

    expect(page.events.length).toBeGreaterThan(0);
    expect(page.batches[0]).not.toHaveProperty("release");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("data-release"));
  });
});

describe("the signed-in user", () => {
  test("data-user-id names the user from the first pageview on", async () => {
    const page = fakePage("https://example.com/", "", { attributes: { userId: "user-42" } });
    await runScript();
    page.hide();
    await page.settle();

    expect(page.events.length).toBeGreaterThan(0);
    for (const event of page.events) {
      expect(event.userId).toBe("user-42");
    }
  });

  test("identify() and reset() change the user of the events that follow", async () => {
    const page = fakePage("https://example.com/");
    await runScript();
    page.window.ottertrail?.identify("user-42");
    page.window.ottertrail?.track("signup");
    page.window.ottertrail?.reset();
    page.window.ottertrail?.track("signout");
    page.hide();
    await page.settle();

    const byName = Object.fromEntries(page.events.map((event) => [event.name, event.userId]));
    expect(byName).toMatchObject({ pageview: undefined, signup: "user-42", signout: undefined });
  });

  test("an invalid identify() makes the events anonymous, never the user before", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const page = fakePage("https://example.com/");
    await runScript();
    page.window.ottertrail?.identify("user-a");
    page.window.ottertrail?.track("seen-as-a");
    page.window.ottertrail?.identify("");
    page.window.ottertrail?.track("after-invalid");
    page.hide();
    await page.settle();

    const byName = Object.fromEntries(page.events.map((event) => [event.name, event.userId]));
    expect(byName).toMatchObject({ "seen-as-a": "user-a", "after-invalid": undefined });
  });

  test("a page's engagement report is its viewer's, not the user who signed in after", async () => {
    const page = fakePage("https://example.com/login");
    await runScript();
    await vi.advanceTimersByTimeAsync(5000); // Time on the sign-in page.
    page.window.ottertrail?.identify("user-42");
    page.window.location.href = "https://example.com/dashboard";
    page.window.history.pushState(); // The app moves on, signed in.
    page.hide();
    await page.settle();

    const engagement = page.events.filter((event) => event.name === "engagement");
    const loginTime = engagement.find((event) => event.url === "https://example.com/login");
    expect(loginTime).toBeDefined();
    expect(loginTime?.userId).toBeUndefined();
    const dashboard = page.events.find(
      (event) => event.name === "pageview" && event.url === "https://example.com/dashboard",
    );
    expect(dashboard?.userId).toBe("user-42");
  });

  test("a signature from the page goes with the user ID, and a malformed one is left out", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const signature = "c".repeat(64);
    const page = fakePage("https://example.com/", "", {
      attributes: { userId: "user-42", userSignature: signature },
    });
    await runScript();
    page.window.ottertrail?.identify("user-43", "NOT-HEX");
    page.window.ottertrail?.track("as-43");
    // Upper case and stray spaces are fine: the API compares lower-cased.
    page.window.ottertrail?.identify("user-44", ` ${"AB".repeat(32)} `);
    page.window.ottertrail?.track("as-44");
    page.hide();
    await page.settle();

    const byName = Object.fromEntries(
      page.events.map((event) => [event.name, [event.userId, event.userSignature]]),
    );
    expect(byName).toMatchObject({
      pageview: ["user-42", signature],
      "as-43": ["user-43", undefined],
      "as-44": ["user-44", "AB".repeat(32)],
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("signature"));
  });

  test("an invalid ID is ignored, with a warning, and the events still go", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const page = fakePage("https://example.com/", "", { attributes: { userId: "" } });
    await runScript();
    page.window.ottertrail?.identify("x".repeat(201));
    page.window.ottertrail?.track("signup");
    page.hide();
    await page.settle();

    expect(page.events.length).toBeGreaterThan(0);
    expect(page.events.every((event) => event.userId === undefined)).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("data-user-id"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("identify()"));
  });
});

const STACK =
  "TypeError: Cannot read properties of undefined (reading 'total')\n" +
  "    at render (https://example.com/assets/index-3f2a1c.js:1:2345)\n" +
  "    at main (https://example.com/assets/index-3f2a1c.js:1:99)";

/** An Error with a fixed stack, so tests do not depend on this file's paths. */
const failure = (message: string, stack = STACK, type = "TypeError") => {
  const error = new Error(message);
  error.name = type;
  error.stack = stack;
  return error;
};

/** An uncaught exception, as the browser reports it on window. */
const uncaught = (page: ReturnType<typeof fakePage>, error: unknown, filename = "") => {
  page.fire("error", new FakeErrorEvent({ message: `Uncaught ${String(error)}`, filename, error }));
};

async function errorsSent(page: ReturnType<typeof fakePage>) {
  page.hide();
  await page.settle();
  return page.events.filter((event) => event.name === "error");
}

describe("errors", () => {
  test("an uncaught exception is sent with its type, message and stack, as unhandled", async () => {
    const page = fakePage("https://example.com/checkout");
    await runScript();
    const message = "Cannot read properties of undefined (reading 'total')";
    uncaught(page, failure(message), "https://example.com/assets/index-3f2a1c.js");

    const [error, ...rest] = await errorsSent(page);
    expect(rest).toEqual([]);
    expect(error).toMatchObject({
      url: "https://example.com/checkout",
      error: { type: "TypeError", message, stack: STACK, handled: false },
    });
    expect(error?.id).toEqual(expect.any(String));
    expect(error?.occurredAt).toBe(start);
    expect(error).not.toHaveProperty("properties");
  });

  test("a thrown value that is not an Error is sent with the browser's message", async () => {
    const page = fakePage("https://example.com/");
    await runScript();
    uncaught(page, "out of stock");

    const [error] = await errorsSent(page);
    expect(error?.error).toEqual({
      type: "Error",
      message: "Uncaught out of stock",
      handled: false,
    });
  });

  test("a failed image or script is not an error to report", async () => {
    const page = fakePage("https://example.com/");
    await runScript();
    page.fire("error", { type: "error", target: { tagName: "IMG" } });

    expect(await errorsSent(page)).toEqual([]);
  });

  test("an unhandled rejection is sent: an Error as an Error, other values as text", async () => {
    const page = fakePage("https://example.com/");
    await runScript();
    page.fire("unhandledrejection", { reason: failure("Failed to fetch", STACK, "TypeError") });
    page.fire("unhandledrejection", { reason: "timeout" });
    page.fire("unhandledrejection", { reason: { code: 42, retry: false } });
    page.fire("unhandledrejection", { reason: undefined });

    expect((await errorsSent(page)).map((event) => event.error)).toEqual([
      { type: "TypeError", message: "Failed to fetch", stack: STACK, handled: false },
      { type: "UnhandledRejection", message: "timeout", handled: false },
      { type: "UnhandledRejection", message: '{"code":42,"retry":false}', handled: false },
      { type: "UnhandledRejection", message: "undefined", handled: false },
    ]);
  });

  test("captureError() sends a handled error, with properties cleaned as for track()", async () => {
    const page = fakePage("https://example.com/");
    await runScript();
    page.window.ottertrail?.captureError(failure("card declined", STACK, "PaymentError"), {
      step: "pay",
      nested: { dropped: true },
    });
    page.window.ottertrail?.captureError("plain text");

    const errors = await errorsSent(page);
    expect(errors[0]).toMatchObject({
      properties: { step: "pay" },
      error: { type: "PaymentError", message: "card declined", stack: STACK, handled: true },
    });
    expect(errors[1]?.error).toEqual({ type: "Error", message: "plain text", handled: true });
  });

  test('"Script error." from a cross-origin script is skipped', async () => {
    const page = fakePage("https://example.com/");
    await runScript();
    page.fire("error", new FakeErrorEvent({ message: "Script error." }));

    expect(await errorsSent(page)).toEqual([]);
  });

  test("errors from browser extensions are skipped", async () => {
    const page = fakePage("https://example.com/");
    await runScript();
    uncaught(page, failure("a"), "chrome-extension://abcdef/content.js");
    uncaught(page, failure("b", "Error: b\n    at x (moz-extension://1234/inject.js:1:1)"));
    uncaught(page, failure("c", "Error: c\n    at safari-extension://com.x/s.js:2:3"));
    uncaught(page, failure("d", "run@safari-web-extension://id/main.js:4:5\n@https://x/y.js:1:1"));
    // The first frame is the site's own code: the extension only called it.
    uncaught(
      page,
      failure(
        "e",
        "Error: e\n    at f (https://example.com/a.js:1:1)\n    at chrome-extension://abc/b.js:1:1",
      ),
    );

    expect((await errorsSent(page)).map((event) => event.error?.message)).toEqual(["e"]);
  });

  test("an error repeats at most once per page load, and 25 go in all", async () => {
    const page = fakePage("https://example.com/");
    await runScript();
    for (let i = 0; i < 3; i += 1) uncaught(page, failure("same"));
    // A new path in the app is not a new page load.
    page.window.location.href = "https://example.com/next";
    page.window.history.pushState();
    uncaught(page, failure("same"));
    page.window.ottertrail?.captureError(failure("same")); // Same type, message and stack.
    for (let i = 0; i < 30; i += 1) uncaught(page, failure(`error ${i}`));

    const errors = await errorsSent(page);
    expect(errors).toHaveLength(25);
    expect(errors.filter((event) => event.error?.message === "same")).toHaveLength(1);
    expect(errors.at(-1)?.error?.message).toBe("error 23");
  });

  test('data-errors="off" stops automatic capture; captureError() still works', async () => {
    const page = fakePage("https://example.com/", "", { attributes: { errors: "off" } });
    await runScript();
    uncaught(page, failure("uncaught"));
    page.fire("unhandledrejection", { reason: failure("rejected") });
    page.window.ottertrail?.captureError(failure("handled"));

    expect((await errorsSent(page)).map((event) => event.error?.message)).toEqual(["handled"]);
  });

  test("long text is cut to the API's limits and cleaned of what it refuses", async () => {
    const page = fakePage("https://example.com/");
    await runScript();
    // \u0085 is a C1 control character; \uD800 and \uDC00 are halves of no pair.
    const dirty = "a\u0000b\u0007c\u0085d\uD800e\uDC00f\r\n\tg";
    const error = failure(`${dirty}${"m".repeat(1997)}😀`, "s".repeat(20_000));
    error.name = `Type\n\u0085${"T".repeat(300)}`;
    uncaught(page, error);
    const unnamed = failure("x", "");
    unnamed.name = "\u0000";
    page.window.ottertrail?.captureError(unnamed);

    const [cut, fallback] = await errorsSent(page);
    expect(cut?.error?.type).toBe(`Type${"T".repeat(196)}`);
    expect(cut?.error?.message).toBe(`abcdef\n\tg${"m".repeat(1991)}`);
    expect(cut?.error?.stack).toHaveLength(16_000);
    // An Error without a usable name is an "Error"; an empty stack is left out.
    expect(fallback?.error).toEqual({ type: "Error", message: "x", handled: true });
  });

  test("a surrogate pair is never split where text is cut", async () => {
    const page = fakePage("https://example.com/");
    await runScript();
    page.window.ottertrail?.captureError(failure(`${"m".repeat(1999)}😀`));

    const [error] = await errorsSent(page);
    expect(error?.error?.message).toBe("m".repeat(1999));
  });

  test("an error goes with the signed-in user, as a custom event would", async () => {
    const signature = "c".repeat(64);
    const page = fakePage("https://example.com/");
    await runScript();
    page.window.ottertrail?.identify("user-42", signature);
    uncaught(page, failure("boom"));

    const [error] = await errorsSent(page);
    expect(error).toMatchObject({ userId: "user-42", userSignature: signature });
  });

  test('track("error") warns and sends nothing: the name is reserved', async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const page = fakePage("https://example.com/");
    await runScript();
    page.window.ottertrail?.track("error", { message: "fake" });

    expect(await errorsSent(page)).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"error" is reserved'));
  });

  test("an error inside error capture is swallowed, never thrown back", async () => {
    const page = fakePage("https://example.com/");
    await runScript();
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("trap");
        },
      },
    );
    expect(() => page.window.ottertrail?.captureError(hostile)).not.toThrow();
    expect(() => page.fire("unhandledrejection", { reason: hostile })).not.toThrow();
    expect(await errorsSent(page)).toEqual([]);
  });
});

/** The function v.js calls, from the script the tracker added. */
const recorder = (page: ReturnType<typeof fakePage>) => {
  const script = page.added.find((element) => element.tagName === "script");
  return script?.[RECORD_PROPERTY] as (name: string, value: number) => void;
};

describe("Web Vitals", () => {
  test("loads v.js from beside the tracker, with its nonce, unless turned off or pinned", async () => {
    const page = fakePage("https://example.com/", "", {
      src: "https://analytics.example.com/t.js?v=2",
      nonce: "abc123",
    });
    await runScript();
    expect(page.added).toMatchObject([
      {
        tagName: "script",
        src: "https://analytics.example.com/v.js",
        async: true,
        nonce: "abc123",
      },
    ]);
    expect(typeof recorder(page)).toBe("function");

    const off = fakePage("https://example.com/", "", { attributes: { vitals: "off" } });
    await runScript();
    expect(off.added).toEqual([]);

    // A site that pins the tracker with integrity could not pin v.js.
    const pinned = fakePage("https://example.com/");
    Object.assign(pinned.document.currentScript, {
      hasAttribute: (name: string) => name === "integrity",
    });
    await runScript();
    expect(pinned.added).toEqual([]);
  });

  test("sends the landing page's latest values once, when the page is first hidden", async () => {
    const page = fakePage("https://example.com/pricing");
    await runScript();
    const record = recorder(page);
    record("LCP", 2_000.4);
    record("LCP", 2_345.6); // A later, larger paint replaces the first.
    record("CLS", 0.123_456);
    record("INP", 88);
    record("TTFB", -1); // Nonsense is left out.
    await vi.advanceTimersByTimeAsync(3000);
    page.hide();
    await page.settle();

    page.show();
    record("INP", 400); // After they were sent: not sent again.
    await vi.advanceTimersByTimeAsync(3000);
    page.hide();
    await page.settle();

    const sent = page.events.filter((event) => event.name === "vitals");
    expect(sent).toMatchObject([
      {
        url: "https://example.com/pricing",
        properties: { lcp: 2346, cls: 0.1235, inp: 88 },
      },
    ]);
    // Time on page goes on as before, without them.
    const reports = page.events.filter((event) => event.name === "engagement");
    expect(reports.map((event) => event.properties)).toEqual([
      { engagedMs: 3000 },
      { engagedMs: 3000 },
    ]);
  });

  test("an in-app navigation or an early redirect keeps them for the landing page", async () => {
    const page = fakePage("https://example.com/");
    await runScript();
    const record = recorder(page);
    // The app redirects at once, then the visitor clicks on.
    page.window.location.href = "https://example.com/en/";
    page.window.history.pushState();
    record("LCP", 1200);
    page.window.location.href = "https://example.com/en/pricing";
    page.window.history.pushState();
    record("INP", 140); // The click that navigated, counted after it.
    await vi.advanceTimersByTimeAsync(2000);
    page.hide();
    await page.settle();

    expect(page.events.filter((event) => event.name === "vitals")).toMatchObject([
      { url: "https://example.com/", properties: { lcp: 1200, inp: 140 } },
    ]);
  });

  test("goes with whoever was signed in when the page loaded", async () => {
    const page = fakePage("https://example.com/", "", { attributes: { userId: "ada" } });
    await runScript();
    recorder(page)("LCP", 900);
    page.window.ottertrail?.reset();
    page.hide();
    await page.settle();
    expect(page.events.find((event) => event.name === "vitals")?.userId).toBe("ada");
  });

  test("waits for values: none yet when hidden, sent the next time", async () => {
    const page = fakePage("https://example.com/");
    await runScript();
    page.hide(); // v.js has not reported anything yet.
    page.show();
    recorder(page)("LCP", 700);
    page.hide();
    await page.settle();
    expect(page.events.filter((event) => event.name === "vitals")).toMatchObject([
      { properties: { lcp: 700 } },
    ]);
  });

  test("leaving the page sends them on the visibilitychange after pagehide, with its last values", async () => {
    const page = fakePage("https://example.com/");
    await runScript();
    const record = recorder(page);
    record("INP", 120);
    // Leaving: pagehide first, while still visible; the library then takes
    // its last values when the page turns hidden.
    page.fire("pagehide");
    record("INP", 350);
    page.hide();
    await page.settle();
    expect(page.events.filter((event) => event.name === "vitals")).toMatchObject([
      { properties: { inp: 350 } },
    ]);
  });

  test("a pagehide after the page was hidden sends them, for browsers without that visibilitychange", async () => {
    const page = fakePage("https://example.com/");
    await runScript();
    page.document.visibilityState = "hidden"; // Hidden, but no event fired.
    recorder(page)("LCP", 500);
    page.fire("pagehide");
    await page.settle();
    expect(page.events.filter((event) => event.name === "vitals")).toMatchObject([
      { properties: { lcp: 500 } },
    ]);
  });

  test("a page restored from the back/forward cache sends its own, first ones included", async () => {
    const page = fakePage("https://example.com/");
    await runScript();
    const record = recorder(page);
    record("LCP", 1500);
    page.hide();
    // The library reports a restored page's first values in its own pageshow
    // listener, before the tracker's: they must count for the new load.
    page.fire("pageshow", { persisted: true });
    record("TTFB", 0);
    page.show();
    record("LCP", 40);
    page.hide();
    await page.settle();
    expect(page.events.filter((event) => event.name === "vitals").map((e) => e.properties)).toEqual(
      [{ lcp: 1500 }, { ttfb: 0, lcp: 40 }],
    );
  });

  test("a page cannot send vitals itself", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const page = fakePage("https://example.com/");
    await runScript();
    page.window.ottertrail?.track("vitals", { lcp: 1 });
    page.hide();
    await page.settle();
    expect(page.events.filter((event) => event.name === "vitals")).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"vitals" is reserved'));
  });
});

/** The configuration r.js reads, from the script the tracker added for it. */
const replayConfig = (page: ReturnType<typeof fakePage>) => {
  const script = page.added.find((element) => String(element.src).endsWith("/r.js"));
  return script?.[REPLAY_PROPERTY] as ReplayConfig | undefined;
};

/** A stand-in for r.js's recorder, giving each error this replay ID. */
const fakeRecorder = (replayId: string | undefined) => ({
  error: vi.fn<Recorder["error"]>(() => replayId),
  stop: vi.fn<Recorder["stop"]>(),
  again: vi.fn<Recorder["again"]>(),
});

describe("session replay", () => {
  test('loads r.js beside the tracker, with its nonce, only with data-replay="errors"', async () => {
    const page = fakePage("https://example.com/", "", {
      src: "https://analytics.example.com/t.js?v=2",
      nonce: "abc123",
      attributes: { replay: "errors", replayText: "show" },
    });
    await runScript();
    expect(page.added).toMatchObject([
      { tagName: "script", src: "https://analytics.example.com/v.js" },
      {
        tagName: "script",
        src: "https://analytics.example.com/r.js",
        async: true,
        nonce: "abc123",
      },
    ]);
    expect(replayConfig(page)).toMatchObject({
      endpoint: "https://analytics.example.com/api/replays",
      key: "pk_test",
      text: true,
      media: false,
    });

    const media = fakePage("https://example.com/", "", {
      attributes: { replay: "errors", replayMedia: "show", vitals: "off" },
    });
    await runScript();
    expect(media.added.map((element) => element.src)).toEqual([
      "https://analytics.example.com/r.js",
    ]);
    expect(replayConfig(media)).toMatchObject({ text: false, media: true });

    const without: Record<string, string>[] = [{}, { replay: "all" }, { replay: "" }];
    for (const attributes of without) {
      const other = fakePage("https://example.com/", "", { attributes });
      await runScript();
      expect(replayConfig(other)).toBeUndefined();
    }
  });

  test("never with an integrity attribute: r.js could not be pinned with it", async () => {
    const pinned = fakePage("https://example.com/", "", { attributes: { replay: "errors" } });
    Object.assign(pinned.document.currentScript, {
      hasAttribute: (name: string) => name === "integrity",
    });
    await runScript();
    expect(pinned.added).toEqual([]);
  });

  test("an error event carries the replay ID the recorder gives it", async () => {
    const page = fakePage("https://example.com/checkout", "", { attributes: { replay: "errors" } });
    await runScript();
    const replay = fakeRecorder("8a1c4d2e-0f3b-4c5d-9e6f-7a8b9c0d1e2f");
    replayConfig(page)?.register(replay);
    uncaught(page, failure("boom"));
    page.window.ottertrail?.captureError(failure("caught", STACK, "PaymentError"));
    page.fire("unhandledrejection", { reason: failure("rejected") });

    const errors = await errorsSent(page);
    expect(replay.error).toHaveBeenCalledTimes(3);
    expect(errors.map((event) => event.error)).toEqual([
      expect.objectContaining({
        message: "boom",
        handled: false,
        replayId: "8a1c4d2e-0f3b-4c5d-9e6f-7a8b9c0d1e2f",
      }),
      expect.objectContaining({
        message: "caught",
        handled: true,
        replayId: "8a1c4d2e-0f3b-4c5d-9e6f-7a8b9c0d1e2f",
      }),
      expect.objectContaining({
        message: "rejected",
        replayId: "8a1c4d2e-0f3b-4c5d-9e6f-7a8b9c0d1e2f",
      }),
    ]);
  });

  test("captureError still starts a replay when automatic capture is off", async () => {
    const page = fakePage("https://example.com/", "", {
      attributes: { replay: "errors", errors: "off" },
    });
    await runScript();
    const replay = fakeRecorder("8a1c4d2e-0f3b-4c5d-9e6f-7a8b9c0d1e2f");
    replayConfig(page)?.register(replay);
    uncaught(page, failure("ignored")); // Not captured: data-errors="off".
    page.window.ottertrail?.captureError(failure("caught"));
    const errors = await errorsSent(page);
    expect(replay.error).toHaveBeenCalledTimes(1);
    expect(errors.map((event) => event.error?.replayId)).toEqual([
      "8a1c4d2e-0f3b-4c5d-9e6f-7a8b9c0d1e2f",
    ]);
  });

  test("without a replay, the error has no replay ID", async () => {
    const page = fakePage("https://example.com/", "", { attributes: { replay: "errors" } });
    await runScript();
    uncaught(page, failure("before r.js ran"));
    replayConfig(page)?.register(fakeRecorder(undefined));
    uncaught(page, failure("after the replay was sent"));
    const errors = await errorsSent(page);
    expect(errors).toHaveLength(2);
    for (const event of errors) expect(event.error).not.toHaveProperty("replayId");
  });

  test("replay(false) stops the recorder, also one that starts later", async () => {
    const page = fakePage("https://example.com/", "", { attributes: { replay: "errors" } });
    await runScript();
    const running = fakeRecorder("x");
    replayConfig(page)?.register(running);
    page.window.ottertrail?.replay(true); // Does nothing.
    expect(running.stop).not.toHaveBeenCalled();
    page.window.ottertrail?.replay(false);
    expect(running.stop).toHaveBeenCalledTimes(1);

    const early = fakePage("https://example.com/", "", { attributes: { replay: "errors" } });
    await runScript();
    early.window.ottertrail?.replay(false); // Before r.js has run.
    const late = fakeRecorder("x");
    replayConfig(early)?.register(late);
    expect(late.stop).toHaveBeenCalledTimes(1);
  });
});

/** The r.js scripts the tracker added to the page. */
const recorders = (page: ReturnType<typeof fakePage>) =>
  page.added.filter((element) => String(element.src).endsWith("/r.js"));

const WAIT = { replay: "errors", replayConsent: "wait", vitals: "off" };

interface StandIn {
  q: unknown[];
  replay(on: unknown): void;
  track(name: string, properties?: object): void;
  identify(userId: string): void;
  reset(): void;
  captureError(error: unknown): void;
}

/** The documented stand-in, run as the site's script before the tracker's tag. */
const standIn = (page: ReturnType<typeof fakePage>) => {
  // eslint-disable-next-line typescript/no-implied-eval, no-new-func -- the snippet as sites paste it
  new Function("window", STAND_IN)(page.window);
  return page.window.ottertrail as unknown as StandIn;
};

describe("session replay after consent", () => {
  test('with data-replay-consent="wait", r.js waits for replay(true); the rest runs as usual', async () => {
    const page = fakePage("https://example.com/", "", {
      attributes: { ...WAIT, replayText: "show", replayMedia: "show", vitals: "on" },
    });
    await runScript();
    // Web Vitals load, pageviews and errors are sent: only the recorder waits.
    expect(page.added.map((element) => element.src)).toEqual([
      "https://analytics.example.com/v.js",
    ]);
    uncaught(page, failure("before consent"));
    const errors = await errorsSent(page);
    expect(errors.map((event) => event.error)).toEqual([
      expect.not.objectContaining({ replayId: expect.anything() }),
    ]);
    expect(page.events[0]).toMatchObject({ name: "pageview" });

    page.window.ottertrail?.replay(true);
    expect(recorders(page)).toHaveLength(1);
    // The snippet's privacy settings, as without waiting.
    expect(replayConfig(page)).toMatchObject({
      endpoint: "https://analytics.example.com/api/replays",
      key: "pk_test",
      text: true,
      media: true,
    });
    const replay = fakeRecorder("8a1c4d2e-0f3b-4c5d-9e6f-7a8b9c0d1e2f");
    replayConfig(page)?.register(replay);
    expect(replay.stop).not.toHaveBeenCalled();
    uncaught(page, failure("after consent"));
    const later = await errorsSent(page);
    expect(later.at(-1)?.error?.replayId).toBe("8a1c4d2e-0f3b-4c5d-9e6f-7a8b9c0d1e2f");
  });

  test("other values of data-replay-consent do not wait", async () => {
    const page = fakePage("https://example.com/", "", {
      attributes: { ...WAIT, replayConsent: "yes" },
    });
    await runScript();
    expect(recorders(page)).toHaveLength(1);
  });

  test("replay(true) without data-replay records nothing and warns once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const tags: Record<string, string>[] = [{}, { replayConsent: "wait" }, { replay: "all" }];
    for (const attributes of tags) {
      warn.mockClear();
      const page = fakePage("https://example.com/", "", { attributes });
      await runScript();
      page.window.ottertrail?.replay(true);
      page.window.ottertrail?.replay(true);
      expect(recorders(page)).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('needs data-replay="errors"'));
      page.window.ottertrail?.replay(false); // Never a warning.
      expect(warn).toHaveBeenCalledTimes(1);
    }
  });

  test("replay(true) twice is harmless", async () => {
    const page = fakePage("https://example.com/", "", { attributes: WAIT });
    await runScript();
    page.window.ottertrail?.replay(true);
    page.window.ottertrail?.replay(true);
    expect(recorders(page)).toHaveLength(1);
    const replay = fakeRecorder("x");
    replayConfig(page)?.register(replay);
    page.window.ottertrail?.replay(true);
    expect(recorders(page)).toHaveLength(1);
    expect(replay.stop).not.toHaveBeenCalled();
    expect(replay.again).not.toHaveBeenCalled();
  });

  test("replay(false) before replay(true) cancels the start: r.js is never requested", async () => {
    const page = fakePage("https://example.com/", "", { attributes: WAIT });
    await runScript();
    page.window.ottertrail?.replay(false);
    expect(recorders(page)).toEqual([]);
  });

  test("replay(false) after replay(true) stops the recorder, running or still loading", async () => {
    const running = fakePage("https://example.com/", "", { attributes: WAIT });
    await runScript();
    running.window.ottertrail?.replay(true);
    const replay = fakeRecorder("x");
    replayConfig(running)?.register(replay);
    running.window.ottertrail?.replay(false);
    expect(replay.stop).toHaveBeenCalledTimes(1);

    const loading = fakePage("https://example.com/", "", { attributes: WAIT });
    await runScript();
    loading.window.ottertrail?.replay(true);
    loading.window.ottertrail?.replay(false); // Before r.js has run.
    const late = fakeRecorder("x");
    replayConfig(loading)?.register(late);
    expect(late.stop).toHaveBeenCalledTimes(1);
  });

  test("replay(true) after replay(false) starts a new recording: the last call wins", async () => {
    // Declined, then agreed: r.js loads only then.
    const declined = fakePage("https://example.com/", "", { attributes: WAIT });
    await runScript();
    declined.window.ottertrail?.replay(false);
    declined.window.ottertrail?.replay(true);
    expect(recorders(declined)).toHaveLength(1);
    const first = fakeRecorder("first");
    replayConfig(declined)?.register(first);
    expect(first.stop).not.toHaveBeenCalled();

    // Agreed, withdrew, agreed again: the stopped recorder starts a new one.
    declined.window.ottertrail?.replay(false);
    expect(first.stop).toHaveBeenCalledTimes(1);
    declined.window.ottertrail?.replay(true);
    expect(first.again).toHaveBeenCalledTimes(1);
    expect(recorders(declined)).toHaveLength(1); // r.js is not loaded again.
    const second = fakeRecorder("second");
    replayConfig(declined)?.register(second); // As r.js registers the new one.
    expect(second.stop).not.toHaveBeenCalled();
    uncaught(declined, failure("boom"));
    const errors = await errorsSent(declined);
    expect(errors.at(-1)?.error?.replayId).toBe("second");
    expect(first.error).not.toHaveBeenCalled();

    // While r.js is still loading, false then true leaves it recording.
    const loading = fakePage("https://example.com/", "", { attributes: WAIT });
    await runScript();
    loading.window.ottertrail?.replay(true);
    loading.window.ottertrail?.replay(false);
    loading.window.ottertrail?.replay(true);
    expect(recorders(loading)).toHaveLength(1);
    const kept = fakeRecorder("x");
    replayConfig(loading)?.register(kept);
    expect(kept.stop).not.toHaveBeenCalled();
    expect(kept.again).not.toHaveBeenCalled();
  });

  test("without data-replay-consent, replay(false) then replay(true) records again too", async () => {
    const page = fakePage("https://example.com/", "", { attributes: { replay: "errors" } });
    await runScript();
    const replay = fakeRecorder("x");
    replayConfig(page)?.register(replay);
    page.window.ottertrail?.replay(false);
    page.window.ottertrail?.replay(true);
    expect(replay.stop).toHaveBeenCalledTimes(1);
    expect(replay.again).toHaveBeenCalledTimes(1);
  });

  test("calls queued before the tracker ran are made once it runs, the last one only", async () => {
    const agreed = fakePage("https://example.com/", "", { attributes: WAIT });
    standIn(agreed).replay(true);
    await runScript();
    expect(recorders(agreed)).toHaveLength(1);
    // The stand-in is replaced: later calls reach the tracker.
    agreed.window.ottertrail?.replay(false);
    const replay = fakeRecorder("x");
    replayConfig(agreed)?.register(replay);
    expect(replay.stop).toHaveBeenCalledTimes(1);

    // Agreed, then declined, before the tracker ran: r.js is never requested.
    const changed = fakePage("https://example.com/", "", { attributes: WAIT });
    const early = standIn(changed);
    early.replay(true);
    early.replay(false);
    await runScript();
    expect(recorders(changed)).toEqual([]);

    // Without waiting, a queued false stops the recorder as it registers.
    const declined = fakePage("https://example.com/", "", { attributes: { replay: "errors" } });
    standIn(declined).replay(false);
    await runScript();
    const stopped = fakeRecorder("x");
    replayConfig(declined)?.register(stopped);
    expect(stopped.stop).toHaveBeenCalledTimes(1);

    // The last entry counts as the API takes it: only true starts.
    const denied = fakePage("https://example.com/", "", { attributes: WAIT });
    const queue = standIn(denied);
    queue.replay(true);
    queue.replay("denied");
    await runScript();
    expect(recorders(denied)).toEqual([]);
  });

  test("before the tracker runs, the stand-in's other calls do nothing, and never throw", async () => {
    const page = fakePage("https://example.com/", "", { attributes: WAIT });
    const early = standIn(page);
    expect(() => {
      page.window.ottertrail?.track("signup", { plan: "free" });
      page.window.ottertrail?.identify("42");
      page.window.ottertrail?.reset();
      page.window.ottertrail?.captureError(new Error("caught"));
    }).not.toThrow();
    expect(early.q).toEqual([]);
    await runScript();
    page.hide();
    await page.settle();
    // None of them was queued: only the pageview went.
    expect(page.events.map((event) => event.name)).toEqual(["pageview"]);
  });

  test("a reference kept to the stand-in reaches the tracker once it runs", async () => {
    const page = fakePage("https://example.com/", "", { attributes: WAIT });
    const kept = standIn(page);
    kept.replay(true);
    await runScript();
    expect(page.window.ottertrail).not.toBe(kept);
    const replay = fakeRecorder("x");
    replayConfig(page)?.register(replay);
    kept.replay(false);
    expect(replay.stop).toHaveBeenCalledTimes(1);
    kept.track("signup");
    page.hide();
    await page.settle();
    expect(page.events.map((event) => event.name)).toContain("signup");
  });

  test("a tracker on the page twice: the second warns and does nothing, so replay(false) reaches the recorder", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const page = fakePage("https://example.com/", "", { attributes: WAIT });
    standIn(page).replay(true);
    await runScript(); // In the template.
    const api = page.window.ottertrail;
    await runScript(); // And in a tag manager.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("on this page twice"));
    expect(page.window.ottertrail).toBe(api);
    expect(recorders(page)).toHaveLength(1);
    const replay = fakeRecorder("x");
    replayConfig(page)?.register(replay);
    page.window.ottertrail?.replay(false);
    expect(replay.stop).toHaveBeenCalledTimes(1);
    page.hide();
    await page.settle();
    expect(page.events.filter((event) => event.name === "pageview")).toHaveLength(1);
  });

  test("replay(true) on a tag pinned with integrity warns once and records nothing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const page = fakePage("https://example.com/", "", { attributes: WAIT });
    Object.assign(page.document.currentScript, {
      hasAttribute: (name: string) => name === "integrity",
    });
    await runScript();
    page.window.ottertrail?.replay(true);
    page.window.ottertrail?.replay(true);
    expect(page.added).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("integrity"));
  });

  test("an older r.js without again() fails quietly, with one warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const page = fakePage("https://example.com/", "", { attributes: WAIT });
    await runScript();
    page.window.ottertrail?.replay(true);
    const old = {
      error: vi.fn<Recorder["error"]>(() => undefined),
      stop: vi.fn<Recorder["stop"]>(),
    };
    replayConfig(page)?.register(old as unknown as Recorder);
    page.window.ottertrail?.replay(false);
    expect(() => {
      page.window.ottertrail?.replay(true);
      page.window.ottertrail?.replay(false);
      page.window.ottertrail?.replay(true);
    }).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("could not be changed"));
  });

  test("nothing is written to cookies or storage", async () => {
    const page = fakePage("https://example.com/", "", { attributes: WAIT });
    const writes: string[] = [];
    Object.defineProperty(page.document, "cookie", {
      get: () => "",
      set: (value: string) => {
        writes.push(`cookie ${value}`);
      },
    });
    const storage = (name: string) => ({
      length: 0,
      getItem: () => null,
      key: () => null,
      setItem: (key: string) => writes.push(`${name} ${key}`),
      removeItem: (key: string) => writes.push(`${name} remove ${key}`),
      clear: () => writes.push(`${name} clear`),
    });
    vi.stubGlobal("localStorage", storage("localStorage"));
    vi.stubGlobal("sessionStorage", storage("sessionStorage"));
    Object.assign(page.window, {
      localStorage: storage("localStorage"),
      sessionStorage: storage("sessionStorage"),
    });
    await runScript();
    page.window.ottertrail?.replay(true);
    replayConfig(page)?.register(fakeRecorder("x"));
    page.window.ottertrail?.replay(false);
    page.window.ottertrail?.replay(true);
    page.hide();
    await page.settle();
    expect(writes).toEqual([]);
  });
});

/** The configuration h.js reads, from the script the tracker added for it. */
const heatmapConfig = (page: ReturnType<typeof fakePage>) => {
  const script = page.added.find((element) => String(element.src).endsWith("/h.js"));
  return script?.[HEATMAP_PROPERTY] as HeatmapConfig | undefined;
};

describe("heatmaps", () => {
  test('loads h.js beside the tracker, with its nonce, only with data-heatmaps="on"', async () => {
    const page = fakePage("https://example.com/pricing?utm_source=x&token=secret", "", {
      nonce: "abc123",
      attributes: { heatmaps: "on", vitals: "off", environment: "staging", release: "1.4.2" },
    });
    await runScript();
    expect(page.added).toMatchObject([
      { src: "https://analytics.example.com/h.js", async: true, nonce: "abc123" },
    ]);
    expect(heatmapConfig(page)).toMatchObject({
      endpoint: "https://analytics.example.com/api/heatmaps",
      key: "pk_test",
      environment: "staging",
      release: "1.4.2",
    });
    // The pageview as pageviews send it: cleaned of all but its UTM tags.
    expect(heatmapConfig(page)?.page()).toEqual({
      url: "https://example.com/pricing?utm_source=x",
      referrer: undefined,
      at: start,
    });

    const others: Record<string, string>[] = [{}, { heatmaps: "yes" }, { heatmaps: "" }];
    for (const attributes of others) {
      const other = fakePage("https://example.com/", "", {
        attributes: { vitals: "off", ...attributes },
      });
      await runScript();
      expect(other.added).toEqual([]);
    }
  });

  test("never with an integrity attribute: h.js could not be pinned with it, and it says so once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const pinned = fakePage("https://example.com/", "", {
      attributes: { heatmaps: "on", vitals: "off" },
    });
    Object.assign(pinned.document.currentScript, {
      hasAttribute: (name: string) => name === "integrity",
    });
    await runScript();
    pinned.window.location.href = "https://example.com/next";
    pinned.window.history.pushState();
    expect(pinned.added).toEqual([]);
    const said = warn.mock.calls.filter(([message]) => String(message).includes("data-heatmaps"));
    expect(said).toHaveLength(1);
    expect(String(said[0]?.[0])).toContain("integrity");
  });

  test("an empty data-heatmaps-sample warns and samples every pageview", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(Math, "random").mockReturnValue(0.99);
    const page = fakePage("https://example.com/", "", {
      attributes: { heatmaps: "on", heatmapsSample: "", vitals: "off" },
    });
    await runScript();
    expect(heatmapConfig(page)?.page()).not.toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("data-heatmaps-sample"));
  });

  test("samples each pageview on its own, as data-heatmaps-sample says, and tells h.js of each", async () => {
    const random = vi.spyOn(Math, "random").mockReturnValue(0.5);
    const page = fakePage("https://example.com/", "", {
      attributes: { heatmaps: "on", heatmapsSample: "0.25", vitals: "off" },
    });
    await runScript();
    // Outside the sample: h.js is not even loaded.
    expect(page.added).toEqual([]);

    random.mockReturnValue(0.1);
    vi.setSystemTime(start + 1000);
    page.window.location.href = "https://example.com/pricing";
    page.window.history.pushState();
    const config = heatmapConfig(page);
    expect(config?.page()).toMatchObject({ url: "https://example.com/pricing", at: start + 1000 });
    const navigated = vi.fn<() => void>();
    config?.register({ navigated });

    random.mockReturnValue(0.9);
    page.window.location.href = "https://example.com/about";
    page.window.history.pushState();
    expect(config?.page()).toBeNull();
    expect(navigated).toHaveBeenCalledTimes(1);
    // A change of the query string only is the same pageview.
    page.window.location.href = "https://example.com/about?tab=2";
    page.window.history.pushState();
    expect(navigated).toHaveBeenCalledTimes(1);
    // Loaded once.
    expect(page.added).toHaveLength(1);
  });

  test("a pageview whose URL is too long to send has no heatmap page", async () => {
    const page = fakePage(`https://example.com/${"a".repeat(2048)}`, "", {
      attributes: { heatmaps: "on", vitals: "off" },
    });
    await runScript();
    // h.js is not even loaded for it.
    expect(page.added).toEqual([]);
    page.window.location.href = "https://example.com/next";
    page.window.history.pushState();
    expect(heatmapConfig(page)?.page()).toMatchObject({ url: "https://example.com/next" });
  });

  test("a sample outside 0 to 1 warns and samples every pageview", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(Math, "random").mockReturnValue(0.99);
    const page = fakePage("https://example.com/", "", {
      attributes: { heatmaps: "on", heatmapsSample: "25%", vitals: "off" },
    });
    await runScript();
    expect(heatmapConfig(page)?.page()).not.toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("data-heatmaps-sample"));
  });
});

describe("the heatmap overlay", () => {
  const TOKEN = "Ab-_0123456789abcdefghijklmnopqrstuvwxyzABC";

  test("a link's fragment leaves the address, nothing at all is sent, and o.js is loaded with the nonce", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const page = fakePage(`https://example.com/pricing?plan=team#ottertrail-heatmap=${TOKEN}`, "", {
      nonce: "abc123",
      attributes: {
        heatmaps: "on",
        replay: "errors",
        environment: "staging",
      },
    });
    await runScript();
    // The rest of the address stays.
    expect(page.window.location.href).toBe("https://example.com/pricing?plan=team");
    // Only o.js: no v.js, r.js, or h.js.
    expect(page.added).toEqual([
      expect.objectContaining({
        src: "https://analytics.example.com/o.js",
        async: true,
        nonce: "abc123",
      }),
    ]);
    const config = page.added[0]?.[OVERLAY_PROPERTY] as OverlayConfig;
    expect(config).toEqual({
      host: "https://analytics.example.com",
      token: TOKEN,
      environment: "staging",
    });
    // Whatever the page does, and however it is left, nothing is sent.
    page.window.ottertrail?.track("signup", { plan: "team" });
    page.window.ottertrail?.captureError(new Error("boom"));
    page.window.ottertrail?.identify("42");
    page.window.ottertrail?.replay(true);
    page.fire("error", new FakeErrorEvent({ message: "boom", error: new Error("boom") }));
    page.window.location.href = "https://example.com/next";
    page.window.history.pushState();
    await vi.advanceTimersByTimeAsync(60_000);
    page.hide();
    page.fire("pagehide");
    await page.settle();
    expect(page.events).toEqual([]);
    expect(page.batches).toEqual([]);
    expect(page.added).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
  });

  test("a second copy of the tracker on the page does nothing either", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const page = fakePage(`https://example.com/#ottertrail-heatmap=${TOKEN}`, "", {
      attributes: { vitals: "off" },
    });
    await runScript();
    expect(page.window.location.href).toBe("https://example.com/");
    await runScript();
    await vi.advanceTimersByTimeAsync(10_000);
    page.hide();
    await page.settle();
    expect(page.events).toEqual([]);
    expect(page.added).toHaveLength(1);
  });

  test("with an integrity attribute, o.js cannot load: it says so, and still sends nothing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const page = fakePage(`https://example.com/#ottertrail-heatmap=${TOKEN}`, "", {
      attributes: { vitals: "off" },
    });
    Object.assign(page.document.currentScript, {
      hasAttribute: (name: string) => name === "integrity",
    });
    await runScript();
    expect(page.window.location.href).toBe("https://example.com/");
    expect(page.added).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("integrity"));
    page.hide();
    await page.settle();
    expect(page.events).toEqual([]);
  });

  test("other fragments are the page's own: counted as usual, and kept", async () => {
    for (const fragment of [
      "#pricing",
      "#ottertrail-heatmap=short",
      `#ottertrail-heatmap=${TOKEN}&more`,
      `#x-ottertrail-heatmap=${TOKEN}`,
    ]) {
      const page = fakePage(`https://example.com/${fragment}`, "", {
        attributes: { vitals: "off" },
      });
      await runScript();
      expect(page.window.location.href).toBe(`https://example.com/${fragment}`);
      expect(page.added).toEqual([]);
      page.hide();
      await page.settle();
      expect(page.events.map((event) => event.name)).toContain("pageview");
    }
  });
});
