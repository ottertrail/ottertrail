import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import { ENGAGEMENT, MAX_ENGAGED_MS } from "../src/engagement.ts";
import { HEATMAP_PROPERTY, type HeatmapCapture, type HeatmapConfig } from "../src/heatmap-names.ts";
import { type OverlayConfig, type OverlayHandoff, OVERLAY_PROPERTY } from "../src/overlay-names.ts";
import { type Recorder, REPLAY_PROPERTY, type ReplayConfig } from "../src/replay-names.ts";
import { startRequestTracing } from "../src/request-tracing.ts";
import { TRACES_PROPERTY, type TracesConfig } from "../src/traces.ts";
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

/**
 * Stands in for an element clicked inside a link: closest("a[href]") finds
 * the link, given as its href and attributes, or none; and
 * closest("[data-ottertrail-event]") the element marked with an event, given
 * as its attributes, or none.
 */
class FakeElement {
  link: { href: unknown; attributes?: string[] } | undefined;
  marked: Record<string, string> | undefined;
  constructor(link?: { href: unknown; attributes?: string[] }, marked?: Record<string, string>) {
    this.link = link;
    this.marked = marked;
  }
  closest(selector: string) {
    if (selector === "[data-ottertrail-event]" && this.marked !== undefined) {
      const marked = this.marked;
      return {
        attributes: Object.entries(marked).map(([name, value]) => ({ name, value })),
        getAttribute: (name: string) => marked[name] ?? null,
      };
    }
    if (selector !== "a[href]" || this.link === undefined) return null;
    const { href, attributes = [] } = this.link;
    return { href, hasAttribute: (name: string) => attributes.includes(name) };
  }
}

