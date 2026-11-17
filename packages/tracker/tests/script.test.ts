import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import { MAX_ENGAGED_MS } from "../src/engagement.ts";
import type { QueuedEvent } from "../src/tracker.ts";
import { RECORD_PROPERTY } from "../src/vital-names.ts";

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
    history: { pushState: () => {}, replaceState: () => {} },
    addEventListener: on,
    ottertrail: undefined as
      | {
          track(name: string, properties?: object): void;
          identify(userId: string, signature?: string): void;
          reset(): void;
          captureError(error: unknown, properties?: object): void;
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
