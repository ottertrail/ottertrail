/**
 * Heatmap capture (h.js) in headless Chromium: what a click and a scroll
 * depth send, rage clicks, the caps, sending, and, run as the tracker
 * loads it, single-page navigation and the privacy test: a page full of
 * planted values, clicked and typed into, and none of them in what leaves.
 */
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser/context";

import {
  type CaptureOptions,
  type HeatmapBatch,
  type HeatmapRecord,
  MAX_BATCH_BYTES,
  MAX_CLICKS_PER_PAGEVIEW,
  MAX_EXIT_BYTES,
  MAX_RECORDS_PER_BATCH,
  startCapture,
  TIME_STEP_MS,
} from "../../src/heatmap-capture.ts";
import { type HeatmapConfig, HEATMAP_PROPERTY, type HeatmapPage } from "../../src/heatmap-names.ts";

const ENDPOINT = "https://analytics.example.com/api/heatmaps";
const PAGE: HeatmapPage = { url: "https://example.com/pricing", at: 1_000 };

interface Sent {
  via: "fetch" | "beacon";
  body: HeatmapBatch;
  /** The body's size in bytes, as sent. */
  bytes: number;
}

/** A record with its page's URL and referrer put back from the batch's pages. */
type Received = HeatmapRecord & { url: string; referrer?: string };

/** Every record of these batches, with its page. */
const received = (batches: { body: HeatmapBatch }[]): Received[] =>
  batches.flatMap(({ body }) =>
    body.records.map((record) => ({ ...record, ...body.pages[record.page] }) as Received),
  );

const bytesOf = (text: string) => new TextEncoder().encode(text).length;

const cleanups: (() => void)[] = [];
/** The test page's own address, which the tests change and put back. */
const ADDRESS = location.pathname + location.search;
// Links in the fixtures must not leave the test page.
const stayOnPage = (event: Event) => event.preventDefault();
document.addEventListener("click", stayOnPage);
document.addEventListener("submit", stayOnPage);
afterEach(() => {
  history.replaceState(null, "", ADDRESS);
  // Last added, first undone.
  while (cleanups.length > 0) cleanups.pop()?.();
  document.body.innerHTML = "";
  document.body.style.height = "";
  window.scrollTo(0, 0);
});

/** h.js's capture on this page, sending to fakes; the clock and the answer's status are the test's. */
function capture({
  page = PAGE,
  status = 202,
  trusted = true,
  respond,
}: {
  page?: HeatmapPage | null;
  status?: number;
  trusted?: boolean;
  /** The API's answer to each fetch, in place of `status`. */
  respond?: () => Promise<{ status: number; headers: Headers }>;
} = {}) {
  const sent: Sent[] = [];
  const reading: Promise<unknown>[] = [];
  let current = page;
  let clock = 10_000;
  const config: HeatmapConfig = {
    endpoint: ENDPOINT,
    key: "pk_test",
    environment: "staging",
    page: () => current,
    register: () => undefined,
  };
  const fetch = vi.fn<CaptureOptions["fetch"]>(async (_url, init) => {
    const text = init.body as string;
    sent.push({ via: "fetch", body: JSON.parse(text) as HeatmapBatch, bytes: bytesOf(text) });
    return respond === undefined ? { status, headers: new Headers() } : respond();
  });
  const started = startCapture(config, {
    window,
    document,
    fetch,
    beacon: (_url, blob) => {
      reading.push(
        blob.text().then((text) =>
          sent.push({
            via: "beacon",
            body: JSON.parse(text) as HeatmapBatch,
            bytes: bytesOf(text),
          }),
        ),
      );
      return true;
    },
    now: () => clock,
    ...(trusted ? { trusted: () => true } : {}),
  });
  cleanups.push(started.stop);
  return {
    sent,
    fetch,
    started,
    records: () => received(sent),
    setPage: (next: HeatmapPage | null) => {
      current = next;
    },
    tick: (ms: number) => {
      clock += ms;
    },
    settle: () => Promise.all(reading),
  };
}