/** Just enough of a browser page to run src/script.ts as a <script> tag would. */
function fakePage(
  href: string,
  referrer = "",
  {
    maxTouchPoints = 0,
    attributes = {},
    src = "https://ottertrail.example.com/t.js",
    nonce = "",
    storage = {},
  }: {
    maxTouchPoints?: number;
    attributes?: Record<string, string>;
    src?: string;
    nonce?: string;
    /** The site's localStorage, or null for storage that throws when read. */
    storage?: Record<string, string> | null;
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
    get hostname() {
      return new URL(this.href).hostname;
    },
    get origin() {
      return new URL(this.href).origin;
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
      dataset: { key: "pk_test", host: "https://ottertrail.example.com", ...attributes } as Record<
        string,
        string | undefined
      >,
    },
    createElement: (tagName: string) => {
      const element: Record<string, unknown> = { tagName };
      // A script's load failing: a test fires it with element.fail().
      Object.defineProperties(element, {
        addEventListener: {
          value: (type: string, listener: () => void) => {
            if (type === "error") Object.defineProperty(element, "fail", { value: listener });
          },
        },
      });
      return element;
    },
    head: { append: (element: Record<string, unknown>) => added.push(element) },
    referrer,
    visibilityState: "visible" as "visible" | "hidden",
    prerendering: false,
    // Whether the page has <meta name="ottertrail" content="not-found">.
    markedNotFound: false,
    querySelector(selector: string) {
      return this.markedNotFound && selector === 'meta[name="ottertrail"][content="not-found"]'
        ? {}
        : null;
    },
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
    /** Read only: a test fails if the tracker writes. */
    localStorage: {
      getItem: (name: string) => {
        if (storage === null) throw new Error("SecurityError");
        return storage[name] ?? null;
      },
      setItem: () => {
        throw new Error("the tracker must never write storage");
      },
    },
    ottertrail: undefined as
      | {
          track(name: string, properties?: object): void;
          notFound(): void;
          identify(userId: string, signature?: string): void;
          reset(): void;
          captureError(error: unknown, properties?: object): void;
          replay(on: boolean): void;
          pageview(path?: string): void;
          flush(): Promise<void>;
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
  vi.stubGlobal("Element", FakeElement);
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
  const script = page.added.find((element) => String(element.src).endsWith("/v.js"));
  return script?.[RECORD_PROPERTY] as (name: string, value: number) => void;
};

describe("Web Vitals", () => {
  test("loads v.js from beside the tracker, with its nonce, unless turned off or pinned", async () => {
    const page = fakePage("https://example.com/", "", {
      src: "https://ottertrail.example.com/t.js?v=2",
      nonce: "abc123",
    });
    await runScript();
    expect(page.added).toMatchObject([
      {
        tagName: "script",
        src: "https://ottertrail.example.com/v.js",
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
      src: "https://ottertrail.example.com/t.js?v=2",
      nonce: "abc123",
      attributes: { replay: "errors", replayText: "show" },
    });
    await runScript();
    expect(page.added).toMatchObject([
      { tagName: "script", src: "https://ottertrail.example.com/v.js" },
      {
        tagName: "script",
        src: "https://ottertrail.example.com/r.js",
        async: true,
        nonce: "abc123",
      },
    ]);
    expect(replayConfig(page)).toMatchObject({
      endpoint: "https://ottertrail.example.com/api/replays",
      key: "pk_test",
      text: true,
      media: false,
    });

    const media = fakePage("https://example.com/", "", {
      attributes: { replay: "errors", replayMedia: "show", vitals: "off" },
    });
    await runScript();
    expect(media.added.map((element) => element.src)).toEqual([
      "https://ottertrail.example.com/r.js",
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
  pageview(path?: string): void;
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
      "https://ottertrail.example.com/v.js",
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
      endpoint: "https://ottertrail.example.com/api/replays",
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
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("duplicate tracker ignored"));
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
      { src: "https://ottertrail.example.com/h.js", async: true, nonce: "abc123" },
    ]);
    expect(heatmapConfig(page)).toMatchObject({
      endpoint: "https://ottertrail.example.com/api/heatmaps",
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
    const said = warn.mock.calls.filter(([message]) =>
      String(message).includes("Heatmaps are off"),
    );
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
    config?.register({ navigated, stop: vi.fn<() => void>() });

    random.mockReturnValue(0.9);
    page.window.location.href = "https://example.com/about";
    page.window.history.pushState();
    expect(config?.page()).toBeNull();
    expect(navigated).toHaveBeenCalledTimes(1);
    // A change of the query string only is the same pageview.
    page.window.location.href = "https://example.com/about?tab=2";
    page.window.history.pushState();
    expect(navigated).toHaveBeenCalledTimes(1);
    expect(page.added).toHaveLength(1);
  });

  test("a pageview whose URL is too long to send has no heatmap page", async () => {
    const page = fakePage(`https://example.com/${"a".repeat(2048)}`, "", {
      attributes: { heatmaps: "on", vitals: "off" },
    });
    await runScript();
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

/** o.js's element, and the handoff the tracker put on it. */
const handoffOf = (page: ReturnType<typeof fakePage>) => {
  const script = page.added.find((element) => String(element.src).endsWith("/o.js"));
  return { script, handoff: script?.[OVERLAY_PROPERTY] as OverlayHandoff };
};

const taken = new WeakMap<object, OverlayConfig>();
/** The config, as o.js takes it while it runs: once, then kept for the test. */
function configOf(page: ReturnType<typeof fakePage>): OverlayConfig {
  const known = taken.get(page);
  if (known !== undefined) return known;
  const { script, handoff } = handoffOf(page);
  const tag = page.document.currentScript;
  Reflect.set(page.document, "currentScript", script);
  try {
    const config = handoff();
    if (config === undefined) throw new Error("o.js got no config");
    taken.set(page, config);
    return config;
  } finally {
    Reflect.set(page.document, "currentScript", tag);
  }
}

/** Hides the page, which sends what is waiting, and lets beacons arrive. */
async function leave(page: ReturnType<typeof fakePage>) {
  page.hide();
  await page.settle();
}

/** Every event received, once per ID: a retry or a second copy is the same row at the API. */
const unique = (page: ReturnType<typeof fakePage>) =>
  new Set(page.events.map((event) => event.id)).size;

describe("the heatmap overlay", () => {
  const TOKEN = "Ab-_0123456789abcdefghijklmnopqrstuvwxyzABC";
  const opened = (path = "/pricing?plan=team", options: Parameters<typeof fakePage>[2] = {}) =>
    fakePage(`https://example.com${path}#ottertrail-heatmap=${TOKEN}`, "", options);

  test("a real link: the fragment leaves, o.js loads with the nonce, and nothing at all is sent", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const page = opened("/pricing?plan=team", {
      nonce: "abc123",
      attributes: { heatmaps: "on", replay: "errors", environment: "staging" },
    });
    await runScript();
    expect(page.window.location.href).toBe("https://example.com/pricing?plan=team");
    // Only o.js while it asks: no v.js, r.js, or h.js.
    expect(page.added).toEqual([
      expect.objectContaining({
        src: "https://ottertrail.example.com/o.js",
        async: true,
        nonce: "abc123",
      }),
    ]);
    // Not on the element: a function that gives it to o.js only, as it runs, once.
    const { script, handoff } = handoffOf(page);
    expect(typeof handoff).toBe("function");
    expect(JSON.stringify(script)).not.toContain(TOKEN);
    expect(handoff()).toBeUndefined();
    expect(configOf(page)).toEqual({
      host: "https://ottertrail.example.com",
      token: TOKEN,
      environment: "staging",
      settled: expect.any(Function),
      fetch: expect.any(Function),
    });
    Reflect.set(page.document, "currentScript", script);
    expect(handoff()).toBeUndefined();
    Reflect.set(page.document, "currentScript", undefined);
    page.window.ottertrail?.track("signup");
    await vi.advanceTimersByTimeAsync(4000);
    await page.settle();
    expect(page.batches).toEqual([]);

    expect(configOf(page).settled(true)).toBe(true);
    page.window.ottertrail?.track("signup", { plan: "team" });
    page.window.ottertrail?.captureError(new Error("boom"));
    page.window.ottertrail?.replay(true);
    page.fire("error", new FakeErrorEvent({ message: "boom", error: new Error("boom") }));
    page.window.location.href = "https://example.com/next";
    page.window.history.pushState();
    // Back from the back/forward cache: still the owner's look.
    page.fire("pageshow", { persisted: true });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(configOf(page).settled(false)).toBe(false);
    page.fire("pagehide");
    await leave(page);
    expect(page.batches).toEqual([]);
    expect(page.added).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
  });

  test("not a link: the page load is recorded as for any visitor, with what happened while waiting", async () => {
    const page = opened("/pricing", {
      attributes: { vitals: "off", heatmaps: "on", userId: "user-42" },
    });
    await runScript();
    page.fire("error", new FakeErrorEvent({ message: "early", error: new Error("early") }));
    page.window.ottertrail?.track("signup");
    page.window.location.href = "https://example.com/welcome";
    page.window.history.pushState();
    expect(page.added.map((element) => element.src)).toEqual([
      "https://ottertrail.example.com/o.js",
    ]);
    expect(configOf(page).settled(false)).toBe(true);
    expect(page.added.map((element) => element.src)).toContain(
      "https://ottertrail.example.com/h.js",
    );
    await leave(page);
    expect(
      page.events
        .filter((event) => event.name !== ENGAGEMENT)
        .map((event) => [event.name, event.url, event.userId]),
    ).toEqual([
      ["pageview", "https://example.com/pricing", "user-42"],
      ["error", "https://example.com/pricing", "user-42"],
      ["signup", "https://example.com/pricing", "user-42"],
      ["pageview", "https://example.com/welcome", "user-42"],
    ]);
  });

  test("events held while o.js asks leave with a fresh sentAt, so their order and times stay true", async () => {
    const page = opened("/", { attributes: { vitals: "off" } });
    await runScript();
    await vi.advanceTimersByTimeAsync(2000);
    page.window.ottertrail?.track("signup");
    // No answer in 5 seconds: released by the wait, and sent at once (a timer
    // set at the end of an advance runs on the next).
    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(1);
    await page.settle();
    const batch = page.batches[0] as SentBatch & { sentAt: number };
    // Written as it left, not as it was held.
    expect(batch.sentAt).toBe(start + 5001);
    // API correction: received - (sentAt - occurredAt). Each event keeps its age,
    // so the pageview stays 2 seconds before the custom event.
    expect(batch.events.map((event) => [event.name, batch.sentAt - event.occurredAt])).toEqual([
      ["pageview", 5001],
      ["signup", 3001],
    ]);
  });

  test("a site's track() goes at once, before a link's navigation can begin", async () => {
    const page = fakePage("https://example.com/", "", { attributes: { vitals: "off" } });
    await runScript();
    // No timer has run: the request starts inside track(), as in a link's click handler.
    page.window.ottertrail?.track("store_click", { store: "app_store", placement: "hero" });
    expect(page.events.map((event) => [event.name, event.properties])).toEqual([
      ["pageview", undefined],
      ["store_click", { store: "app_store", placement: "hero" }],
    ]);
  });

  test("leaving the page right after a click sends the rest, engagement too, by keepalive fetch", async () => {
    const page = fakePage("https://example.com/", "", { attributes: { vitals: "off" } });
    const keepalive: unknown[] = [];
    const recorded = globalThis.fetch;
    vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
      keepalive.push(init.keepalive);
      return recorded(url, init);
    });
    const beacons = vi.fn<() => boolean>(() => true);
    Object.assign(globalThis.navigator, { sendBeacon: beacons });
    await runScript();
    await vi.advanceTimersByTimeAsync(3000);
    page.window.ottertrail?.track("store_click", { store: "app_store" });
    page.fire("pagehide");
    await page.settle();
    // store_click's request may still be in flight as the page hides, so it may go twice, with the
    // same ID: the API stores it once.
    const byId = new Map(page.events.map((event) => [event.id, event.name]));
    expect([...byId.values()]).toEqual(["pageview", "store_click", "engagement"]);
    expect(page.events.at(-1)?.properties).toEqual({ engagedMs: 3000 });
    expect(keepalive.length).toBeGreaterThan(0);
    expect(keepalive.every((flag) => flag === true)).toBe(true);
    expect(beacons).not.toHaveBeenCalled();
  });

  test("window.ottertrail.flush() sends what waits now", async () => {
    const page = fakePage("https://example.com/", "", { attributes: { vitals: "off" } });
    await runScript();
    await page.window.ottertrail?.flush();
    expect(page.events.map((event) => event.name)).toEqual(["pageview"]);
  });

  test("leaving sends by keepalive fetch, never by beacon, which block lists class as a ping", async () => {
    const page = fakePage("https://example.com/", "", { attributes: { vitals: "off" } });
    const beacons = vi.fn<() => boolean>(() => true);
    Object.assign(globalThis.navigator, { sendBeacon: beacons });
    await runScript();
    await leave(page);
    expect(beacons).not.toHaveBeenCalled();
    expect(page.events.map((event) => event.name)).toEqual(["pageview"]);
  });

  test("where fetch has no keepalive, a beacon carries the batch; refused, a fetch does", async () => {
    // A browser too old for keepalive (Firefox before 133).
    vi.stubGlobal("Request", function Request() {});
    for (const path of ["/plain", "/held"]) {
      const page =
        path === "/plain"
          ? fakePage(`https://example.com${path}`, "", { attributes: { vitals: "off" } })
          : opened(path, { attributes: { vitals: "off" } });
      const beacons = vi.fn<() => boolean>(() => false);
      Object.assign(globalThis.navigator, { sendBeacon: beacons });
      await runScript();
      if (path === "/held") configOf(page).settled(false);
      await leave(page);
      expect(beacons).toHaveBeenCalled();
      expect(page.events.map((event) => event.name)).toContain("pageview");
    }
  });

  test("leaving or hiding the page while o.js asks releases it: the events go once", async () => {
    const left = opened("/", { attributes: { vitals: "off" } });
    await runScript();
    left.window.ottertrail?.track("signup");
    left.fire("pagehide");
    await left.settle();
    expect(left.events.map((event) => event.name)).toEqual(["pageview", "signup"]);
    // The tracker's own visibilitychange after it sends nothing again.
    await leave(left);
    expect(left.events).toHaveLength(unique(left));

    const hidden = opened("/", { attributes: { vitals: "off" } });
    await runScript();
    await leave(hidden);
    expect(hidden.events.map((event) => event.name)).toEqual(["pageview"]);
  });

  test("a real link answered after the tab was hidden: muted from then on, and h.js never loads", async () => {
    const page = opened("/", { attributes: { vitals: "off", heatmaps: "on", replay: "errors" } });
    await runScript();
    // The owner switches back to the dashboard before o.js answers: counted.
    await leave(page);
    expect(page.events.map((event) => event.name)).toEqual(["pageview"]);
    page.show();
    expect(configOf(page).settled(true)).toBe(false);
    page.window.ottertrail?.track("signup");
    page.fire("error", new FakeErrorEvent({ message: "boom", error: new Error("boom") }));
    page.window.ottertrail?.replay(true);
    await vi.advanceTimersByTimeAsync(10_000);
    await leave(page);
    expect(page.events.map((event) => event.name)).toEqual(["pageview"]);
    // Neither h.js nor r.js: they waited for the answer, which was a real link.
    expect(page.added.map((element) => element.src)).toEqual([
      "https://ottertrail.example.com/o.js",
    ]);
  });

  test("a real link answered after the 5-second wait: r.js and h.js, already started, stop too", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const page = opened("/", { attributes: { vitals: "off", heatmaps: "on", replay: "errors" } });
    await runScript();
    // No answer in 5 seconds: the page load counts, and the scripts load.
    await vi.advanceTimersByTimeAsync(5001);
    await page.settle();
    expect(page.added.map((element) => element.src)).toEqual([
      "https://ottertrail.example.com/o.js",
      "https://ottertrail.example.com/r.js",
      "https://ottertrail.example.com/h.js",
    ]);
    const started = fakeRecorder("8a1c4d2e-0f3b-4c5d-9e6f-7a8b9c0d1e2f");
    replayConfig(page)?.register(started);
    const capture = { navigated: vi.fn<() => void>(), stop: vi.fn<() => void>() };
    heatmapConfig(page)?.register(capture);
    const sent = page.events.length;

    expect(configOf(page).settled(true)).toBe(false);
    expect(started.stop).toHaveBeenCalledTimes(1);
    expect(capture.stop).toHaveBeenCalledTimes(1);
    page.fire("error", new FakeErrorEvent({ message: "boom", error: new Error("boom") }));
    // The page's consent tool cannot start a new recording either.
    page.window.ottertrail?.replay(true);
    expect(started.again).not.toHaveBeenCalled();
    page.window.location.href = "https://example.com/next";
    page.window.history.pushState();
    await vi.advanceTimersByTimeAsync(60_000);
    await leave(page);
    expect(page.events).toHaveLength(sent);
  });

  test("a real link answered while r.js and h.js load: each stops as it runs", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const page = opened("/", { attributes: { vitals: "off", heatmaps: "on", replay: "errors" } });
    await runScript();
    await vi.advanceTimersByTimeAsync(5001);
    expect(configOf(page).settled(true)).toBe(false);
    const loaded = fakeRecorder("x");
    replayConfig(page)?.register(loaded);
    expect(loaded.stop).toHaveBeenCalledTimes(1);
    const capture = { navigated: vi.fn<() => void>(), stop: vi.fn<() => void>() };
    heatmapConfig(page)?.register(capture);
    expect(capture.stop).toHaveBeenCalledTimes(1);
  });

  test("a late real link with an older h.js, without stop(), still mutes the tracker", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const page = opened("/", { attributes: { vitals: "off", heatmaps: "on" } });
    await runScript();
    await vi.advanceTimersByTimeAsync(5001);
    await page.settle();
    heatmapConfig(page)?.register({ navigated: vi.fn<() => void>() } as unknown as HeatmapCapture);
    const sent = page.events.length;
    expect(() => configOf(page).settled(true)).not.toThrow();
    page.window.ottertrail?.track("signup");
    await leave(page);
    expect(page.events).toHaveLength(sent);
  });

  test("back from the back/forward cache after a release: a new pageview, as for any visitor", async () => {
    const page = opened("/", { attributes: { vitals: "off" } });
    await runScript();
    configOf(page).settled(false);
    page.fire("pageshow", { persisted: true });
    await leave(page);
    expect(page.events.filter((event) => event.name === "pageview")).toHaveLength(2);
  });

  test("the page's stand-in: its queued consent is applied, and a kept reference works", async () => {
    const page = opened("/", {
      attributes: { vitals: "off", replay: "errors", replayConsent: "wait" },
    });
    const early = standIn(page);
    early.replay(true);
    await runScript();
    configOf(page).settled(false);
    expect(page.added.map((element) => element.src)).toContain(
      "https://ottertrail.example.com/r.js",
    );
    early.track("from-kept-reference");
    await leave(page);
    expect(page.events.map((event) => event.name)).toContain("from-kept-reference");
  });

  test("o.js failing to load settles at once; not answering within 5 seconds, after them", async () => {
    const blocked = opened("/", { attributes: { vitals: "off" } });
    await runScript();
    (blocked.added[0] as { fail: () => void }).fail();
    await vi.advanceTimersByTimeAsync(0);
    await blocked.settle();
    expect(blocked.events.map((event) => event.name)).toEqual(["pageview"]);

    const silent = opened("/", { attributes: { vitals: "off" } });
    await runScript();
    await vi.advanceTimersByTimeAsync(4999);
    await silent.settle();
    expect(silent.events).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(1);
    await silent.settle();
    expect(silent.events.map((event) => event.name)).toEqual(["pageview"]);
    expect(configOf(silent).settled(true)).toBe(false);
    await leave(silent);
    expect(silent.events.filter((event) => event.name === "pageview")).toHaveLength(1);
  });

  test("a second copy of the tracker on the page does nothing", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const page = opened("/", { attributes: { vitals: "off" } });
    await runScript();
    configOf(page).settled(true);
    await runScript();
    await vi.advanceTimersByTimeAsync(10_000);
    await leave(page);
    expect(page.events).toEqual([]);
    expect(page.added).toHaveLength(1);
  });

  test("with an integrity attribute, o.js cannot load: the page load is recorded at once", async () => {
    const page = opened("/", { attributes: { vitals: "off" } });
    Object.assign(page.document.currentScript, {
      hasAttribute: (name: string) => name === "integrity",
    });
    await runScript();
    expect(page.window.location.href).toBe("https://example.com/");
    expect(page.added).toEqual([]);
    await leave(page);
    expect(page.events.map((event) => event.name)).toContain("pageview");
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
      await leave(page);
      expect(page.events.map((event) => event.name)).toContain("pageview");
    }
  });
});

