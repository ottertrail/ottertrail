/**
 * The tracker's options in headless Chromium, run as its tag would run it:
 * hash routes, manual pageviews, the before-send hook, events from HTML
 * attributes, and ignoring the owner's own browser. Each case checks what
 * leaves for /api/events, and the privacy cases check that it never
 * carries a token from the fragment, or that nothing leaves at all.
 */
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser/context";

import type { QueuedEvent } from "../../src/tracker.ts";

const HOST = "https://ottertrail.example.com";

interface Sent {
  url: string;
  body: string;
  keepalive: boolean;
}

const cleanups: (() => void)[] = [];
/** The test page's own address, which the tests change and put back. */
const ADDRESS = location.pathname + location.search;
// Links in the fixtures must not leave the test page.
const stayOnPage = (event: Event) => event.preventDefault();
document.addEventListener("click", stayOnPage);
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
  history.replaceState(null, "", ADDRESS);
  document.body.innerHTML = "";
});

function hide() {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
  document.dispatchEvent(new Event("visibilitychange"));
  Reflect.deleteProperty(document, "visibilityState");
}

/** hashchange fires as a task after the fragment changes: wait for it. */
async function setHash(hash: string) {
  const changed = new Promise((resolve) => {
    window.addEventListener("hashchange", resolve, { once: true });
  });
  location.hash = hash;
  await changed;
}

let runs = 0;

/**
 * Runs the tracker as its tag would, with these attributes. Records every
 * request and beacon of the page, every script it adds, and this run's
 * events: earlier runs' trackers stay on the page with their own keys.
 */
async function runTracker(attributes: Record<string, string>) {
  Reflect.deleteProperty(window, "ottertrail");
  runs += 1;
  const key = `pk_${String(runs).padStart(32, "0")}`;
  const requests: Sent[] = [];
  const scripts: HTMLScriptElement[] = [];
  const reading: Promise<unknown>[] = [];
  const append = vi.spyOn(document.head, "append").mockImplementation((...nodes) => {
    for (const node of nodes) if (node instanceof HTMLScriptElement) scripts.push(node);
  });
  const realFetch = globalThis.fetch;
  const realBeacon = navigator.sendBeacon.bind(navigator);
  globalThis.fetch = async (input, init) => {
    requests.push({
      url: input instanceof Request ? input.url : input.toString(),
      body: typeof init?.body === "string" ? init.body : "",
      keepalive: init?.keepalive === true,
    });
    return new Response(null, { status: 202 });
  };
  navigator.sendBeacon = (url, data) => {
    if (data instanceof Blob) {
      reading.push(
        data.text().then((body) => requests.push({ url: String(url), body, keepalive: true })),
      );
    }
    return true;
  };
  cleanups.push(() => {
    append.mockRestore();
    globalThis.fetch = realFetch;
    navigator.sendBeacon = realBeacon;
    Reflect.deleteProperty(window, "ottertrail");
  });
  const tag = document.createElement("script");
  tag.src = `${HOST}/t.js`;
  Object.assign(tag.dataset, { key, host: HOST, vitals: "off", errors: "off", ...attributes });
  Object.defineProperty(document, "currentScript", { configurable: true, get: () => tag });
  try {
    await import(/* @vite-ignore */ `../../src/script.ts?run=${runs}`);
  } finally {
    Reflect.deleteProperty(document, "currentScript");
  }
  const mine = async () => {
    await Promise.all(reading);
    return requests.filter((request) => request.body.includes(key));
  };
  return {
    scripts,
    /** Every request and beacon on the page while this run lasted, any tracker's. */
    requests: async () => {
      await Promise.all(reading);
      return requests;
    },
    mine,
    /** This run's events, each once: a request in flight as the page hides goes again. */
    events: async () => {
      const seen = new Set<string>();
      return (await mine())
        .flatMap((request) => (JSON.parse(request.body) as { events: QueuedEvent[] }).events)
        .filter((event) => !seen.has(event.id) && seen.add(event.id));
    },
  };
}

const pageAt = (path: string) => `${location.origin}${path}`;

describe("hash routes", () => {
  test('with data-hash-routes="on", each route is a pageview, and a token in the fragment never leaves', async () => {
    history.replaceState(null, "", "/app/#/pricing?plan=team");
    const run = await runTracker({ hashRoutes: "on" });
    await setHash("#/docs");
    await setHash("#/docs?tab=2");
    await setHash("#access_token=TOKEN7731&token_type=bearer");
    await setHash("#/callback&code=CODE5512");
    window.ottertrail?.track("signup");
    hide();

    const events = await run.events();
    expect(events.map((event) => [event.name, event.url])).toEqual([
      ["pageview", pageAt("/app/#/pricing")],
      ["pageview", pageAt("/app/#/docs")],
      ["pageview", pageAt("/app/")],
      ["signup", pageAt("/app/")],
    ]);
    const sent = (await run.mine()).map((request) => request.body).join("\n");
    expect(sent).not.toContain("TOKEN7731");
    expect(sent).not.toContain("CODE5512");
    expect(sent).not.toContain("plan=team");
  });

  test("without it, a hash change is no pageview and no fragment leaves", async () => {
    history.replaceState(null, "", "/app/#/pricing");
    const run = await runTracker({});
    await setHash("#/docs");
    hide();

    expect((await run.events()).map((event) => [event.name, event.url])).toEqual([
      ["pageview", pageAt("/app/")],
    ]);
  });
});

