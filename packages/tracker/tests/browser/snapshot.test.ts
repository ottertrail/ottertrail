/**
 * Saved heatmap views in headless Chromium, with the real rrweb: "Save
 * this view" in the overlay (o.js), s.js loaded only when it is pressed,
 * with the overlay's nonce, the snapshot taken with typed values masked
 * and the overlay left out, sent with the overlay's session, and the size
 * cap (docs/web-analytics.md, "Saved views").
 */
import { afterEach, describe, expect, test, vi } from "vite-plus/test";

import { OVERLAY_TAG } from "../../src/overlay-names.ts";
import { type OverlayState, SAVE_MESSAGES, startOverlay } from "../../src/overlay-view.ts";
import {
  SNAPSHOT_PROPERTY,
  type SnapshotConfig,
  type SnapshotResult,
  type TakeSnapshot,
} from "../../src/snapshot-names.ts";
import { takeSnapshot } from "../../src/snapshot-take.ts";

const HOST = "https://analytics.example.com";
const PROJECT = "0b7c6a1e-1f2a-4c3d-8e9f-0a1b2c3d4e5f";
const LINK = "L".repeat(43);
const SESSION = "S".repeat(43);

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
  document.body.innerHTML = "";
  for (const script of document.head.querySelectorAll("script[src$='/s.js']")) script.remove();
});

const json = async (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const HEATMAP = {
  firstDay: "2026-10-22",
  lastDay: "2026-11-20",
  totals: { pageviews: 3, clicks: 2, rageClicks: 0, deadClicks: 0 },
  reach: [],
  elements: [],
};

interface Call {
  url: string;
  init: RequestInit;
}

/** The API as o.js sees it, with the answer to a save. */
function fakeApi({
  snapshots = true,
  canSave = true,
  save = () => json(201, { path: location.pathname, device: "desktop" }),
}: { snapshots?: boolean; canSave?: boolean; save?: () => Promise<Response> } = {}) {
  const calls: Call[] = [];
  const fetch = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith("/session")) {
      return json(200, { token: SESSION, projectId: PROJECT, expiresAt: "", snapshots, canSave });
    }
    return url.includes("/snapshot?") ? save() : json(200, HEATMAP);
  });
  return { calls, fetch };
}

/** Opens the overlay; its closed shadow root, caught as it is attached. */
function open(
  api = fakeApi(),
  extra: { loadSnapshot?: () => Promise<TakeSnapshot>; nonce?: string } = {},
) {
  const states: OverlayState[] = [];
  const spy = vi.spyOn(Element.prototype, "attachShadow");
  const overlay = startOverlay(
    { host: HOST, token: LINK, settled: () => true },
    {
      window,
      document,
      fetch: api.fetch,
      onState: (state) => states.push(state),
      scriptUrl: `${HOST}/o.js`,
      ...extra,
    },
  );
  const root = spy.mock.results[0]?.value as ShadowRoot;
  spy.mockRestore();
  cleanups.push(overlay.close);
  const save = () =>
    [...root.querySelectorAll("button")].find((button) => button.textContent === "Save this view");
  const said = () => root.querySelector<HTMLElement>(".saved");
  return { overlay, api, root, save, said, states };
}

const settled = (view: ReturnType<typeof open>, state: OverlayState) =>
  vi.waitFor(() => expect(view.overlay.state()).toBe(state));