describe("traces", () => {
  const TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";
  const SPAN = "00f067aa0ba902b7";

  /** The server named its trace in Server-Timing; the page's own requests answer 503. */
  function tracedPage(attributes: Record<string, string>) {
    vi.stubGlobal("performance", {
      now: () => Date.now(),
      getEntriesByType: (type: string) =>
        type === "navigation"
          ? [{ serverTiming: [{ name: "traceparent", description: `00-${TRACE}-${SPAN}-01` }] }]
          : [],
    });
    const page = fakePage("https://example.com/checkout", "", { attributes });
    const requests: { url: string; traceparent: string | null }[] = [];
    const pageFetch = (url: string, init?: RequestInit) => {
      requests.push({ url, traceparent: new Headers(init?.headers).get("traceparent") });
      return Promise.resolve({ status: 503 });
    };
    Object.assign(page.window, { fetch: pageFetch });
    const fetch = (url: string) =>
      (page.window as unknown as { fetch: typeof pageFetch }).fetch(url);
    /** n.js, as the tracker added it, runs. */
    const startChunk = () => {
      const chunk = page.added.find((element) => String(element.src).endsWith("/n.js"));
      expect(chunk).toMatchObject({ src: "https://ottertrail.example.com/n.js", async: true });
      startRequestTracing(chunk?.[TRACES_PROPERTY] as TracesConfig, page.window, crypto, () =>
        Date.now(),
      );
    };
    return { page, requests, fetch, startChunk };
  }

  test("are off by default: no trace is read, n.js is not loaded, and requests are left alone", async () => {
    const { page, requests, fetch } = tracedPage({});
    await runScript();
    expect(page.added.some((element) => String(element.src).endsWith("/n.js"))).toBe(false);
    await fetch("/api/cart");
    expect(requests[0]?.traceparent).toBeNull();
    uncaught(page, failure("boom"));
    const [error] = await errorsSent(page);
    expect(page.events[0]).not.toHaveProperty("traceId");
    expect(error).not.toHaveProperty("traceId");
    expect(error?.error).not.toHaveProperty("requests");
  });

  test("the page load's pageview, errors, and Web Vitals carry its trace; later pages do not", async () => {
    const { page, fetch, requests, startChunk } = tracedPage({ traces: "on" });
    await runScript();
    startChunk();
    recorder(page)("LCP", 1200);
    await fetch("/api/cart?coupon=SECRET");
    await vi.advanceTimersByTimeAsync(0);
    uncaught(page, failure("first"));

    page.window.location.href = "https://example.com/done";
    page.window.history.pushState();
    uncaught(page, failure("second"));
    page.hide();
    await page.settle();

    const byName = (name: string) => page.events.filter((event) => event.name === name);
    const [landing, next] = byName("pageview");
    expect(landing).toMatchObject({ traceId: TRACE, spanId: SPAN });
    expect(next).not.toHaveProperty("traceId");
    expect(byName("vitals")[0]).toMatchObject({ traceId: TRACE, spanId: SPAN });

    const [first, second] = byName("error");
    expect(requests[0]?.traceparent).toMatch(/^00-[\da-f]{32}-[\da-f]{16}-01$/);
    const sentTrace = requests[0]?.traceparent?.slice(3, 35);
    const request = { method: "GET", path: "/api/cart", status: 503, traceId: sentTrace };
    expect(first).toMatchObject({ traceId: TRACE, spanId: SPAN });
    expect(first?.error?.requests).toEqual([{ ...request, durationMs: expect.any(Number) }]);
    expect(second).not.toHaveProperty("traceId");
    expect(second?.error?.requests).toMatchObject([request]);
    expect(JSON.stringify(page.events)).not.toContain("SECRET");
  });

  test("a sample of 0 sends no header but keeps the page load's trace", async () => {
    const { page, fetch, requests, startChunk } = tracedPage({ traces: "on", tracesSample: "0" });
    await runScript();
    startChunk();
    await fetch("/api/a");
    expect(requests[0]?.traceparent).toBeNull();
    page.hide();
    await page.settle();
    expect(page.events[0]).toMatchObject({ name: "pageview", traceId: TRACE });
  });

  test("an error before n.js runs carries the trace but no requests", async () => {
    const { page } = tracedPage({ traces: "on" });
    await runScript();
    uncaught(page, failure("early"));
    const [error] = await errorsSent(page);
    expect(error).toMatchObject({ traceId: TRACE, spanId: SPAN });
    expect(error?.error).not.toHaveProperty("requests");
  });

  test("with integrity, n.js is not loaded, and the page load's trace still goes", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { page } = tracedPage({ traces: "on" });
    Object.assign(page.document.currentScript, {
      hasAttribute: (name: string) => name === "integrity",
    });
    await runScript();
    expect(page.added).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      "Ottertrail: Request tracing is off because the script tag has integrity. Remove integrity to enable it.",
    );
    page.hide();
    await page.settle();
    expect(page.events[0]).toMatchObject({ name: "pageview", traceId: TRACE });
  });

  test("an invalid sample warns and samples every pageview", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { fetch, requests, startChunk } = tracedPage({ traces: "on", tracesSample: "" });
    await runScript();
    startChunk();
    await fetch("/api/a");
    expect(requests[0]?.traceparent).not.toBeNull();
    expect(warn).toHaveBeenCalledWith(
      "Ottertrail: data-traces-sample must be from 0 to 1. All pageviews are sampled.",
    );
  });

  test("only listed origins besides the page's own get the header, never Ottertrail", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { fetch, requests, startChunk } = tracedPage({
      traces: "on",
      tracesOrigins: "https://api.example.com api.example.com",
    });
    await runScript();
    startChunk();
    await fetch("https://api.example.com/v1/me");
    await fetch("https://cdn.example.net/x.json");
    await fetch("https://ottertrail.example.com/api/events");
    expect(requests.map((request) => request.traceparent !== null)).toEqual([true, false, false]);
    expect(warn).toHaveBeenCalledWith(
      "Ottertrail: data-traces-origins takes origins such as https://api.example.com. Other entries are ignored.",
    );
  });
});

