/**
 * The heatmap overlay (o.js) in headless Chromium: finding elements by
 * their keys, the closed shadow root, its states, data drawn as text and
 * shapes only, and, run as the tracker loads it, a page opened from the
 * dashboard: the link leaves the address, nothing is sent, and o.js is
 * loaded with the tracker's nonce.
 */
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser/context";

import { describe as keyOf, resolve } from "../../src/heatmap-path.ts";
import { OVERLAY_PROPERTY } from "../../src/overlay-names.ts";
import { MESSAGES, type OverlayState, startOverlay } from "../../src/overlay-view.ts";

const HOST = "https://analytics.example.com";
const PROJECT = "0b7c6a1e-1f2a-4c3d-8e9f-0a1b2c3d4e5f";
const LINK = "L".repeat(43);
const SESSION = "S".repeat(43);
const ADDRESS = location.pathname + location.search;

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
  document.body.innerHTML = "";
  document.body.style.height = "";
  history.replaceState(null, "", ADDRESS);
  window.scrollTo(0, 0);
});

const element = (selector: string) => {
  const found = document.querySelector(selector);
  if (found === null) throw new Error(`${selector} is not on the page`);
  return found;
};

describe("finding an element by its key", () => {
  const PAGE = `
    <header><nav><a id="home" href="#">Home</a><a id="pricing" href="#">Pricing</a><a id="docs" href="#">Docs</a></nav></header>
    <main>
      <section data-ottertrail-name="plans">
        <div><a id="team" href="#">Team</a></div>
        <div><a id="business" href="#">Business</a><span><user-card id="card">Card</user-card><other-card id="other">Other</other-card></span></div>
      </section>
      <section><p>Text</p><p><button id="second-p">Go</button></p></section>
      <div id="deep"></div>
    </main>`;

  test("every element's key, as capture writes it, finds that element again", () => {
    document.body.innerHTML = PAGE;
    // Deeper than the 24 steps a key keeps: its key is cut, "*>" first.
    let deep = element("#deep");
    for (let level = 0; level < 30; level += 1)
      deep = deep.appendChild(document.createElement("div"));
    deep.id = "bottom";
    const keys = new Map<string, Element[]>();
    for (const node of document.body.querySelectorAll("*")) {
      const key = keyOf(node);
      const id = `${key.label ?? ""}\u0000${key.element}`;
      keys.set(id, [...(keys.get(id) ?? []), node]);
    }
    for (const [id, nodes] of keys) {
      const [label, path] = id.split("\u0000") as [string, string];
      const found = resolve(document, label === "" ? null : label, path);
      // A key two elements share (two unknown tags at one place) finds the first.
      expect({ id, found: found === nodes[0] }).toEqual({ id, found: true });
    }
    expect(keyOf(element("#bottom")).element.startsWith("*>")).toBe(true);
  });

  test("by its place among siblings and from the nearest name; a missing one is null", () => {
    document.body.innerHTML = PAGE;
    expect(resolve(document, null, "body>header>nav>a:2")).toBe(element("#pricing"));
    expect(resolve(document, null, "body>main>section:2>p:2>button")).toBe(element("#second-p"));
    expect(resolve(document, "plans", "section>div:2>a")).toBe(element("#business"));
    expect(resolve(document, "plans", "section>div:2>span>x:1")).toBe(null);
    expect(resolve(document, "plans", "section>div:2>span>x")).toBe(element("#card"));
    // Gone from the page, a name not on it, or a key a named element would have cut short.
    expect(resolve(document, null, "body>header>nav>a:4")).toBe(null);
    expect(resolve(document, "pricing-table", "section>div>a")).toBe(null);
    expect(resolve(document, null, "body>main>section>div>a")).toBe(null);
  });
});

interface Call {
  url: string;
  init: RequestInit;
}