describe("manual pageviews", () => {
  test('with data-pageviews="manual", only pageview() records, with the path given', async () => {
    history.replaceState(null, "", "/products/42?utm_source=news&session=SESSION9921");
    const run = await runTracker({ pageviews: "manual" });
    history.pushState(null, "", "/products/43?utm_source=news&session=SESSION9921");
    window.ottertrail?.pageview("/products/:id");
    hide();

    expect((await run.events()).map((event) => [event.name, event.url])).toEqual([
      ["pageview", pageAt("/products/:id?utm_source=news")],
    ]);
    expect((await run.mine()).map((request) => request.body).join()).not.toContain("SESSION");
  });
});

describe("the before-send hook", () => {
  test("applies to the first pageview, and a hook that throws breaks nothing and loses no other event", async () => {
    history.replaceState(null, "", "/users/42");
    const errors: unknown[] = [];
    const onError = (event: ErrorEvent) => errors.push(event.error);
    window.addEventListener("error", onError);
    cleanups.push(() => window.removeEventListener("error", onError));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    cleanups.push(() => warn.mockRestore());
    Object.assign(window, {
      ottertrailBeforeSend: (event: { name: string; url: string }) => {
        if (event.name === "broken") throw new Error("hook bug");
        return { ...event, url: event.url.replace(/\/users\/\d+/, "/users/:id") };
      },
    });
    cleanups.push(() => Reflect.deleteProperty(window, "ottertrailBeforeSend"));
    const run = await runTracker({ beforeSend: "ottertrailBeforeSend" });
    window.ottertrail?.track("broken");
    window.ottertrail?.track("signup");
    hide();

    expect((await run.events()).map((event) => [event.name, event.url])).toEqual([
      ["pageview", pageAt("/users/:id")],
      ["signup", pageAt("/users/:id")],
    ]);
    expect(errors).toEqual([]);
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe("events from HTML attributes", () => {
  test("a click on a marked link that leaves the page sends its event at once, in a keepalive request", async () => {
    history.replaceState(null, "", "/pricing");
    document.body.innerHTML = `
      <a id="docs" href="https://docs.example.org/start?ref=x"
         data-ottertrail-event="Read docs" data-ottertrail-event-plan="pro"
         data-ottertrail-name="docs-link" class="SECRETCLASS">Read <b>the docs</b></a>
      <button id="signup" data-ottertrail-event="Signup" data-ottertrail-event-plan="team">Sign up</button>`;
    const run = await runTracker({});
    await userEvent.click(document.querySelector("#docs b") ?? document.body);

    // Before any timer: one request with both, made to outlive the page.
    const [first, ...more] = await run.mine();
    expect(more).toEqual([]);
    expect(first?.keepalive).toBe(true);
    const events = (JSON.parse(first?.body ?? "{}") as { events: QueuedEvent[] }).events;
    expect(events.map((event) => [event.name, event.properties])).toEqual([
      ["pageview", undefined],
      ["outbound_link", { url: "https://docs.example.org/start" }],
      ["Read docs", { plan: "pro" }],
    ]);

    await userEvent.click(document.querySelector("#signup") ?? document.body);
    hide();
    expect((await run.events()).map((event) => [event.name, event.properties])).toContainEqual([
      "Signup",
      { plan: "team" },
    ]);
    const sent = (await run.mine()).map((request) => request.body).join();
    expect(sent).not.toContain("SECRETCLASS");
    expect(sent).not.toContain("docs-link");
    expect(sent).not.toContain("Sign up");
  });
});

describe("ignoring the owner's own browser", () => {
  test('with localStorage.ottertrail_ignore = "true", nothing at all leaves, no script loads, and nothing is written', async () => {
    localStorage.clear();
    localStorage.setItem("ottertrail_ignore", "true");
    cleanups.push(() => localStorage.removeItem("ottertrail_ignore"));
    const cookies = document.cookie;
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    cleanups.push(() => info.mockRestore());
    document.body.innerHTML = `
      <a id="out" href="https://example.org/" data-ottertrail-event="Out">Out</a>
      <button id="cta">Buy</button>`;
    const run = await runTracker({ heatmaps: "on", replay: "errors", traces: "on", errors: "on" });
    await userEvent.click(document.querySelector("#out") ?? document.body);
    await userEvent.click(document.querySelector("#cta") ?? document.body);
    window.ottertrail?.track("signup");
    window.ottertrail?.pageview("/other");
    window.ottertrail?.captureError(new Error("failed"));
    window.ottertrail?.replay(true);
    history.pushState(null, "", "/next");
    hide();
    await window.ottertrail?.flush();
    await new Promise((resolve) => setTimeout(resolve, 1200));

    expect(await run.mine()).toEqual([]);
    expect(run.scripts).toEqual([]);
    expect(Object.keys(localStorage)).toEqual(["ottertrail_ignore"]);
    expect(sessionStorage).toHaveLength(0);
    expect(document.cookie).toBe(cookies);
    expect(info).toHaveBeenCalledOnce();
  });
});