/** A click on a link, as the browser dispatches it to the document. */
function clickLink(
  page: ReturnType<typeof fakePage>,
  href: unknown,
  { type = "click", button = 0, attributes = [] as string[], ctrlKey = false } = {},
) {
  const event = {
    button,
    ctrlKey,
    target: new FakeElement({ href, attributes }),
    preventDefault: vi.fn<() => void>(),
  };
  page.fire(type, event);
  return event;
}

/**
 * The events other than pageviews, each once: one sent at once is still in
 * flight when the page hides, so it goes again, and the API stores it once.
 */
function sentOnce(page: ReturnType<typeof fakePage>) {
  const ids = new Set<string>();
  return page.events
    .filter((event) => event.name !== "pageview" && !ids.has(event.id) && ids.add(event.id))
    .map((event) => [event.name, event.url, event.properties]);
}

describe("links and not found pages", () => {
  const click = clickLink;
  const sent = sentOnce;

  test("a click on a link to another site sends its origin and path at once, without delaying it", async () => {
    const page = fakePage("https://example.com/pricing?plan=team");
    await runScript();
    const event = click(page, "https://github.com/acme/widgets?ref=pricing#readme");

    // Sent before any timer runs: the request starts before the navigation does.
    expect(sent(page)).toEqual([
      ["outbound_link", "https://example.com/pricing", { url: "https://github.com/acme/widgets" }],
    ]);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  test("a middle click and a click with a modifier key count; the menu's button does not", async () => {
    const page = fakePage("https://example.com/");
    await runScript();
    click(page, "https://a.example.org/", { type: "auxclick", button: 1 });
    click(page, "https://b.example.org/", { ctrlKey: true });
    click(page, "https://c.example.org/", { type: "auxclick", button: 2 });
    page.hide();
    await page.settle();

    expect(sent(page).map(([name, , properties]) => [name, properties])).toEqual([
      ["outbound_link", { url: "https://a.example.org/" }],
      ["outbound_link", { url: "https://b.example.org/" }],
    ]);
  });

  test("links on the page's own host, links that are not http(s), and clicks off links send nothing", async () => {
    const page = fakePage("https://example.com/");
    await runScript();
    click(page, "https://example.com/pricing");
    click(page, "mailto:team@example.com");
    click(page, "tel:+15551234567");
    click(page, { baseVal: "https://svg.example.org/" }); // An SVG link.
    page.fire("click", { button: 0, target: new FakeElement() }); // Not in a link.
    page.fire("click", { button: 0, target: {} }); // Not an element.
    page.hide();
    await page.settle();

    expect(sent(page)).toEqual([]);
  });

  test("a file is a download on any host, and never also an outbound link", async () => {
    const page = fakePage("https://example.com/");
    await runScript();
    click(page, "https://example.com/files/Price-List.PDF?v=3");
    click(page, "https://cdn.example.net/app/setup.dmg");
    click(page, "https://example.com/export", { attributes: ["download"] });
    click(page, "https://example.com/docs/readme.html");
    page.hide();
    await page.settle();

    expect(sent(page).map(([name, , properties]) => [name, properties])).toEqual([
      ["file_download", { url: "https://example.com/files/Price-List.PDF" }],
      ["file_download", { url: "https://cdn.example.net/app/setup.dmg" }],
      ["file_download", { url: "https://example.com/export" }],
    ]);
  });

  test("a link longer than the API takes is not sent", async () => {
    const page = fakePage("https://example.com/");
    await runScript();
    click(page, `https://example.org/${"a".repeat(481)}`);
    page.hide();
    await page.settle();

    expect(sent(page)).toEqual([]);
  });

  test("a page marked with the meta tag sends not_found with its pageview, once", async () => {
    const page = fakePage("https://example.com/old-pricing?from=mail");
    page.document.markedNotFound = true;
    await runScript();
    page.window.ottertrail?.notFound();
    // An in-app page after it keeps the head, but is not marked.
    page.window.location.href = "https://example.com/";
    page.window.history.pushState();
    page.hide();
    await page.settle();

    expect(page.events.map((event) => [event.name, event.url, event.properties])).toEqual([
      ["pageview", "https://example.com/old-pricing", undefined],
      ["not_found", "https://example.com/old-pricing", undefined],
      ["pageview", "https://example.com/", undefined],
    ]);
  });

  test("notFound() marks the page shown now, in a single-page app", async () => {
    const page = fakePage("https://example.com/");
    await runScript();
    page.window.location.href = "https://example.com/blog/2019";
    page.window.history.pushState();
    page.window.ottertrail?.notFound();
    page.window.ottertrail?.notFound();
    page.hide();
    await page.settle();

    expect(sent(page).filter(([name]) => name === "not_found")).toEqual([
      ["not_found", "https://example.com/blog/2019", undefined],
    ]);
  });

  test.each([
    ["outbound", ["file_download"]],
    ["downloads", ["outbound_link"]],
  ])('data-%s="off" turns that kind off, and leaves the other', async (attribute, names) => {
    const page = fakePage("https://example.com/", "", { attributes: { [attribute]: "off" } });
    await runScript();
    click(page, "https://github.com/acme/widgets");
    click(page, "https://example.com/files/report.pdf");
    page.hide();
    await page.settle();

    expect(sent(page).map(([name]) => name)).toEqual(names);
  });

  test('data-not-found="off" sends no not_found, from the meta tag or notFound()', async () => {
    const page = fakePage("https://example.com/missing", "", { attributes: { notFound: "off" } });
    page.document.markedNotFound = true;
    await runScript();
    page.window.ottertrail?.notFound();
    page.hide();
    await page.settle();

    expect(page.events.map((event) => event.name)).toEqual(["pageview"]);
  });

  test("a page cannot send these events itself", async () => {
    const page = fakePage("https://example.com/");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await runScript();
    for (const name of ["outbound_link", "file_download", "not_found"]) {
      page.window.ottertrail?.track(name, { url: "https://example.org/" });
    }
    page.hide();
    await page.settle();

    expect(page.events.map((event) => event.name)).toEqual(["pageview"]);
    expect(warn).toHaveBeenCalledTimes(3);
  });
});

/** Every request body as sent, as one text, for checking that a value never leaves. */
const allSent = (page: ReturnType<typeof fakePage>) => JSON.stringify(page.batches);

describe("hash routes", () => {
  test('with data-hash-routes="on", the route is the page, cut at its query, and a new route is a pageview', async () => {
    const page = fakePage("https://example.com/?utm_source=news#/pricing?plan=team", "", {
      attributes: { hashRoutes: "on" },
    });
    await runScript();
    page.window.location.href = "https://example.com/#/docs";
    page.fire("hashchange");
    page.window.location.href = "https://example.com/#/docs?tab=2"; // Its query: no pageview.
    page.fire("hashchange");
    page.window.location.href = "https://example.com/#faq"; // No route: the page at "/".
    page.fire("hashchange");
    page.hide();
    await page.settle();

    expect(
      page.events
        .filter((event) => event.name === "pageview")
        .map((event) => [event.url, event.referrer]),
    ).toEqual([
      ["https://example.com/?utm_source=news#/pricing", undefined],
      ["https://example.com/#/docs", "https://example.com/"],
      ["https://example.com/", "https://example.com/"],
    ]);
  });

  test.each([
    "https://example.com/#access_token=s3cret&token_type=bearer",
    "https://example.com/#/callback&code=s3cret",
    "https://example.com/#/access_token=s3cret",
    "https://example.com/#/a#s3cret",
  ])("a token in the fragment never leaves: %s", async (href) => {
    const page = fakePage("https://example.com/#/start", "", { attributes: { hashRoutes: "on" } });
    await runScript();
    page.window.location.href = href;
    page.fire("hashchange");
    page.window.ottertrail?.track("signup");
    page.window.ottertrail?.captureError(new Error("failed"));
    page.hide();
    await page.settle();

    expect(page.events.length).toBeGreaterThan(2);
    expect(allSent(page)).not.toContain("s3cret");
    expect(page.events.at(-1)?.url).toBe("https://example.com/");
  });

  test("without the attribute, every fragment is dropped and a hash change is no pageview", async () => {
    const page = fakePage("https://example.com/#/pricing");
    await runScript();
    page.window.location.href = "https://example.com/#/docs";
    page.fire("hashchange");
    page.fire("popstate");
    page.hide();
    await page.settle();

    expect(page.events.map((event) => [event.name, event.url])).toEqual([
      ["pageview", "https://example.com/"],
    ]);
  });
});

describe("manual pageviews", () => {
  test('with data-pageviews="manual", only pageview() records pageviews, with a path if given', async () => {
    const page = fakePage("https://example.com/products/42?utm_source=news&token=s3cret", "", {
      attributes: { pageviews: "manual" },
    });
    await runScript();
    page.window.location.href = "https://example.com/products/43";
    page.window.history.pushState(); // No automatic pageview.
    page.window.ottertrail?.pageview("/products/:id");
    vi.setSystemTime(start + 3000);
    page.window.ottertrail?.pageview();
    page.hide();
    await page.settle();

    expect(summary(page.events)).toEqual([
      ["pageview", "https://example.com/products/:id", undefined],
      ["engagement", "https://example.com/products/:id", 3000],
      ["pageview", "https://example.com/products/43", undefined],
    ]);
    expect(allSent(page)).not.toContain("s3cret");
  });

  test("a path keeps the page's UTM tags, and goes through the before-send hook too", async () => {
    const page = fakePage("https://example.com/p/42?utm_campaign=launch", "", {
      attributes: { pageviews: "manual", beforeSend: "hook" },
    });
    const seen: unknown[] = [];
    Object.assign(page.window, {
      hook: (event: { url: string }) => {
        seen.push(event.url);
        return event;
      },
    });
    await runScript();
    page.window.ottertrail?.pageview("/p/:id?ref=x#top");
    page.hide();
    await page.settle();

    expect(seen).toEqual(["https://example.com/p/:id?utm_campaign=launch"]);
    expect(page.events.map((event) => event.url)).toEqual([
      "https://example.com/p/:id?utm_campaign=launch",
    ]);
  });

  test.each(["products", "//evil.example/x", "/\\evil.example/x", "https://evil.example/", 42])(
    "pageview(%j) records nothing and warns",
    async (path) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const page = fakePage("https://example.com/", "", { attributes: { pageviews: "manual" } });
      await runScript();
      page.window.ottertrail?.pageview(path as string);
      page.hide();
      await page.settle();

      expect(page.events).toEqual([]);
      expect(warn).toHaveBeenCalledOnce();
    },
  );

  test("the stand-in queues pageviews made before the tracker runs", async () => {
    const page = fakePage("https://example.com/", "", { attributes: { pageviews: "manual" } });
    standIn(page).pageview("/early");
    await runScript();
    page.hide();
    await page.settle();

    expect(page.events.map((event) => [event.name, event.url])).toEqual([
      ["pageview", "https://example.com/early"],
    ]);
  });
});

/** A page whose snippet names the before-send hook, with `hook` as that global. */
const withHook = async (hook: unknown, href = "https://example.com/pricing") => {
  const page = fakePage(href, "https://news.example/item", {
    attributes: { beforeSend: "ottertrailBeforeSend" },
  });
  Object.assign(page.window, { ottertrailBeforeSend: hook });
  await runScript();
  return page;
};

describe("the before-send hook", () => {
  test("sees each event, the first pageview included, and can change its page and properties", async () => {
    const seen: unknown[] = [];
    const page = await withHook(
      (event: { name: string; url: string; properties?: Record<string, unknown> }) => {
        seen.push(structuredClone(event));
        return {
          ...event,
          url: event.url.replace(/\/users\/\d+/, "/users/:id"),
          referrer: undefined,
          properties: event.name === "signup" ? { plan: "pro" } : event.properties,
        };
      },
      "https://example.com/users/42?secret=1",
    );
    page.window.ottertrail?.track("signup", { plan: "free", nested: { a: 1 } });
    page.hide();
    await page.settle();

    expect(seen[0]).toEqual({
      name: "pageview",
      url: "https://example.com/users/42",
      referrer: "https://news.example/item",
      properties: undefined,
    });
    // It sees the properties as they would be sent.
    expect(seen[1]).toMatchObject({ name: "signup", properties: { plan: "free" } });
    expect(page.events[0]?.url).toBe("https://example.com/users/:id");
    expect(sentOnce(page)).toEqual([["signup", "https://example.com/users/:id", { plan: "pro" }]]);
    expect(page.events[0]).not.toHaveProperty("referrer");
  });

  test("null drops the event; the others still go", async () => {
    const page = await withHook((event: { name: string }) =>
      event.name === "signup" ? null : event,
    );
    page.window.ottertrail?.track("signup");
    page.window.ottertrail?.track("upgrade");
    await page.settle();

    expect(page.events.map((event) => event.name)).toEqual(["pageview", "upgrade"]);
  });

  test("its result is cleaned: query strings, bad properties, and a name change are not kept", async () => {
    const page = await withHook((event: { name: string }) => ({
      ...event,
      name: "pageview",
      url: "https://example.com/next?token=s3cret#frag",
      referrer: "https://other.example/path?q=private",
      properties: { nested: { a: 1 }, ok: "yes", "": "x" },
    }));
    page.window.ottertrail?.track("signup");
    await page.settle();

    expect(page.events[1]).toMatchObject({
      name: "signup",
      url: "https://example.com/next",
      referrer: "https://other.example/path",
      properties: { ok: "yes" },
    });
    expect(allSent(page)).not.toContain("s3cret");
    expect(allSent(page)).not.toContain("private");
  });

  test("the tracker's own measurements stay as they are", async () => {
    const page = await withHook((event: object) => ({ ...event, properties: { engagedMs: "x" } }));
    vi.setSystemTime(start + 5000);
    page.hide();
    await page.settle();

    expect(page.events[1]).toMatchObject({ name: "engagement", properties: { engagedMs: 5000 } });
  });

  test.each([
    [
      "throws",
      (event: { name: string }) => {
        if (event.name === "signup") throw new Error("hook bug");
        return event;
      },
    ],
    ["returns nothing", (event: { name: string }) => (event.name === "signup" ? undefined : event)],
    [
      "moves it to another site",
      (event: { name: string; url: string }) =>
        event.name === "signup" ? { ...event, url: "https://evil.example/" } : event,
    ],
  ])(
    "a hook that %s drops that event only, warns once, and never breaks the page",
    async (_, hook) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const page = await withHook(hook);
      expect(() => {
        page.window.ottertrail?.track("signup");
        page.window.ottertrail?.track("signup");
        page.window.ottertrail?.track("upgrade");
      }).not.toThrow();
      await page.settle();

      expect(page.events.map((event) => event.name)).toEqual(["pageview", "upgrade"]);
      expect(warn).toHaveBeenCalledOnce();
    },
  );

  test("named but not defined: events are dropped, not sent unfiltered, with one warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const page = await withHook(undefined);
    page.window.ottertrail?.track("signup");
    page.hide();
    await page.settle();

    expect(page.events).toEqual([]);
    expect(warn).toHaveBeenCalledOnce();
  });

  test("a hook defined after the tracker applies from then on", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const page = await withHook(undefined);
    Object.assign(page.window, { ottertrailBeforeSend: (event: object) => event });
    page.window.ottertrail?.track("signup");
    await page.settle();

    expect(page.events.map((event) => event.name)).toEqual(["signup"]);
  });
});

