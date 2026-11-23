import { afterEach, describe, expect, test, vi } from "vite-plus/test";

import {
  SNAPSHOT_MISSING_MESSAGE,
  SNAPSHOT_NOT_AVAILABLE,
  type SnapshotView,
  startSnapshot,
} from "../../src/snapshot.ts";

declare global {
  interface Window {
    /** Set only if something from a snapshot ran. */
    ottertrailPwned?: string;
  }
}

const AT = Date.UTC(2026, 10, 22, 9, 0, 0);
const attack = (how: string) => `window.top.ottertrailPwned = ${JSON.stringify(how)}`;

const element = (
  id: number,
  tagName: string,
  attributes: Record<string, string>,
  childNodes: unknown[] = [],
) => ({ type: 2, tagName, attributes, childNodes, id });
const text = (id: number, textContent: string) => ({ type: 3, textContent, id });

/**
 * A saved view as s.js writes it: a page with a named hero, a button, a
 * form, and a script. `apart` spaces the events as rrweb stamps them on a
 * real page: the Meta event first, the full snapshot once the page is
 * serialized, then the constructed stylesheets it brought.
 */
function snapshot({ apart = false } = {}) {
  return {
    v: 1,
    pageHeight: 1600,
    events: [
      {
        type: 4,
        timestamp: AT,
        data: { href: "https://example.com/pricing", width: 800, height: 600 },
      },
      {
        type: 2,
        timestamp: apart ? AT + 50 : AT,
        data: {
          initialOffset: { top: 0, left: 0 },
          node: {
            type: 0,
            id: 1,
            childNodes: [
              { type: 1, name: "html", publicId: "", systemId: "", id: 2 },
              element(3, "html", {}, [
                element(4, "head", {}, [element(5, "script", {}, [text(6, attack("script"))])]),
                element(7, "body", { style: "margin:0", onload: attack("onload") }, [
                  element(8, "main", { "data-ottertrail-name": "hero" }, [
                    element(
                      9,
                      "a",
                      { href: "https://example.com/next", style: "display:block;height:200px" },
                      [text(10, "Start")],
                    ),
                  ]),
                  element(11, "div", { style: "height:1400px" }, [
                    element(12, "button", { onclick: attack("onclick") }, [text(13, "Buy")]),
                    element(14, "form", { action: "https://example.com/subscribe" }, [
                      element(15, "button", { type: "submit" }, [text(16, "Subscribe")]),
                    ]),
                  ]),
                ]),
              ]),
            ],
          },
        },
      },
      // A constructed stylesheet the page adopted: the hero's link turns red.
      {
        type: 3,
        timestamp: apart ? AT + 62 : AT,
        data: {
          source: 15,
          id: 1,
          styleIds: [1],
          styles: [
            { styleId: 1, rules: [{ rule: "main a { color: rgb(255, 0, 0); }", index: 0 }] },
          ],
        },
      },
    ],
  };
}