/** A page's URL made long by its UTM tags, which pageviews keep. */
const longUrl = (index: number) =>
  `https://example.com/p${index}?utm_campaign=${"c".repeat(2000)}&utm_content=${"d".repeat(2000)}`;

/** The next animation frames: what h.js waits for before measuring. */
const frames = async (count = 2) => {
  for (let index = 0; index < count; index += 1) {
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
};

/** A click made in code, at a share of the element's box. */
function click(element: Element, at = { x: 0.5, y: 0.5 }, options: MouseEventInit = {}) {
  const box = element.getBoundingClientRect();
  element.dispatchEvent(
    new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      detail: 1,
      button: 0,
      clientX: box.left + box.width * at.x,
      clientY: box.top + box.height * at.y,
      ...options,
    }),
  );
}

/** The visitor hides the tab. */
function hide() {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
  document.dispatchEvent(new Event("visibilitychange"));
  Reflect.deleteProperty(document, "visibilityState");
}

function scrollTo(y: number) {
  window.scrollTo(0, y);
  window.dispatchEvent(new Event("scroll"));
}

const element = (selector: string) => {
  const found = document.querySelector<HTMLElement>(selector);
  if (found === null) throw new Error(`No ${selector}`);
  return found;
};

const LAYOUT = `
  <main>
    <section data-ottertrail-name="hero">
      <h1>Pricing</h1>
      <a id="cta" href="/signup" style="display:inline-block;width:200px;height:40px"><span>Start</span></a>
    </section>
    <div>
      <p>One</p>
      <p>Two <button id="go" style="width:100px;height:20px">Go</button></p>
    </div>
    <nav data-ottertrail-name="not allowed!"><a id="bad-name" href="/">Home</a></nav>
  </main>`;