/** The API as o.js sees it: answers for the exchange and for reads, and the calls made. */
function fakeApi({
  exchange = () => json(200, { token: SESSION, projectId: PROJECT, expiresAt: "" }),
  read = () => json(200, heatmap()),
}: {
  exchange?: () => Promise<Response>;
  read?: (url: URL) => Promise<Response>;
} = {}) {
  const calls: Call[] = [];
  const fetch = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async (url, init) => {
    calls.push({ url, init });
    return url.endsWith("/session") ? exchange() : read(new URL(url));
  });
  return { calls, fetch };
}

const json = async (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function heatmap(overrides: Record<string, unknown> = {}) {
  return {
    path: location.pathname,
    device: "desktop",
    period: "30d",
    environment: "production",
    firstDay: "2026-10-22",
    lastDay: "2026-11-20",
    clipped: false,
    totals: { pageviews: 12, clicks: 9, rageClicks: 1 },
    devices: [{ device: "desktop", pageviews: 12 }],
    reach: Array.from({ length: 20 }, (_, index) => ({
      depth: (index + 1) * 5,
      share: 1 - index * 0.04,
    })),
    elements: [],
    ...overrides,
  };
}

/** Opens the overlay with these answers; its shadow root, caught as it is attached. */
function open(api = fakeApi(), environment?: string) {
  const states: OverlayState[] = [];
  // Called through: the spy only keeps what the overlay asked for and got.
  const spy = vi.spyOn(Element.prototype, "attachShadow");
  const overlay = startOverlay(
    { host: HOST, token: LINK, ...(environment === undefined ? {} : { environment }) },
    { window, document, fetch: api.fetch, onState: (state) => states.push(state) },
  );
  const mode = spy.mock.calls[0]?.[0].mode;
  const root = spy.mock.results[0]?.value as ShadowRoot | undefined;
  spy.mockRestore();
  cleanups.push(overlay.close);
  const shadow = () => {
    if (root === undefined) throw new Error("no shadow root");
    return root;
  };
  return {
    overlay,
    api,
    states,
    mode: () => mode,
    root: shadow,
    status: () => shadow().querySelector<HTMLElement>("[role=status]"),
    button: (name: string) =>
      [...shadow().querySelectorAll("button")].find(
        (button) => button.textContent === name || button.getAttribute("aria-label") === name,
      ),
    settled: (state: OverlayState) => vi.waitFor(() => expect(overlay.state()).toBe(state)),
  };
}

describe("the overlay", () => {
  test("draws in a closed shadow root that lets the page's clicks through", async () => {
    document.body.innerHTML = `<button id="cta" style="margin:100px">Buy</button>`;
    let clicked = 0;
    element("#cta").addEventListener("click", () => (clicked += 1));
    const view = open();
    await view.settled("ready");
    expect(view.mode()).toBe("closed");
    const host = document.querySelector("ottertrail-heatmap");
    expect(host).not.toBeNull();
    expect(host?.shadowRoot).toBeNull();
    // Nothing of it is reachable from the page's DOM.
    expect(document.querySelectorAll("canvas, aside")).toHaveLength(0);
    expect(getComputedStyle(host as Element).pointerEvents).toBe("none");
    await userEvent.click(element("#cta"));
    expect(clicked).toBe(1);
  });

  test("exchanges the link once, then reads with the session as Bearer, never in the address", async () => {
    const view = open(fakeApi(), "staging");
    await view.settled("ready");
    const [exchange, read] = view.api.calls;
    expect(exchange?.url).toBe(`${HOST}/api/heatmap-overlay/session`);
    expect(exchange?.init).toMatchObject({
      method: "POST",
      credentials: "omit",
      cache: "no-store",
    });
    const body = exchange?.init.body;
    expect(JSON.parse(typeof body === "string" ? body : "")).toEqual({ token: LINK });
    const url = new URL(read?.url ?? "");
    expect(url.origin + url.pathname).toBe(`${HOST}/api/heatmap-overlay/${PROJECT}/heatmap`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      path: location.pathname,
      device: "desktop",
      period: "30d",
      environment: "staging",
    });
    expect(read?.url).not.toContain(SESSION);
    expect(read?.init).toMatchObject({
      credentials: "omit",
      headers: { authorization: `Bearer ${SESSION}` },
    });
    // Another device or period reads again with the same session, never exchanging again.
    view.button("Mobile")?.click();
    await vi.waitFor(() => expect(view.api.calls).toHaveLength(3));
    expect(new URL(view.api.calls[2]?.url ?? "").searchParams.get("device")).toBe("mobile");
    expect(view.button("Mobile")?.getAttribute("aria-pressed")).toBe("true");
    expect(view.button("Desktop")?.getAttribute("aria-pressed")).toBe("false");
    const select = view.root().querySelector("select") as HTMLSelectElement;
    select.value = "7d";
    select.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(view.api.calls).toHaveLength(4));
    expect(new URL(view.api.calls[3]?.url ?? "").searchParams.get("period")).toBe("7d");
    expect(view.api.calls.filter((call) => call.url.endsWith("/session"))).toHaveLength(1);
  });

  test("defaults to the device class of the window's width", async () => {
    const { page } = await import("vite-plus/test/browser/context");
    await page.viewport(800, 900);
    cleanups.push(() => void page.viewport(1280, 900));
    const view = open();
    await view.settled("ready");
    expect(view.button("Tablet")?.getAttribute("aria-pressed")).toBe("true");
    expect(new URL(view.api.calls[1]?.url ?? "").searchParams.get("device")).toBe("tablet");
  });

  test("dots on each element found, at its clicks' cells; those not found are listed with their clicks", async () => {
    document.body.innerHTML = `
      <main><section data-ottertrail-name="hero">
        <a id="cta" href="#" style="display:block;position:absolute;left:200px;top:120px;width:160px;height:80px">Start</a>
      </section></main>`;
    const cta = keyOf(element("#cta"));
    const view = open(
      fakeApi({
        read: () =>
          json(
            200,
            heatmap({
              elements: [
                {
                  label: cta.label,
                  element: cta.element,
                  clicks: 5,
                  rageClicks: 0,
                  cells: [[2, 3, 5]],
                },
                {
                  label: null,
                  element: "body>footer>a:3",
                  clicks: 2,
                  rageClicks: 0,
                  cells: [[0, 0, 2]],
                },
              ],
            }),
          ),
      }),
    );
    await view.settled("ready");
    const canvas = view.root().querySelector("canvas") as HTMLCanvasElement;
    const context = canvas.getContext("2d") as CanvasRenderingContext2D;
    const ratio = window.devicePixelRatio || 1;
    const alphaAt = (x: number, y: number) =>
      context.getImageData(Math.round(x * ratio), Math.round(y * ratio), 1, 1).data[3] ?? 0;
    const box = element("#cta").getBoundingClientRect();
    // The cell's middle: column 2 and row 3 of 8.
    expect(
      alphaAt(box.left + (2.5 / 8) * box.width, box.top + (3.5 / 8) * box.height),
    ).toBeGreaterThan(100);
    // Another cell of the element, without clicks: nothing drawn there.
    expect(alphaAt(box.left + (6.5 / 8) * box.width, box.top + (6.5 / 8) * box.height)).toBe(0);
    const missing = view.root().querySelector("details") as HTMLDetailsElement;
    expect(missing.hidden).toBe(false);
    expect(missing.querySelector("summary")?.textContent).toBe("Not on this page (1)");
    expect([...missing.querySelectorAll("li")].map((item) => item.textContent)).toEqual([
      "footer > a:3: 2 clicks",
    ]);
    expect(view.root().querySelector(".totals")?.textContent).toBe(
      "12 pageviews · 9 clicks · 1 rage click",
    );
    // The page changes: the element goes, and is listed.
    element("#cta").remove();
    await vi.waitFor(() =>
      expect(missing.querySelector("summary")?.textContent).toBe("Not on this page (2)"),
    );
  });

  test("after an in-app navigation to another path, draws nothing and says whose heatmap it is", async () => {
    document.body.innerHTML = `<a id="cta" href="#" style="display:block;position:absolute;left:200px;top:120px;width:160px;height:80px">Start</a>`;
    const cta = keyOf(element("#cta"));
    const view = open(
      fakeApi({
        read: () =>
          json(
            200,
            heatmap({
              elements: [
                { label: null, element: cta.element, clicks: 5, rageClicks: 0, cells: [[2, 3, 5]] },
              ],
            }),
          ),
      }),
    );
    await view.settled("ready");
    const canvas = view.root().querySelector("canvas") as HTMLCanvasElement;
    const painted = () =>
      (canvas.getContext("2d") as CanvasRenderingContext2D)
        .getImageData(0, 0, canvas.width, canvas.height)
        .data.some((value, index) => index % 4 === 3 && value > 0);
    expect(painted()).toBe(true);
    const path = location.pathname;
    history.pushState(null, "", "/somewhere-else");
    document.body.append(document.createElement("p"));
    await vi.waitFor(() =>
      expect(view.status()?.textContent).toBe(
        `This heatmap is for ${path}. Go back to that page to see it.`,
      ),
    );
    expect(painted()).toBe(false);
  });

  test("data with HTML in it is shown as text, never as markup", async () => {
    // Within the 64 characters a name may have.
    const planted = `<img src=x onerror="window.overlayPwned=1"><b id=bold>b</b>`;
    const view = open(
      fakeApi({
        read: () =>
          json(
            200,
            heatmap({
              firstDay: planted,
              elements: [
                {
                  label: planted,
                  element: `body>${planted}`,
                  clicks: 3,
                  rageClicks: 1,
                  cells: [[1, 1, 3]],
                },
              ],
            }),
          ),
      }),
    );
    await view.settled("ready");
    const item = view.root().querySelector("li");
    expect(item?.textContent).toBe(`${planted}: 3 clicks`);
    expect(view.root().querySelectorAll("img, b")).toHaveLength(0);
    expect(document.querySelectorAll("#bold")).toHaveLength(0);
    await new Promise((done) => setTimeout(done, 50));
    expect(Reflect.get(window, "overlayPwned")).toBeUndefined();
  });

  test.each([
    { name: "a link used or expired", exchange: () => json(410, {}), state: "link_expired" },
    { name: "an account without access", exchange: () => json(403, {}), state: "no_access" },
    {
      name: "access lost since",
      read: () => json(403, { error: "forbidden" }),
      state: "no_access",
    },
    { name: "a session that ended", read: () => json(401, {}), state: "session_expired" },
  ] as const)("$name: says so, and how to go on", async ({ exchange, read, state }) => {
    const view = open(
      fakeApi({
        ...(exchange === undefined ? {} : { exchange }),
        ...(read === undefined ? {} : { read }),
      }),
    );
    await view.settled(state);
    expect(view.status()?.textContent).toBe(MESSAGES[state]);
    expect(view.status()?.hidden).toBe(false);
    // Nothing to choose any more, and nothing to retry.
    expect(view.button("Retry")?.hidden).toBe(true);
    expect(view.root().querySelector("select")?.closest(".row")?.hasAttribute("hidden")).toBe(true);
    expect(view.states).toEqual(["loading", state]);
  });

  test("the expired and no-access messages say what to do", () => {
    expect(MESSAGES.link_expired).toContain("Open it again from the dashboard");
    expect(MESSAGES.session_expired).toContain("30 minutes");
    expect(MESSAGES.no_access).toContain("cannot view");
  });

  test("nothing recorded for the page says so", async () => {
    const view = open(
      fakeApi({
        read: () => json(200, heatmap({ totals: { pageviews: 0, clicks: 0, rageClicks: 0 } })),
      }),
    );
    await view.settled("empty");
    expect(view.status()?.textContent).toBe(
      "Nothing recorded for this page on desktop in the last 30 days.",
    );
  });

  test("a failure offers Retry, which tries again", async () => {
    let fail = true;
    const view = open(
      fakeApi({
        read: async () => {
          if (fail) throw new TypeError("Failed to fetch");
          return json(200, heatmap());
        },
      }),
    );
    await view.settled("failed");
    expect(view.status()?.textContent).toBe(MESSAGES.failed);
    const retry = view.button("Retry");
    expect(retry?.hidden).toBe(false);
    fail = false;
    retry?.click();
    await view.settled("ready");
    // The session is kept: the link was used once.
    expect(view.api.calls.filter((call) => call.url.endsWith("/session"))).toHaveLength(1);
  });

  test("the panel is reachable by keyboard and closes, taking the overlay away", async () => {
    document.body.innerHTML = `<a id="first" href="#">First</a>`;
    const view = open();
    await view.settled("ready");
    (element("#first") as HTMLElement).focus();
    await userEvent.tab();
    // The first control of the panel, inside the shadow root.
    expect(view.root().activeElement?.getAttribute("aria-label")).toBe("Close the heatmap");
    await userEvent.keyboard("{Enter}");
    expect(document.querySelector("ottertrail-heatmap")).toBeNull();
  });
});