/** A click on an element marked with an event, as the browser dispatches it to the document. */
const clickMarked = (
  page: ReturnType<typeof fakePage>,
  marked: Record<string, string>,
  { type = "click", button = 0, href }: { type?: string; button?: number; href?: string } = {},
) =>
  page.fire(type, {
    type,
    button,
    target: new FakeElement(href === undefined ? undefined : { href }, marked),
  });

describe("events from HTML attributes", () => {
  test("a click records the element's event, with its data-ottertrail-event-* properties only", async () => {
    const page = fakePage("https://example.com/pricing?token=s3cret");
    await runScript();
    clickMarked(page, {
      "data-ottertrail-event": "Signup",
      "data-ottertrail-event-plan": "pro",
      "data-ottertrail-event-billing-period": "yearly",
      "data-ottertrail-name": "hero-cta",
      class: "button",
    });

    // Sent at once, before any timer runs, as a custom event is.
    expect(sentOnce(page)).toEqual([
      ["Signup", "https://example.com/pricing", { plan: "pro", "billing-period": "yearly" }],
    ]);
  });

  test("on a link that leaves the page, its event and the outbound link both go at once", async () => {
    const page = fakePage("https://example.com/");
    await runScript();
    clickMarked(page, { "data-ottertrail-event": "Docs" }, { href: "https://docs.example.org/" });

    expect(sentOnce(page).map(([name]) => name)).toEqual(["outbound_link", "Docs"]);
  });

  test("the limits on names and properties apply, and reserved names are refused", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const page = fakePage("https://example.com/");
    await runScript();
    const many = Object.fromEntries(
      Array.from({ length: 40 }, (_, index) => [`data-ottertrail-event-p${index}`, "v"]),
    );
    clickMarked(page, {
      "data-ottertrail-event": "n".repeat(250),
      "data-ottertrail-event-long": "x".repeat(600),
      ...many,
    });
    clickMarked(page, { "data-ottertrail-event": "pageview" });
    clickMarked(page, { "data-ottertrail-event": "" });
    await page.settle();

    const [event, ...rest] = page.events.filter((sent) => sent.name !== "pageview");
    expect(rest).toEqual([]);
    expect(event?.name).toHaveLength(200);
    expect(Object.keys(event?.properties ?? {})).toHaveLength(30);
    expect(event?.properties?.long).toHaveLength(500);
    expect(warn).toHaveBeenCalledOnce();
  });

  test("a middle click counts on a link only, and the menu's button never", async () => {
    const page = fakePage("https://example.com/");
    await runScript();
    clickMarked(page, { "data-ottertrail-event": "A" }, { type: "auxclick", button: 1 });
    clickMarked(
      page,
      { "data-ottertrail-event": "B" },
      { type: "auxclick", button: 1, href: "https://example.com/b" },
    );
    clickMarked(page, { "data-ottertrail-event": "C" }, { type: "auxclick", button: 2 });
    await page.settle();

    expect(sentOnce(page).map(([name]) => name)).toEqual(["B"]);
  });
});