describe("a click", () => {
  test("records its element's path, the nearest name, its place in the element, and the page's sizes", async () => {
    document.body.innerHTML = LAYOUT;
    const heat = capture();
    // Inside the link's text: it counts for the link, under the named section.
    click(element("#cta span"), { x: 0.25, y: 0.5 });
    click(element("#go"), { x: 0.9, y: 0.1 });
    // A name the API would refuse is no name: the path runs from body.
    click(element("#bad-name"));
    hide();
    await heat.settle();

    const clicks = heat.records().filter((record) => record.type === "click");
    expect(clicks).toHaveLength(3);
    const [cta, go, bad] = clicks;
    expect(cta).toMatchObject({
      type: "click",
      url: PAGE.url,
      label: "hero",
      element: "section>a",
      vw: window.innerWidth,
      vh: window.innerHeight,
      device: window.innerWidth >= 1024 ? "desktop" : "tablet",
    });
    const ctaBox = element("#cta").getBoundingClientRect();
    const spanBox = element("#cta span").getBoundingClientRect();
    // The click's place in the link (not the span), as fractions.
    expect(cta?.type === "click" && cta.x).toBeCloseTo(
      (spanBox.left + spanBox.width * 0.25 - ctaBox.left) / ctaBox.width,
      1,
    );
    expect(cta?.type === "click" && cta.y).toBeCloseTo(
      (spanBox.top + spanBox.height * 0.5 - ctaBox.top) / ctaBox.height,
      1,
    );
    // Whole pixels: Chromium gives a made-up click whole client coordinates.
    expect(go).toMatchObject({
      element: "body>main>div>p:2>button",
      x: expect.closeTo(0.9, 1),
      y: expect.closeTo(0.1, 1),
    });
    expect(go).not.toHaveProperty("label");
    expect(bad).toMatchObject({ element: "body>main>nav>a" });
    expect(bad).not.toHaveProperty("label");
    expect(cta?.ph).toBeGreaterThanOrEqual(window.innerHeight);
  });

  test("paths are cut to their nearest 24 steps, marked with *>", async () => {
    document.body.innerHTML = `${"<div>".repeat(30)}<button id="deep">Deep</button>${"</div>".repeat(30)}`;
    const heat = capture();
    click(element("#deep"));
    hide();
    await heat.settle();
    const [deep] = heat.records();
    expect(deep?.type === "click" && deep.element).toBe(`*>${"div>".repeat(23)}button`);
  });

  test("only the visitor's own primary clicks with a position count, and not on unsampled pageviews", async () => {
    document.body.innerHTML = LAYOUT;
    const heat = capture({ trusted: false });
    click(element("#go")); // Made by a script: not trusted.
    await userEvent.click(element("#go")); // The visitor's.
    click(element("#go"), undefined, { button: 2 });
    heat.setPage(null);
    heat.started.navigated();
    await userEvent.click(element("#go")); // A pageview outside the sample.
    hide();
    await heat.settle();
    expect(heat.records().filter((record) => record.type === "click")).toHaveLength(1);
  });

  test("three clicks within a second and 30 pixels make the third and later rage clicks", async () => {
    document.body.innerHTML = LAYOUT;
    const heat = capture();
    const go = element("#go");
    // A burst: 0, 300, 600, 900 ms on one spot.
    for (const _ of [0, 1, 2, 3]) {
      click(go, { x: 0.5, y: 0.5 });
      heat.tick(300);
    }
    heat.tick(2000);
    // Slow: a second apart, never three within one.
    for (const _ of [0, 1, 2]) {
      click(go);
      heat.tick(600);
    }
    heat.tick(2000);
    // Fast but apart: 50 pixels between them.
    click(element("#cta"), { x: 0, y: 0.5 });
    click(element("#cta"), { x: 0.25, y: 0.5 });
    click(element("#cta"), { x: 0.5, y: 0.5 });
    hide();
    await heat.settle();
    const rage = heat
      .records()
      .filter((record) => record.type === "click")
      .map((record) => record.type === "click" && record.rage === true);
    expect(rage).toEqual([false, false, true, true, false, false, false, false, false, false]);
  });

  test(`at most ${MAX_CLICKS_PER_PAGEVIEW} clicks of a pageview are sent, and a new pageview starts again`, async () => {
    document.body.innerHTML = LAYOUT;
    const heat = capture();
    for (let index = 0; index < MAX_CLICKS_PER_PAGEVIEW + 5; index += 1) {
      click(element("#go"));
      heat.tick(2000);
    }
    heat.setPage({ url: "https://example.com/next", at: 50_000 });
    heat.started.navigated();
    click(element("#go"));
    hide();
    await heat.settle();
    // A batch still in flight as the page hides goes by beacon too: the API keeps one of each ID.
    const clicks = [
      ...new Map(
        heat
          .records()
          .filter((record) => record.type === "click")
          .map((record) => [record.id, record]),
      ).values(),
    ];
    expect(clicks.filter((record) => record.url === PAGE.url)).toHaveLength(
      MAX_CLICKS_PER_PAGEVIEW,
    );
    expect(clicks.filter((record) => record.url === "https://example.com/next")).toHaveLength(1);
    // Every batch within the API's limit.
    expect(heat.sent.every((batch) => batch.body.records.length <= MAX_RECORDS_PER_BATCH)).toBe(
      true,
    );
  });
});

describe("scroll depth", () => {
  test("is sent once when the page is hidden, again only when deeper, with the same ID", async () => {
    document.body.innerHTML = LAYOUT;
    document.body.style.height = "4000px";
    const heat = capture();
    scrollTo(1000);
    await frames(1);
    scrollTo(500); // Back up: the deepest point counts.
    await frames(1);
    hide();
    hide(); // Nothing deeper: nothing more.
    await heat.settle();
    const pageHeight = document.documentElement.scrollHeight;
    const first = heat.records().filter((record) => record.type === "scroll");
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      type: "scroll",
      url: PAGE.url,
      // To the minute.
      at: Math.floor(PAGE.at / TIME_STEP_MS) * TIME_STEP_MS,
      ph: pageHeight,
      vh: window.innerHeight,
    });
    expect(first[0]?.type === "scroll" && first[0].depth).toBeCloseTo(
      (1000 + window.innerHeight) / pageHeight,
      3,
    );

    scrollTo(pageHeight);
    hide();
    await heat.settle();
    const all = heat.records().filter((record) => record.type === "scroll");
    expect(all).toHaveLength(2);
    expect(all[1]?.id).toBe(all[0]?.id);
    expect(all[1]?.type === "scroll" && all[1].depth).toBe(1);
  });

  test("a pageview left in the app sends its depth, and the next one has its own", async () => {
    document.body.innerHTML = LAYOUT;
    document.body.style.height = "4000px";
    const heat = capture();
    scrollTo(2000);
    heat.setPage({ url: "https://example.com/next", at: 20_000 });
    heat.started.navigated();
    hide();
    await heat.settle();
    const scrolls = heat.records().filter((record) => record.type === "scroll");
    expect(scrolls.map((record) => record.url)).toEqual([PAGE.url, "https://example.com/next"]);
    expect(new Set(scrolls.map((record) => record.id)).size).toBe(2);
  });
});