/** Runs a script of src/ as the page's script element `script` would. */
async function run(script: HTMLScriptElement, file: string) {
  Object.defineProperty(document, "currentScript", { configurable: true, get: () => script });
  try {
    await import(/* @vite-ignore */ `../../src/${file}?overlay=${Date.now()}`);
  } finally {
    Reflect.deleteProperty(document, "currentScript");
  }
}

describe("opened from the dashboard, with the tracker", () => {
  test("the link leaves the address, nothing is sent, and o.js runs with the tracker's nonce", async () => {
    Reflect.deleteProperty(window, "ottertrail");
    history.replaceState(null, "", `${ADDRESS}#ottertrail-heatmap=${LINK}`);
    const scripts: HTMLScriptElement[] = [];
    const append = vi.spyOn(document.head, "append").mockImplementation((...nodes) => {
      for (const node of nodes) if (node instanceof HTMLScriptElement) scripts.push(node);
    });
    const api = fakeApi();
    const sent: string[] = [];
    const realFetch = globalThis.fetch;
    const realBeacon = navigator.sendBeacon.bind(navigator);
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      return url.includes("/api/heatmap-overlay/")
        ? api.fetch(url, init ?? {})
        : (sent.push(url), new Response(null, { status: 202 }));
    };
    navigator.sendBeacon = (url) => {
      sent.push(String(url));
      return true;
    };
    cleanups.push(() => {
      append.mockRestore();
      globalThis.fetch = realFetch;
      navigator.sendBeacon = realBeacon;
      Reflect.deleteProperty(window, "ottertrail");
      document.querySelector("ottertrail-heatmap")?.remove();
    });
    const tag = document.createElement("script");
    tag.src = `${HOST}/t.js`;
    tag.nonce = "n0nce";
    Object.assign(tag.dataset, {
      key: `pk_${"9".repeat(32)}`,
      host: HOST,
      heatmaps: "on",
      replay: "errors",
    });
    await run(tag, "script.ts");
    expect(location.hash).toBe("");
    expect(location.pathname + location.search).toBe(ADDRESS);
    expect(scripts.map((script) => script.src)).toEqual([`${HOST}/o.js`]);
    const overlayScript = scripts[0] as HTMLScriptElement;
    expect(overlayScript.nonce).toBe("n0nce");
    expect(Reflect.get(overlayScript, OVERLAY_PROPERTY)).toMatchObject({ host: HOST, token: LINK });

    await run(overlayScript, "overlay.ts");
    await vi.waitFor(() => expect(api.calls).toHaveLength(2));
    expect(document.querySelector("ottertrail-heatmap")).not.toBeNull();
    window.ottertrail?.track("signup");
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("pagehide"));
    await new Promise((done) => setTimeout(done, 50));
    expect(sent).toEqual([]);
  });
});