describe("ignoring the owner's own browser", () => {
  test('with localStorage.ottertrail_ignore = "true", nothing at all is sent and no script loads', async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const page = fakePage("https://example.com/", "", {
      storage: { ottertrail_ignore: "true" },
      attributes: { heatmaps: "on", replay: "errors", traces: "on" },
    });
    await runScript();
    page.window.ottertrail?.track("signup");
    page.window.ottertrail?.pageview("/other");
    page.window.ottertrail?.captureError(new Error("failed"));
    page.window.ottertrail?.replay(true);
    page.fire("click", {
      type: "click",
      button: 0,
      target: new FakeElement({ href: "https://github.com/" }, { "data-ottertrail-event": "A" }),
    });
    page.window.location.href = "https://example.com/next";
    page.window.history.pushState();
    vi.setSystemTime(start + 5000);
    page.hide();
    await vi.advanceTimersByTimeAsync(10_000);
    await page.window.ottertrail?.flush();

    expect(page.batches).toEqual([]);
    expect(page.added).toEqual([]);
    expect(info).toHaveBeenCalledOnce();
  });

  test("the overlay still opens for the owner, and nothing is sent", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const page = fakePage(`https://example.com/pricing#ottertrail-heatmap=${"a".repeat(43)}`, "", {
      storage: { ottertrail_ignore: "true" },
      attributes: { vitals: "off" },
    });
    await runScript();
    expect(page.added.map((script) => script.src)).toEqual(["https://ottertrail.example.com/o.js"]);
    await vi.advanceTimersByTimeAsync(10_000);
    page.hide();
    await page.settle();

    expect(page.batches).toEqual([]);
  });

  test.each([
    ["another value", { ottertrail_ignore: "1" }],
    ["storage that throws", null],
  ])("%s does not ignore the browser", async (_, storage) => {
    const page = fakePage("https://example.com/", "", { storage });
    await runScript();
    page.hide();
    await page.settle();

    expect(page.events.map((event) => event.name)).toEqual(["pageview"]);
  });
});