describe("sending", () => {
  test("waits to batch, then sends with fetch; on hide, by beacon", async () => {
    document.body.innerHTML = LAYOUT;
    vi.useFakeTimers();
    cleanups.push(() => vi.useRealTimers());
    const heat = capture();
    click(element("#go"));
    expect(heat.fetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000);
    expect(heat.sent.map((batch) => batch.via)).toEqual(["fetch"]);
    expect(heat.sent[0]?.body).toMatchObject({ v: 1, key: "pk_test", environment: "staging" });
    click(element("#go"));
    hide();
    await heat.settle();
    expect(heat.sent.map((batch) => batch.via)).toEqual(["fetch", "beacon"]);
  });

  test("stops for the page load once the API refuses it (403, heatmaps off)", async () => {
    document.body.innerHTML = LAYOUT;
    vi.useFakeTimers();
    cleanups.push(() => vi.useRealTimers());
    const heat = capture({ status: 403 });
    click(element("#go"));
    await vi.advanceTimersByTimeAsync(5000);
    click(element("#go"));
    hide();
    await vi.advanceTimersByTimeAsync(60_000);
    await heat.settle();
    expect(heat.sent).toHaveLength(1);
  });

  test("retries the same records, with the same IDs, after a 503", async () => {
    document.body.innerHTML = LAYOUT;
    vi.useFakeTimers();
    cleanups.push(() => vi.useRealTimers());
    const heat = capture({ status: 503 });
    click(element("#go"));
    await vi.advanceTimersByTimeAsync(5000);
    heat.tick(2000);
    await vi.advanceTimersByTimeAsync(2000);
    expect(heat.sent.length).toBeGreaterThanOrEqual(2);
    expect(heat.sent[1]?.body.records.map((record) => record.id)).toEqual(
      heat.sent[0]?.body.records.map((record) => record.id),
    );
  });
});

describe("scroll depth in a single-page app", () => {
  test("the next page starts from 0, measured once it has rendered", async () => {
    document.body.innerHTML = LAYOUT;
    document.body.style.height = "4000px";
    const heat = capture();
    const vh = window.innerHeight;
    // /pricing read to the bottom.
    scrollTo(4000);
    await frames(1);
    // The app goes to /next, then renders it, taller, at its top.
    heat.setPage({ url: "https://example.com/next", at: 20_000 });
    heat.started.navigated();
    document.body.style.height = "6000px";
    window.scrollTo(0, 0);
    await frames();
    hide();
    await heat.settle();
    const [left, next] = heat.records().filter((record) => record.type === "scroll");
    expect(left).toMatchObject({ url: PAGE.url, depth: 1 });
    expect(next?.url).toBe("https://example.com/next");
    // Not the bottom it was never scrolled to: only its first screen.
    expect(next?.type === "scroll" && next.depth).toBeCloseTo(
      vh / document.documentElement.scrollHeight,
      2,
    );
  });

  test("a framework that renders the next page before pushState does not deepen the page left", async () => {
    document.body.innerHTML = LAYOUT;
    document.body.style.height = "4000px";
    const heat = capture();
    const vh = window.innerHeight;
    scrollTo(1000);
    await frames(1);
    const read = (1000 + vh) / document.documentElement.scrollHeight;
    // The next page renders first, shorter, and the browser clamps the scroll: then pushState.
    document.body.style.height = `${vh + 200}px`;
    scrollTo(1000);
    heat.setPage({ url: "https://example.com/short", at: 20_000 });
    heat.started.navigated();
    await frames();
    hide();
    await heat.settle();
    const [left] = heat.records().filter((record) => record.type === "scroll");
    expect(left?.type === "scroll" && left.depth).toBeCloseTo(read, 2);
  });

  test("the fold is the page as it first showed, before it grew", async () => {
    document.body.innerHTML = LAYOUT;
    document.body.style.height = "2000px";
    const vh = window.innerHeight;
    const first = document.documentElement.scrollHeight;
    const heat = capture();
    // Lazy content below.
    document.body.style.height = "8000px";
    scrollTo(8000);
    await frames(1);
    hide();
    await heat.settle();
    const [row] = heat.records().filter((record) => record.type === "scroll");
    expect(row?.type === "scroll" && row.fold).toBeCloseTo(vh / first, 2);
    expect(row?.ph).toBe(document.documentElement.scrollHeight);
  });
});