/** The snapshot as the API reads it: gunzipped JSON. */
async function unpack(body: Uint8Array<ArrayBuffer>): Promise<string> {
  const stream = new Blob([body]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}

const takenOk = (result: SnapshotResult) => {
  if (!result.ok) throw new Error(`no snapshot: ${result.reason}`);
  return result;
};

describe("the Save control", () => {
  test("is in the overlay's panel, and s.js loads only when it is pressed, with the nonce", async () => {
    const view = open(fakeApi(), { nonce: "n0nce" });
    await settled(view, "ready");
    expect(view.save()).toBeDefined();
    expect(view.save()?.hidden).toBe(false);
    // Nothing of it outside the overlay's closed shadow root, and no s.js yet.
    expect(document.querySelectorAll("button")).toHaveLength(0);
    expect(document.querySelector("script[src$='/s.js']")).toBeNull();

    view.save()?.click();
    const script = await vi.waitFor(() => {
      const found = document.head.querySelector<HTMLScriptElement>("script[src$='/s.js']");
      if (found === null) throw new Error("s.js was not added");
      return found;
    });
    expect(script.src).toBe(`${HOST}/s.js`);
    expect(script.nonce).toBe("n0nce");
    const handoff = Reflect.get(script, SNAPSHOT_PROPERTY) as SnapshotConfig;
    expect(typeof handoff.ready).toBe("function");
    // Another script of the page cannot hand over a function of its own.
    handoff.ready(async () => ({ ok: false, reason: "failed" }));
    // s.js as it runs: it hands back the function that takes the snapshot.
    Object.defineProperty(document, "currentScript", { configurable: true, get: () => script });
    try {
      handoff.ready((hide) => takeSnapshot({ hide }));
    } finally {
      Reflect.deleteProperty(document, "currentScript");
    }
    await vi.waitFor(() => expect(view.said()?.textContent).toBe(SAVE_MESSAGES.saved("desktop")));
    expect(view.api.calls.filter((call) => call.url.includes("/snapshot?"))).toHaveLength(1);
  });

  test("sends the snapshot with the overlay's session, for the page it is on", async () => {
    document.body.innerHTML = `<main><h1>Pricing</h1><input id="email" value=""></main>`;
    const view = open(fakeApi(), { loadSnapshot: async () => (hide) => takeSnapshot({ hide }) });
    await settled(view, "ready");
    view.save()?.click();
    await vi.waitFor(() => expect(view.said()?.dataset.tone).toBe(""));
    const call = view.api.calls.find((item) => item.url.includes("/snapshot?"));
    const url = new URL(call?.url ?? "");
    expect(url.origin + url.pathname).toBe(`${HOST}/api/heatmap-overlay/${PROJECT}/snapshot`);
    expect(Object.fromEntries(url.searchParams)).toEqual({ path: location.pathname });
    expect(call?.url).not.toContain(SESSION);
    expect(call?.init).toMatchObject({
      method: "POST",
      credentials: "omit",
      headers: { authorization: `Bearer ${SESSION}`, "content-type": "application/gzip" },
    });
    const snapshot = JSON.parse(await unpack(call?.init.body as Uint8Array<ArrayBuffer>));
    expect(snapshot.v).toBe(1);
    expect(snapshot.events.map((event: { type: number }) => event.type).slice(0, 2)).toEqual([
      4, 2,
    ]);
  });

  test("without object storage on the server, it says so and offers no button", async () => {
    const view = open(fakeApi({ snapshots: false }));
    await settled(view, "ready");
    expect(view.save()?.hidden).toBe(true);
    expect(view.said()?.textContent).toBe(SAVE_MESSAGES.no_storage);
  });

  test("for a member, it says only the owner and admins save a view, and offers no button", async () => {
    const view = open(fakeApi({ canSave: false }));
    await settled(view, "ready");
    expect(view.save()?.hidden).toBe(true);
    expect(view.said()?.textContent).toBe(SAVE_MESSAGES.not_allowed);
    expect(view.said()?.dataset.tone).toBe("");
  });

  test("refused as no longer the owner or an admin, the button goes", async () => {
    const view = open(fakeApi({ save: () => json(403, { error: "forbidden" }) }), {
      loadSnapshot: async () => (hide) => takeSnapshot({ hide }),
    });
    await settled(view, "ready");
    view.save()?.click();
    await vi.waitFor(() => expect(view.said()?.textContent).toBe(SAVE_MESSAGES.not_allowed));
    expect(view.save()?.hidden).toBe(true);
    expect(view.overlay.state()).toBe("ready");
  });

  test.each([
    [400, { error: "snapshot_too_deep" }, SAVE_MESSAGES.too_deep],
    [409, { error: "object_store_not_set_up" }, SAVE_MESSAGES.no_storage],
    [403, { error: "wrong_page" }, SAVE_MESSAGES.wrong_page],
    [413, { error: "snapshot_too_large" }, SAVE_MESSAGES.too_large],
    [503, { error: "storage_unavailable" }, SAVE_MESSAGES.failed],
  ])("a %i answer says why", async (status, body, message) => {
    const view = open(fakeApi({ save: () => json(status, body) }), {
      loadSnapshot: async () => (hide) => takeSnapshot({ hide }),
    });
    await settled(view, "ready");
    view.save()?.click();
    await vi.waitFor(() => expect(view.said()?.textContent).toBe(message));
    expect(view.said()?.dataset.tone).toBe("problem");
    expect(view.save()?.disabled).toBe(false);
  });

  test("a session that ended says so, as reads do", async () => {
    const view = open(fakeApi({ save: () => json(401, { error: "session_expired" }) }), {
      loadSnapshot: async () => (hide) => takeSnapshot({ hide }),
    });
    await settled(view, "ready");
    view.save()?.click();
    await settled(view, "session_expired");
    expect(view.states).toContain("session_expired");
  });

  test("a page over the size cap is not sent", async () => {
    const view = open(fakeApi(), {
      loadSnapshot: async () => async () => ({ ok: false, reason: "too_large" }),
    });
    await settled(view, "ready");
    view.save()?.click();
    await vi.waitFor(() => expect(view.said()?.textContent).toBe(SAVE_MESSAGES.too_large));
    expect(view.api.calls.some((call) => call.url.includes("/snapshot?"))).toBe(false);
  });

  test("s.js failing to load says to try again, and loads it again next time", async () => {
    let tries = 0;
    const view = open(fakeApi(), {
      loadSnapshot: async () => {
        tries += 1;
        if (tries === 1) throw new Error("blocked");
        return (hide) => takeSnapshot({ hide });
      },
    });
    await settled(view, "ready");
    view.save()?.click();
    await vi.waitFor(() => expect(view.said()?.textContent).toBe(SAVE_MESSAGES.failed));
    view.save()?.click();
    await vi.waitFor(() => expect(view.said()?.textContent).toBe(SAVE_MESSAGES.saved("desktop")));
    expect(tries).toBe(2);
  });
});

describe("the snapshot", () => {
  test("keeps the text and names, masks typed values, and leaves the overlay out", async () => {
    document.body.innerHTML = `
      <main data-ottertrail-name="hero">
        <h1>Plans for owners</h1>
        <a href="/pricing?token=secret-token#frag">Pricing</a>
        <input id="email" type="email">
        <input id="card" type="text">
        <textarea id="note"></textarea>
        <div data-ottertrail-mask>Hidden name Ada</div>
      </main>`;
    (document.querySelector("#email") as HTMLInputElement).value = "ada@example.com";
    (document.querySelector("#card") as HTMLInputElement).value = "4111111111111111";
    (document.querySelector("#note") as HTMLTextAreaElement).value = "typed note";
    const hide = document.createElement(OVERLAY_TAG);
    hide.textContent = "overlay text";
    document.documentElement.append(hide);
    cleanups.push(() => hide.remove());

    const taken = takenOk(await takeSnapshot({ hide }));
    const text = await unpack(taken.body);
    expect(taken.width).toBe(window.innerWidth);
    expect(text).toContain("Plans for owners");
    expect(text).toContain("data-ottertrail-name");
    expect(text).toContain("hero");
    for (const planted of [
      "ada@example.com",
      "4111111111111111",
      "typed note",
      "secret-token",
      "frag",
      "Hidden name Ada",
      "overlay text",
      OVERLAY_TAG,
    ]) {
      expect({ planted, found: text.includes(planted) }).toEqual({ planted, found: false });
    }
    const snapshot = JSON.parse(text);
    expect(new Set(Object.keys(snapshot))).toEqual(new Set(["events", "pageHeight", "v"]));
    expect(snapshot.pageHeight).toBeGreaterThan(0);
    expect(snapshot.events[1].data.initialOffset).toEqual({ top: 0, left: 0 });
  });

  test("over the cap, it is refused", async () => {
    document.body.innerHTML = `<p>${"Some text. ".repeat(2000)}</p>`;
    const hide = document.createElement(OVERLAY_TAG);
    expect(await takeSnapshot({ hide, maxBytes: 100 })).toEqual({
      ok: false,
      reason: "too_large",
    });
    // Past the objects and arrays the API takes, too: it counts them before parsing.
    expect(await takeSnapshot({ hide, maxContainers: 5 })).toEqual({
      ok: false,
      reason: "too_large",
    });
  });
});
