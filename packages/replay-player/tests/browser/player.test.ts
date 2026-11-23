import { afterEach, describe, expect, test } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser/context";

import { PAUSE_MESSAGE, SEEK_MESSAGE, TIME_MESSAGE } from "../../src/format.ts";
import {
  NOT_AVAILABLE,
  NOT_LOADED,
  NOT_READABLE,
  NOTE,
  type Player,
  startPlayer,
} from "../../src/player.ts";

declare global {
  interface Window {
    /** Set only if something from a recording ran. */
    ottertrailPwned?: string;
  }
}

const START = Date.UTC(2026, 10, 16, 8, 0, 0);
const ERROR_AT = START + 90_000;

/** What a recording would run, if the player let it: it marks this test's window. */
const attack = (how: string) => `window.top.ottertrailPwned = ${JSON.stringify(how)}`;

/** A recorded element and a text node, as rrweb serializes them. */
const element = (
  id: number,
  tagName: string,
  attributes: Record<string, string>,
  childNodes: unknown[] = [],
) => ({ type: 2, tagName, attributes, childNodes, id });
const text = (id: number, textContent: string) => ({ type: 3, textContent, id });

/**
 * Two minutes of a page, as rrweb records it: its first view with a script
 * and inline handlers, an image added with an onerror handler, and the
 * mouse moving until the end.
 */