describe("limits", () => {
  test("clicks past the 100 are counted on the scroll record, which is sent again for them", async () => {
    document.body.innerHTML = LAYOUT;
    const heat = capture();
    for (let index = 0; index < MAX_CLICKS_PER_PAGEVIEW; index += 1) {
      click(element("#go"));
      heat.tick(2000);
    }
    hide();
    for (let index = 0; index < 5; index += 1) {
      click(element("#go"));
      heat.tick(2000);
    }
    hide();
    await heat.settle();
    const scrolls = heat.records().filter((record) => record.type === "scroll");
    expect(scrolls.map((record) => record.type === "scroll" && record.dropped)).toEqual([0, 5]);
    expect(new Set(scrolls.map((record) => record.id)).size).toBe(1);
  });

  test("batches are split by size, each within the API's 64 KiB, the pages sent once each", async () => {
    document.body.innerHTML = LAYOUT;
    vi.useFakeTimers();
    cleanups.push(() => vi.useRealTimers());
    const heat = capture();
    for (let index = 0; index < 40; index += 1) {
      heat.setPage({ url: longUrl(index), referrer: "https://news.example/", at: 1000 });
      heat.started.navigated();
      click(element("#go"));
      click(element("#cta"));
      heat.tick(2000);
    }
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(heat.sent.length).toBeGreaterThan(1);
    expect(heat.sent.every((batch) => batch.bytes <= MAX_BATCH_BYTES)).toBe(true);
    expect(heat.sent.every((batch) => batch.body.records.length <= MAX_RECORDS_PER_BATCH)).toBe(
      true,
    );
    // Each page once per batch, however many of its records are in it.
    for (const { body } of heat.sent) {
      expect(new Set(body.pages.map((page) => page.url)).size).toBe(body.pages.length);
    }
    expect(heat.records().filter((record) => record.type === "click")).toHaveLength(80);
  });

  test("what goes as the page closes stays within the keepalive budget, newest clicks kept", async () => {
    document.body.innerHTML = LAYOUT;
    vi.useFakeTimers();
    cleanups.push(() => vi.useRealTimers());
    // The API is away: everything waits.
    const heat = capture({ respond: () => new Promise(() => undefined) });
    heat.setPage({
      url: `https://example.com/long?utm_campaign=${"c".repeat(3000)}`,
      at: 1000,
    });
    heat.started.navigated();
    for (let index = 0; index < 60; index += 1) {
      click(index % 2 === 0 ? element("#go") : element("#cta"));
      heat.tick(2000);
    }
    hide();
    await heat.settle();
    const beacons = heat.sent.filter((batch) => batch.via === "beacon");
    const total = beacons.reduce((sum, batch) => sum + batch.bytes, 0);
    expect(total).toBeLessThanOrEqual(MAX_EXIT_BYTES);
    const left = received(beacons);
    // The pageview's scroll depth goes, and the newest clicks.
    expect(left.some((record) => record.type === "scroll")).toBe(true);
    const clicksLeft = left.filter((record) => record.type === "click").length;
    expect(clicksLeft).toBeGreaterThan(0);
    expect(clicksLeft).toBeLessThan(60);
  });

  test("waits as long as Retry-After says, even with a send already scheduled", async () => {
    document.body.innerHTML = LAYOUT;
    vi.useFakeTimers();
    cleanups.push(() => vi.useRealTimers());
    let answer: ((value: { status: number; headers: Headers }) => void) | undefined;
    const responses = [
      () =>
        new Promise<{ status: number; headers: Headers }>((resolve) => {
          answer = resolve;
        }),
    ];
    const heat = capture({
      respond: () =>
        (responses.shift() ?? (() => Promise.resolve({ status: 202, headers: new Headers() })))(),
    });
    click(element("#go"));
    await vi.advanceTimersByTimeAsync(5000);
    expect(heat.sent).toHaveLength(1);
    // A click while the send is out sets a batching timer.
    click(element("#cta"));
    answer?.({ status: 503, headers: new Headers({ "retry-after": "30" }) });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(heat.sent).toHaveLength(1);
    heat.tick(30_000);
    await vi.advanceTimersByTimeAsync(21_000);
    expect(heat.sent).toHaveLength(2);
  });
});

