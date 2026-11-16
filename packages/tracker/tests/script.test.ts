import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import { MAX_ENGAGED_MS } from "../src/engagement.ts";
import type { QueuedEvent } from "../src/tracker.ts";

interface SentBatch {
  events: QueuedEvent[];
}

type Listener = (event: { persisted?: boolean }) => void;

/** Just enough of a browser page to run src/script.ts as a <script> tag would. */
function fakePage(href: string, referrer = "") {
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
  const document = {
    currentScript: { dataset: { key: "pk_test", host: "https://analytics.example.com" } },
    referrer,
    visibilityState: "visible" as "visible" | "hidden",
    prerendering: false,
    addEventListener: on,
  };
  const window = {
    location,
    history: { pushState: () => {}, replaceState: () => {} },
    addEventListener: on,
    ottertrail: undefined as { track(name: string, properties?: object): void } | undefined,
  };
  /** Everything the tracker handed over, by beacon or fetch. */
  const events: QueuedEvent[] = [];
  const record = (body: string) => events.push(...(JSON.parse(body) as SentBatch).events);

  vi.stubGlobal("document", document);
  vi.stubGlobal("location", location);
  vi.stubGlobal("window", window);
  vi.stubGlobal("navigator", {
    sendBeacon: (_url: string, blob: Blob) => {
      void blob.text().then(record);
      return true;
    },
  });
  vi.stubGlobal("fetch", (_url: string, init: { body: string }) => {
    record(init.body);
    return Promise.resolve({ status: 202, headers: { get: () => null } });
  });

  const fire = (type: string, event: { persisted?: boolean } = {}) => {
    for (const listener of listeners[type] ?? []) listener(event);
  };
  return {
    window,
    document,
    events,
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