function heatmap() {
  // Keys as capture writes them: from the named element, or from body.
  return {
    firstDay: "2026-11-16",
    lastDay: "2026-11-22",
    totals: { pageviews: 10, clicks: 7, rageClicks: 1, deadClicks: 0 },
    reach: Array.from({ length: 20 }, (_, index) => ({
      depth: (index + 1) * 5,
      share: 1 - index * 0.05,
    })),
    elements: [
      {
        label: "hero",
        element: "main>a",
        clicks: 4,
        rageClicks: 1,
        deadClicks: 0,
        cells: [[1, 1, 4]],
      },
      {
        label: null,
        element: "body>div>button",
        clicks: 2,
        rageClicks: 0,
        deadClicks: 0,
        cells: [[0, 0, 2]],
      },
      {
        label: null,
        element: "body>footer>a",
        clicks: 1,
        rageClicks: 0,
        deadClicks: 0,
        cells: [[0, 0, 1]],
      },
    ],
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let view: SnapshotView | null = null;
afterEach(() => {
  view?.destroy();
  view = null;
  document.body.replaceChildren();
  delete window.ottertrailPwned;
});

function mount(answers: { snapshot?: Response; heatmap?: Response } = {}) {
  return mountWith(answers);
}

function mountWith(answers: { snapshot?: Response; heatmap?: Response }) {
  const root = document.createElement("div");
  root.style.cssText = "width:800px;height:600px";
  document.body.append(root);
  const messages: unknown[] = [];
  const fetch = vi.fn<(url: string) => Promise<Response>>(async (url) =>
    url.startsWith("/snapshot")
      ? (answers.snapshot ?? json(snapshot()))
      : (answers.heatmap ?? json(heatmap())),
  );
  view = startSnapshot(root, {
    snapshotUrl: "/snapshot",
    heatmapUrl: "/heatmap",
    fetch,
    peer: { window: { postMessage: (message) => messages.push(message) }, origin: location.origin },
  });
  return { root, messages, fetch };
}

describe("a saved view", () => {
  test("is rebuilt in rrweb's sandbox, runs nothing, and draws the heatmap over the elements found", async () => {
    const { root, messages } = mount();
    await view?.ready;
    const frame = root.querySelector("iframe");
    expect(frame?.getAttribute("sandbox")).toBe("allow-same-origin");
    const page = frame?.contentDocument;
    expect(page?.querySelector("main a")?.textContent).toBe("Start");
    expect(page?.querySelector("script")?.textContent ?? "").not.toContain("ottertrailPwned");
    (page?.querySelector("button") as HTMLButtonElement | null)?.click();
    await new Promise((done) => setTimeout(done, 50));
    expect(window.ottertrailPwned).toBeUndefined();
    const cursor = root.querySelector<HTMLElement>(".replayer-mouse");
    expect(cursor === null || getComputedStyle(cursor).display === "none").toBe(true);
    const canvas = root.querySelector<HTMLCanvasElement>("canvas.ot-heat");
    expect(canvas?.style.width).toBe("800px");
    expect(canvas?.style.height).toBe("600px");
    const pixels = canvas?.getContext("2d")?.getImageData(0, 0, canvas.width, canvas.height).data;
    expect([...(pixels ?? [])].some((value) => value !== 0)).toBe(true);
    // The dashboard hears which elements the snapshot does not have.
    await vi.waitFor(() =>
      expect(messages.at(-1)).toEqual({
        type: SNAPSHOT_MISSING_MESSAGE,
        missing: [{ label: null, element: "body>footer>a", clicks: 1 }],
        total: 1,
        found: 2,
      }),
    );
  });

  test("a link in it does nothing", async () => {
    const { root } = mount();
    await view?.ready;
    const page = root.querySelector("iframe")?.contentDocument;
    const anchor = page?.querySelector("a") as HTMLAnchorElement;
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    anchor.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  test("a view deleted meanwhile says so", async () => {
    const { root } = mount({ snapshot: json({ error: "snapshot_not_found" }, 404) });
    await view?.ready;
    expect(root.querySelector("[role=alert]")?.textContent).toBe(SNAPSHOT_NOT_AVAILABLE);
    expect(root.querySelector("iframe")).toBeNull();
  });
});

describe("a saved view with events apart, as rrweb stamps a real page", () => {
  test("is built once, its stylesheets applied, links and forms blocked, and redrawn on scroll", async () => {
    const { root, messages } = mount({ snapshot: json(snapshot({ apart: true })) });
    await view?.ready;
    // Wait past Replayer's 1 ms build timer so it cannot undo the next steps.
    await new Promise((done) => setTimeout(done, 100));
    const frame = root.querySelector("iframe");
    const page = frame?.contentDocument;
    const pageWindow = frame?.contentWindow;
    if (page === null || page === undefined || pageWindow === null || pageWindow === undefined) {
      throw new Error("no view");
    }
    const anchor = page.querySelector("main a") as HTMLAnchorElement;
    expect(pageWindow.getComputedStyle(anchor).color).toBe("rgb(255, 0, 0)");

    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    anchor.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    const submit = new SubmitEvent("submit", { bubbles: true, cancelable: true });
    page.querySelector("form")?.dispatchEvent(submit);
    expect(submit.defaultPrevented).toBe(true);

    await vi.waitFor(() => expect(messages.at(-1)).toMatchObject({ total: 1, found: 2 }));

    // Scrolling the view draws the canvas again, at the new position.
    const canvas = root.querySelector<HTMLCanvasElement>("canvas.ot-heat");
    const before = canvas?.toDataURL();
    pageWindow.scrollTo(0, 400);
    pageWindow.dispatchEvent(new Event("scroll"));
    await vi.waitFor(() => expect(canvas?.toDataURL()).not.toBe(before));
  });
});