// The tracker and h.js together, as a site's page runs them.

let runs = 0;

/** Runs the tracker as its tag would, then h.js as the script it added; returns what h.js sent. */
async function runTrackerWithHeatmaps(attributes: Record<string, string>) {
  // The tracker of an earlier run would make this one a second copy.
  Reflect.deleteProperty(window, "ottertrail");
  const key = `pk_${String(runs + 1).padStart(32, "0")}`;
  const scripts: HTMLScriptElement[] = [];
  const append = vi.spyOn(document.head, "append").mockImplementation((...nodes) => {
    for (const node of nodes) if (node instanceof HTMLScriptElement) scripts.push(node);
  });
  const bodies: string[] = [];
  const realFetch = globalThis.fetch;
  const realBeacon = navigator.sendBeacon.bind(navigator);
  const reading: Promise<unknown>[] = [];
  // Only this run's: earlier runs' trackers stay on the page with their own keys.
  const keep = (url: string, body: string) => {
    if (url.endsWith("/api/heatmaps") && body.includes(key)) bodies.push(body);
  };
  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    keep(url, typeof init?.body === "string" ? init.body : "");
    return new Response(null, { status: 202 });
  };
  navigator.sendBeacon = (url, data) => {
    if (data instanceof Blob) reading.push(data.text().then((text) => keep(String(url), text)));
    return true;
  };
  const path = location.pathname + location.search;
  cleanups.push(() => {
    append.mockRestore();
    globalThis.fetch = realFetch;
    navigator.sendBeacon = realBeacon;
    Reflect.deleteProperty(window, "ottertrail");
    history.replaceState(null, "", path);
  });
  const tag = document.createElement("script");
  tag.src = "https://analytics.example.com/t.js";
  Object.assign(tag.dataset, {
    key,
    host: "https://analytics.example.com",
    vitals: "off",
    errors: "off",
    ...attributes,
  });
  const run = async (script: HTMLScriptElement, file: string) => {
    Object.defineProperty(document, "currentScript", { configurable: true, get: () => script });
    try {
      await import(/* @vite-ignore */ `../../src/${file}?run=${(runs += 1)}`);
    } finally {
      Reflect.deleteProperty(document, "currentScript");
    }
  };
  await run(tag, "script.ts");
  const heatmapScript = scripts.find((script) => script.src.endsWith("/h.js"));
  if (heatmapScript !== undefined) await run(heatmapScript, "heatmaps.ts");
  return {
    scripts,
    heatmapScript,
    records: async () => {
      await Promise.all(reading);
      return received(bodies.map((body) => ({ body: JSON.parse(body) as HeatmapBatch })));
    },
    bodies: async () => {
      await Promise.all(reading);
      return bodies;
    },
  };
}