function recording() {
  return {
    v: 1,
    events: [
      {
        type: 4,
        timestamp: START,
        data: { href: "https://example.com/checkout", width: 1024, height: 640 },
      },
      {
        type: 2,
        timestamp: START + 10,
        data: {
          initialOffset: { top: 0, left: 0 },
          node: {
            type: 0,
            id: 1,
            childNodes: [
              { type: 1, name: "html", publicId: "", systemId: "", id: 2 },
              element(3, "html", {}, [
                element(4, "head", {}, [element(5, "script", {}, [text(6, attack("script"))])]),
                element(7, "body", { onload: attack("body onload") }, [
                  element(8, "h1", {}, [text(9, "Hello replay")]),
                  element(10, "button", { id: "pay", onclick: attack("onclick") }, [
                    text(11, "Pay"),
                  ]),
                  element(12, "img", { src: "/missing-image.png", onerror: attack("img onerror") }),
                ]),
              ]),
            ],
          },
        },
      },
      {
        type: 3,
        timestamp: START + 5_000,
        data: {
          source: 0,
          texts: [],
          attributes: [],
          removes: [],
          adds: [
            {
              parentId: 7,
              nextId: null,
              node: element(20, "img", {
                src: "/missing-image-2.png",
                onerror: attack("added img onerror"),
              }),
            },
            {
              parentId: 7,
              nextId: null,
              node: element(21, "script", {}, [text(22, attack("added script"))]),
            },
          ],
        },
      },
      ...Array.from({ length: 12 }, (_, i) => ({
        type: 3,
        timestamp: START + (i + 1) * 10_000,
        data: { source: 1, positions: [{ x: 10 * i, y: 20, id: 8, timeOffset: 0 }] },
      })),
    ],
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let player: Player | undefined;

async function start(
  respond: () => Response,
  errorAt: number | null = ERROR_AT,
  peer: Parameters<typeof startPlayer>[1]["peer"] = null,
) {
  const root = document.createElement("div");
  root.style.height = "600px";
  document.body.append(root);
  const asked: { url: string; init: RequestInit | undefined }[] = [];
  player = startPlayer(root, {
    replayUrl: "/api/projects/p/replays/r",
    errorAt,
    fetch: async (url, init) => {
      asked.push({ url, init });
      return respond();
    },
    peer,
  });
  await player.ready;
  return { root, asked };
}

const slider = () => page.getByRole("slider", { name: "Time in the replay" });
const replayFrame = () => {
  const frame = document.querySelector(".replayer-wrapper iframe");
  if (!(frame instanceof HTMLIFrameElement)) throw new Error("No replay frame");
  return frame;
};

afterEach(() => {
  player?.destroy();
  player = undefined;
  document.body.replaceChildren();
  delete window.ottertrailPwned;
});

describe("the replay player", () => {
  test("starts a minute before the error, the error marked on the timeline", async () => {
    const { asked } = await start(() => json(recording()));

    expect(asked).toEqual([
      {
        url: "/api/projects/p/replays/r",
        init: { credentials: "same-origin", headers: { accept: "application/json" } },
      },
    ]);
    await expect.element(slider()).toHaveAttribute("aria-valuetext", "0:30 of 2:00");
    await expect.element(slider()).toHaveValue("30000");
    await expect.element(page.getByText("0:30 / 2:00")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Play the replay" })).toBeVisible();
    await expect.element(page.getByText(NOTE)).toBeVisible();

    // The error, three quarters along, named for screen readers.
    const marker = document.querySelector<HTMLElement>(".ot-marker");
    expect(marker?.hidden).toBe(false);
    expect(marker?.style.left).toBe("75%");
    expect(marker?.textContent).toBe("The error");
    const jump = page.getByRole("button", { name: "Jump to the error, at 1:30" });
    await expect.element(jump).toBeVisible();
    expect(jump.element().querySelector(".ot-swatch")).not.toBeNull();
    expect(jump.element().textContent).toBe("Jump to the error· 1:30");

    await expect
      .poll(() => replayFrame().contentDocument?.querySelector("h1")?.textContent)
      .toBe("Hello replay");
  });

  test("jumps to the error, plays and pauses, by button and by Space", async () => {
    await start(() => json(recording()));

    await page.getByRole("button", { name: /^Jump to the error/ }).click();
    await expect.element(slider()).toHaveAttribute("aria-valuetext", "1:30 of 2:00");

    await page.getByRole("button", { name: "Play the replay" }).click();
    const pause = page.getByRole("button", { name: "Pause the replay" });
    await expect.element(pause).toBeVisible();
    await pause.click();
    await expect.element(page.getByRole("button", { name: "Play the replay" })).toBeVisible();

    // Space plays from the timeline, which has no use for it.
    slider().element().focus();
    await userEvent.keyboard(" ");
    await expect.element(page.getByRole("button", { name: "Pause the replay" })).toBeVisible();
    await userEvent.keyboard(" ");
    await expect.element(page.getByRole("button", { name: "Play the replay" })).toBeVisible();

    await page.getByRole("button", { name: /^Jump to the error/ }).click();
    slider().element().focus();
    await userEvent.keyboard("{ArrowRight}");
    await expect.element(slider()).toHaveAttribute("aria-valuetext", "1:35 of 2:00");
  });

  test("changes speed, and skips inactivity unless asked not to", async () => {
    await start(() => json(recording()));

    const one = page.getByRole("button", { name: "Speed 1×" });
    const four = page.getByRole("button", { name: "Speed 4×" });
    await expect.element(one).toHaveAttribute("aria-pressed", "true");
    await four.click();
    await expect.element(four).toHaveAttribute("aria-pressed", "true");
    await expect.element(one).toHaveAttribute("aria-pressed", "false");

    const skip = page.getByRole("checkbox", { name: "Skip inactivity" });
    await expect.element(skip).toBeChecked();
    await skip.click();
    await expect.element(skip).not.toBeChecked();
  });

  test("fits the recorded viewport into the frame, keeping its shape", async () => {
    const { root } = await start(() => json(recording()));
    const stage = root.querySelector<HTMLElement>(".ot-stage");
    const wrapper = root.querySelector<HTMLElement>(".replayer-wrapper");
    await expect.poll(() => wrapper?.style.transform).toContain("scale(");
    const scale = Number(/scale\(([\d.]+)\)/.exec(wrapper?.style.transform ?? "")?.[1]);
    const width = stage?.clientWidth ?? 0;
    const height = stage?.clientHeight ?? 0;
    expect(scale).toBeCloseTo(Math.min(width / 1024, height / 640), 5);
  });

  test("runs nothing from the recording: rrweb's frame is sandboxed without scripts", async () => {
    await start(() => json(recording()));
    const frame = replayFrame();
    expect([...frame.sandbox]).toEqual(["allow-same-origin"]);
    expect(frame.sandbox.contains("allow-scripts")).toBe(false);

    await page.getByRole("button", { name: /^Jump to the error/ }).click();
    const doc = frame.contentDocument;
    await expect.poll(() => doc?.querySelectorAll("img").length).toBe(2);
    // The scripts became noscript; the handlers stay attributes that never run.
    expect(doc?.querySelector("script")).toBeNull();
    doc?.querySelector<HTMLButtonElement>("#pay")?.click();
    // Give the images time to fail and any handler time to run.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(window.ottertrailPwned).toBeUndefined();
    // Nothing of the recording in the player's own document.
    expect(document.body.textContent).not.toContain("Hello replay");
  });

  test("needs no 'self' for styles, images, or fonts, and loads none from it", async () => {
    await start(() => json(recording()));
    const doc = replayFrame().contentDocument;
    if (doc === null) throw new Error("No replay document");
    // The frame inherits the page's policy: a recorded image, stylesheet,
    // or font on the dashboard's own origin would send its cookie with a GET.
    const refused: string[] = [];
    doc.addEventListener("securitypolicyviolation", (event) => {
      refused.push(event.effectiveDirective);
    });
    const image = doc.createElement("img");
    image.src = "/api/projects/p/replays";
    const sheet = doc.createElement("link");
    sheet.rel = "stylesheet";
    sheet.href = "/api/projects/p/replays.css";
    const font = doc.createElement("style");
    font.textContent = `@font-face { font-family: x; src: url("/api/font.woff2"); } body { font-family: x; }`;
    doc.body.append(image, sheet, font, doc.createTextNode("text in the font"));
    await expect
      .poll(() => refused.toSorted())
      .toEqual(expect.arrayContaining(["img-src", "style-src-elem"]));
    // The player itself: its inline CSS and rrweb's data: cursor pass.
    await page.getByRole("button", { name: /^Jump to the error/ }).click();
    expect(window.ottertrailViolations).toEqual([]);
  });

  test("hides the marker and the jump without an error time", async () => {
    await start(() => json(recording()), null);
    await expect.element(slider()).toHaveAttribute("aria-valuetext", "0:00 of 2:00");
    expect(document.querySelector<HTMLElement>(".ot-marker")?.hidden).toBe(true);
    await expect
      .element(page.getByRole("button", { name: "Jump to the error" }))
      .not.toBeInTheDocument();
  });

  test("says when the replay is gone", async () => {
    await start(() => json({ error: "replay_not_found" }, 404));
    await expect.element(page.getByRole("alert")).toHaveTextContent(NOT_AVAILABLE);
    await expect.element(slider()).not.toBeInTheDocument();
  });

  test("says to try again when it cannot load, or is not a recording", async () => {
    await start(() => json({ error: "storage_unavailable" }, 503));
    await expect.element(page.getByRole("alert")).toHaveTextContent(NOT_LOADED);
    player?.destroy();
    document.body.replaceChildren();

    await start(() => json({ v: 1, events: [] }));
    await expect.element(page.getByRole("alert")).toHaveTextContent(NOT_READABLE);
  });
});

/** A dashboard: a window of its own (a blank frame), what the player posts to it kept. */
function fakeDashboard() {
  const frame = document.createElement("iframe");
  document.body.append(frame);
  const dashboard = frame.contentWindow;
  if (dashboard === null) throw new Error("No frame window");
  const posted: { message: unknown; origin: string }[] = [];
  dashboard.postMessage = (message: unknown, origin: unknown) => {
    posted.push({ message, origin: String(origin) });
  };
  return { dashboard, posted, peer: { window: dashboard, origin: location.origin } };
}

/** A message as the browser delivers it, from `source` on `origin`. */
const deliver = (data: unknown, origin: string, source: Window | null) =>
  window.dispatchEvent(new MessageEvent("message", { data, origin, source }));

describe("messages with the dashboard", () => {
  test("moves to the moment the dashboard asks for, and says where it is", async () => {
    const { dashboard, posted, peer } = fakeDashboard();
    await start(() => json(recording()), ERROR_AT, peer);
    // Where it starts: a minute before the error.
    expect(posted.at(-1)).toEqual({
      message: { type: TIME_MESSAGE, offsetMs: 30_000, totalMs: 120_000 },
      origin: location.origin,
    });

    deliver({ type: SEEK_MESSAGE, offsetMs: 75_000 }, location.origin, dashboard);
    await expect.element(slider()).toHaveAttribute("aria-valuetext", "1:15 of 2:00");
    expect(posted.at(-1)?.message).toEqual({
      type: TIME_MESSAGE,
      offsetMs: 75_000,
      totalMs: 120_000,
    });
    deliver({ type: SEEK_MESSAGE, offsetMs: 500_000 }, location.origin, dashboard);
    await expect.element(slider()).toHaveAttribute("aria-valuetext", "2:00 of 2:00");
  });

  test("ignores other origins, other windows, and other shapes", async () => {
    const { dashboard, peer } = fakeDashboard();
    await start(() => json(recording()), ERROR_AT, peer);
    await expect.element(slider()).toHaveAttribute("aria-valuetext", "0:30 of 2:00");

    deliver({ type: SEEK_MESSAGE, offsetMs: 75_000 }, "https://evil.example", dashboard);
    deliver({ type: SEEK_MESSAGE, offsetMs: 75_000 }, location.origin, window);
    deliver({ type: SEEK_MESSAGE, offsetMs: 75_000 }, location.origin, null);
    deliver({ type: SEEK_MESSAGE, offsetMs: "75000" }, location.origin, dashboard);
    deliver({ type: SEEK_MESSAGE, offsetMs: 75_000, extra: 1 }, location.origin, dashboard);
    deliver("seek 75000", location.origin, dashboard);
    // A valid message confirms the listener processed the earlier messages.
    deliver({ type: SEEK_MESSAGE, offsetMs: 10_000 }, location.origin, dashboard);
    await expect.element(slider()).toHaveAttribute("aria-valuetext", "0:10 of 2:00");
  });

  test("pauses when the dashboard asks, as when it hides the player", async () => {
    const { dashboard, peer } = fakeDashboard();
    await start(() => json(recording()), ERROR_AT, peer);
    await page.getByRole("button", { name: "Play the replay" }).click();
    await expect.element(page.getByRole("button", { name: "Pause the replay" })).toBeVisible();

    deliver({ type: PAUSE_MESSAGE, extra: 1 }, location.origin, dashboard);
    deliver({ type: PAUSE_MESSAGE }, location.origin, window);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await expect.element(page.getByRole("button", { name: "Pause the replay" })).toBeVisible();

    deliver({ type: PAUSE_MESSAGE }, location.origin, dashboard);
    await expect.element(page.getByRole("button", { name: "Play the replay" })).toBeVisible();
    deliver({ type: PAUSE_MESSAGE }, location.origin, dashboard);
    await expect.element(page.getByRole("button", { name: "Play the replay" })).toBeVisible();
  });

  test("a seek asked for while the recording loads is made once it is ready", async () => {
    const { dashboard, peer } = fakeDashboard();
    const root = document.createElement("div");
    root.style.height = "600px";
    document.body.append(root);
    let answer: ((response: Response) => void) | undefined;
    player = startPlayer(root, {
      replayUrl: "/api/projects/p/replays/r",
      errorAt: ERROR_AT,
      fetch: () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
      peer,
    });
    deliver({ type: SEEK_MESSAGE, offsetMs: 100_000 }, location.origin, dashboard);
    answer?.(json(recording()));
    await player.ready;
    await expect.element(slider()).toHaveAttribute("aria-valuetext", "1:40 of 2:00");
  });

  test("without a dashboard, takes no message", async () => {
    await start(() => json(recording()));
    deliver({ type: SEEK_MESSAGE, offsetMs: 75_000 }, location.origin, window.parent);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await expect.element(slider()).toHaveAttribute("aria-valuetext", "0:30 of 2:00");
  });
});