describe("with the tracker", () => {
  test('h.js is loaded beside the tracker only with data-heatmaps="on"', async () => {
    const off = await runTrackerWithHeatmaps({});
    expect(off.heatmapScript).toBeUndefined();
    const on = await runTrackerWithHeatmaps({ heatmaps: "on" });
    expect(on.heatmapScript?.src).toBe("https://analytics.example.com/h.js");
    expect(Reflect.get(on.heatmapScript ?? {}, HEATMAP_PROPERTY)).toMatchObject({
      endpoint: ENDPOINT,
    });
    const none = await runTrackerWithHeatmaps({ heatmaps: "on", heatmapsSample: "0" });
    expect(none.heatmapScript).toBeUndefined();
  });

  test("clicks and scroll depth belong to the path they happened on in a single-page app", async () => {
    document.body.innerHTML = LAYOUT;
    document.body.style.height = "3000px";
    const first = location.origin + location.pathname;
    const run = await runTrackerWithHeatmaps({ heatmaps: "on" });
    await userEvent.click(element("#go"));
    scrollTo(800);
    history.pushState(null, "", "/plans/team?coupon=SECRETCOUPON");
    await userEvent.click(element("#cta"));
    hide();
    const records = await run.records();
    expect(records.map((record) => [record.type, record.url])).toEqual([
      ["click", first],
      ["scroll", first],
      ["click", `${location.origin}/plans/team`],
      ["scroll", `${location.origin}/plans/team`],
    ]);
  });
});

/** Planted on the page or typed into it: none may leave in a heatmap record. */
const PLANTED = [
  "Wilhelmina",
  "Quarterfield",
  "wilhelmina.q",
  "4111",
  "TOKENLINK8842",
  "TOKENIMG5521",
  "IdSecretOak",
  "ClassSecretElm",
  "TitleSecretOrchid",
  "AltSecretHeron",
  "AriaSecretMaple",
  "DataAttrSecretYew",
  "PlaceholderSecretFern",
  "TypedSecretQuince",
  "TextareaSecretBirch",
  "SelectValueSecretAsh",
  "SelectedSecretLarch",
  "ValueAttrSecretPine",
  "NameAttrSecretHolly",
  "FormActionSecretRowan",
  "SECRETCOUPON",
  "HashSecretLinden",
  "wilhelmina",
  "user-card",
  "ShadowSecretAlder",
  "example.org",
];

const PRIVATE_PAGE = `
  <main id="IdSecretOak" class="ClassSecretElm">
    <h1 title="TitleSecretOrchid">Wilhelmina Quarterfield</h1>
    <a id="link" href="/account?token=TOKENLINK8842" aria-label="AriaSecretMaple">wilhelmina.q@example.org</a>
    <span id="card" data-user="DataAttrSecretYew">4111 1111 1111 1111</span>
    <img id="photo" alt="AltSecretHeron" width="40" height="40" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=#TOKENIMG5521">
    <form action="/save?k=FormActionSecretRowan">
      <input id="text" name="NameAttrSecretHolly" placeholder="PlaceholderSecretFern" value="ValueAttrSecretPine">
      <textarea id="textarea"></textarea>
      <select id="select"><option value="a">Alpha</option><option value="SelectValueSecretAsh">SelectedSecretLarch</option></select>
      <button id="save" type="button" class="ClassSecretElm">Save Wilhelmina</button>
    </form>
    <wilhelmina id="made-up"><a href="/x" style="display:inline-block;width:40px;height:20px">Go</a></wilhelmina>
    <user-card id="custom" style="display:block;width:60px;height:20px">Quarterfield</user-card>
    <section data-ottertrail-name="Wilhelmina@example.org"><a id="bad-name-link" href="/y">Profile</a></section>
    <svg width="40" height="40"><circle cx="20" cy="20" r="18" data-secret="DataAttrSecretYew"></circle></svg>
    <div id="shadow-host" style="display:block;width:100px;height:30px"></div>
    <div data-ottertrail-block>
      ${Array.from({ length: 9 }, (_, index) => `<button id="key-${index + 1}" style="width:30px;height:30px">${index + 1}</button>`).join("")}
    </div>
    <div data-ottertrail-mask><canvas id="signature" width="200" height="60"></canvas></div>
  </main>`;

describe("privacy", () => {
  test("no text, value, ID, class, address, or other attribute of the page is ever sent", async () => {
    history.replaceState(null, "", `${location.pathname}?coupon=SECRETCOUPON#HashSecretLinden`);
    cleanups.push(() => history.replaceState(null, "", ADDRESS));
    document.body.innerHTML = PRIVATE_PAGE;
    document.body.style.height = "3000px";
    const writes: string[] = [];
    const cookie = vi.spyOn(Document.prototype, "cookie", "set").mockImplementation((value) => {
      writes.push(`cookie ${value}`);
    });
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation((name) => {
      writes.push(`storage ${name}`);
    });
    cleanups.push(() => {
      cookie.mockRestore();
      setItem.mockRestore();
    });
    if (customElements.get("user-card") === undefined) {
      customElements.define("user-card", class extends HTMLElement {});
    }
    const host = element("#shadow-host");
    host.attachShadow({ mode: "open" }).innerHTML =
      '<button id="inner" class="ClassSecretElm" style="width:80px;height:20px">ShadowSecretAlder</button>';
    const run = await runTrackerWithHeatmaps({ heatmaps: "on" });
    const recorded = ["h1", "#link", "#card", "#photo", "#text", "#textarea", "#save"];
    // Recorded, with their tags as "x": a made-up tag, a custom element, and a click in a shadow root (its host).
    recorded.push("#made-up a", "#custom", "#bad-name-link", "circle");
    for (const selector of recorded) await userEvent.click(element(selector));
    await userEvent.click(host.shadowRoot?.querySelector("button") ?? host);
    const clicked = recorded.length + 1;
    // Never recorded: inside the site's block and mask markers.
    for (const key of ["#key-7", "#key-3", "#key-1", "#key-9", "#signature"]) {
      await userEvent.click(element(key));
    }
    await userEvent.type(element("#text"), "TypedSecretQuince");
    await userEvent.type(element("#textarea"), "TextareaSecretBirch");
    await userEvent.selectOptions(element("#select"), "SelectValueSecretAsh");
    scrollTo(500);
    hide();
    const bodies = await run.bodies();
    const records = await run.records();
    // Something was sent, so the search below means something.
    expect(records.filter((record) => record.type === "click").length).toBeGreaterThanOrEqual(7);
    expect(records.some((record) => record.type === "scroll")).toBe(true);
    const text = bodies.join("\n");
    expect(PLANTED.filter((value) => text.includes(value))).toEqual([]);
    // Only these fields, ever.
    const fields = new Set(records.flatMap((record) => Object.keys(record)));
    expect(
      [...fields].filter(
        (field) =>
          ![
            "id",
            "type",
            "at",
            "page",
            "url",
            "referrer",
            "element",
            "label",
            "x",
            "y",
            "rage",
            "depth",
            "fold",
            "dropped",
            "vw",
            "vh",
            "ph",
            "device",
          ].includes(field),
      ),
    ).toEqual([]);
    expect(writes).toEqual([]);
    // Clicks in what the site blocks or masks are not recorded at all: not
    // the keypad's keys, nor where on the signature pad.
    const elements = records.flatMap((record) => (record.type === "click" ? [record.element] : []));
    expect(records.filter((record) => record.type === "click")).toHaveLength(clicked);
    // Tags that are not standard HTML or SVG are "x"; SVG's own are kept.
    expect(elements).toEqual(
      expect.arrayContaining([
        "body>main>x>a",
        "body>main>x",
        "body>main>svg>circle",
        "body>main>section>a",
        // The shadow root's button counts for its host.
        "body>main>div",
      ]),
    );
    // Each click's time is to the minute.
    expect(records.every((record) => record.at % TIME_STEP_MS === 0)).toBe(true);
  });

  test("of the page's referrer, only its origin is sent", async () => {
    document.body.innerHTML = LAYOUT;
    const heat = capture({
      page: { ...PAGE, referrer: "https://news.example/users/ReferrerSecretBeech/feed" },
    });
    click(element("#go"));
    hide();
    await heat.settle();
    const text = JSON.stringify(heat.sent.map((batch) => batch.body));
    expect(text).not.toContain("ReferrerSecretBeech");
    expect(heat.sent[0]?.body.pages).toEqual([{ url: PAGE.url, referrer: "https://news.example" }]);
  });
});
