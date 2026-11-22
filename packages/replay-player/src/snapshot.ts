import { Replayer } from "@rrweb/replay";

import { resolveKeys } from "../../tracker/src/heatmap-path.ts";
import {
  drawHeatmap,
  type OverlayData,
  type OverlayElement,
  parseOverlay,
} from "../../tracker/src/overlay-draw.ts";
import {
  fitScale,
  fromPeer,
  type MessagePeer,
  readRecording,
  readThemeMessage,
  type Recording,
} from "./format.ts";
import { PLAYER_CSS } from "./styles.ts";

/**
 * A saved heatmap view (docs/web-analytics.md, "Saved views"): the
 * snapshot of a page its owner saved from the overlay, rebuilt by rrweb in
 * the player's sandboxed frame (allow-same-origin only, no scripts, under
 * the player page's Content Security Policy), with the heatmap drawn over
 * it as the overlay draws it on the live page: each element found by its
 * key inside the frame (resolveKeys, the overlay's own), its clicks' cells,
 * and the scroll bands at the right edge (drawHeatmap, shared with o.js).
 *
 * The page's body names the snapshot (data-snapshot-url) and the heatmap
 * (data-heatmap-url), both on this origin. The view scrolls; links and
 * forms in it do nothing. The elements not found in the snapshot go to
 * the dashboard that frames the page, as a message (snapshotMissingMessage).
 */
import rrwebStyle from "@rrweb/replay/dist/style.css?inline";

export const SNAPSHOT_NOT_AVAILABLE = "This saved view is unavailable. It may have been deleted.";
export const SNAPSHOT_NOT_LOADED = "Could not load the saved view. Reload the page to try again.";
export const SNAPSHOT_NOT_READABLE = "This player doesn't support the saved view's format.";

/** What the dashboard hears: the elements of the heatmap not found in the snapshot. */
export const SNAPSHOT_MISSING_MESSAGE = "ottertrail:snapshot-missing";
/** Missing elements sent at most; the rest are counted. */
const MAX_MISSING = 200;

/** Looks for the elements again this long after the view is built: fonts and images move them. */
const SETTLE_MS = [250, 1000, 3000];

/** A click or a submit in the view: it does nothing. */
const still = (event: Event) => event.preventDefault();

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface SnapshotOptions {
  snapshotUrl: string;
  heatmapUrl: string;
  fetch?: Fetch;
  peer?: MessagePeer | null;
}

export interface SnapshotView {
  /** Settles once the view and its heatmap are drawn, or a message is shown. */
  ready: Promise<void>;
  destroy: () => void;
}

/** The dashboard's message: the elements missing (label, path, clicks), how many in all, and how many found. */
export const snapshotMissingMessage = (missing: readonly OverlayElement[], found: number) => ({
  type: SNAPSHOT_MISSING_MESSAGE,
  missing: missing.slice(0, MAX_MISSING).map((item) => ({
    label: item.label,
    element: item.element,
    clicks: item.clicks,
  })),
  total: missing.length,
  found,
});

async function getJson(
  fetchJson: Fetch,
  url: string,
): Promise<{ body: unknown } | { status: number }> {
  try {
    const response = await fetchJson(url, {
      credentials: "same-origin",
      headers: { accept: "application/json" },
    });
    if (!response.ok) return { status: response.status };
    return { body: await response.json() };
  } catch {
    return { status: 0 };
  }
}

export function startSnapshot(root: HTMLElement, options: SnapshotOptions): SnapshotView {
  const doc = root.ownerDocument;
  const style = doc.createElement("style");
  // A snapshot has no mouse: rrweb's cursor would sit in the top left corner.
  style.textContent = `${rrwebStyle}\n${PLAYER_CSS}\n.ot-heat { position: absolute; left: 0; top: 0; pointer-events: none; }\n.replayer-mouse { display: none; }`;
  doc.head.append(style);

  const shell = doc.createElement("div");
  shell.className = "ot-player";
  const stage = doc.createElement("div");
  stage.className = "ot-stage";
  const message = doc.createElement("p");
  message.className = "ot-message";
  message.setAttribute("role", "status");
  message.textContent = "Loading the saved view…";
  stage.append(message);
  shell.append(stage);
  root.append(shell);

  const peer = options.peer ?? null;
  const fetchJson = options.fetch ?? ((input, init) => fetch(input, init));
  let destroyed = false;
  let replayer: Replayer | null = null;
  const cleanups: (() => void)[] = [];

  const win = doc.defaultView;
  if (peer !== null && win !== null) {
    const onMessage = (event: MessageEvent) => {
      if (!fromPeer(event, peer)) return;
      const theme = readThemeMessage(event.data);
      if (theme !== null) doc.documentElement.dataset.theme = theme;
    };
    win.addEventListener("message", onMessage);
    cleanups.push(() => win.removeEventListener("message", onMessage));
  }

  const fail = (text: string) => {
    message.textContent = text;
    message.dataset.tone = "error";
    message.setAttribute("role", "alert");
  };

  const ready = (async () => {
    const [snapshot, heatmap] = await Promise.all([
      getJson(fetchJson, options.snapshotUrl),
      getJson(fetchJson, options.heatmapUrl),
    ]);
    if (destroyed) return;
    if (!("body" in snapshot)) {
      fail(snapshot.status === 404 ? SNAPSHOT_NOT_AVAILABLE : SNAPSHOT_NOT_LOADED);
      return;
    }
    const recording: Recording | null = readRecording(snapshot.body);
    if (recording === null) {
      fail(SNAPSHOT_NOT_READABLE);
      return;
    }
    const data: OverlayData | null = "body" in heatmap ? parseOverlay(heatmap.body) : null;
    if (data === null) {
      fail(SNAPSHOT_NOT_LOADED);
      return;
    }

    const view = { width: recording.width, height: recording.height };
    const player = new Replayer(recording.events, {
      root: stage,
      showWarning: false,
      mouseTail: false,
      // Never UNSAFE_replayCanvas: it lets the snapshot run scripts.
      UNSAFE_replayCanvas: false,
    });
    replayer = player;
    // Every event at once, wherever rrweb stamped it: the Meta event comes
    // before the page is serialized, the full snapshot and the stylesheets
    // it brought after. Paused past the last, they all apply now, and the
    // Replayer's own first build (a timer) then finds the page built.
    const first = recording.events[0]?.timestamp ?? 0;
    const last = recording.events.at(-1)?.timestamp ?? first;
    player.pause(last - first + 1);
    // Past that timer: a later build would erase the listeners below.
    await new Promise((done) => setTimeout(done, 20));
    if (destroyed) return;
    message.remove();
    const frame = player.iframe;
    const page = frame.contentDocument;
    const pageWindow = frame.contentWindow;
    const wrapper = stage.querySelector<HTMLElement>(".replayer-wrapper");
    if (page === null || pageWindow === null || wrapper === null) {
      fail(SNAPSHOT_NOT_READABLE);
      return;
    }

    // The view scrolls, as the page did.
    player.enableInteract();

    const canvas = doc.createElement("canvas");
    canvas.className = "ot-heat";
    canvas.setAttribute("aria-hidden", "true");
    wrapper.append(canvas);
    const context = canvas.getContext("2d");

    let found: { item: OverlayElement; node: Element }[] = [];
    const draw = () => {
      if (context === null || destroyed) return;
      const ratio = win?.devicePixelRatio || 1;
      if (canvas.width !== Math.round(view.width * ratio)) {
        canvas.width = Math.round(view.width * ratio);
      }
      if (canvas.height !== Math.round(view.height * ratio)) {
        canvas.height = Math.round(view.height * ratio);
      }
      canvas.style.width = `${view.width}px`;
      canvas.style.height = `${view.height}px`;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, view.width, view.height);
      drawHeatmap(
        context,
        {
          width: view.width,
          height: view.height,
          scrollY: pageWindow.scrollY,
          pageHeight: Math.max(
            page.documentElement?.scrollHeight ?? 0,
            page.body?.scrollHeight ?? 0,
            view.height,
          ),
        },
        data,
        found,
      );
    };

    let lastMissing = "";
    const resolve = () => {
      if (destroyed) return;
      let nodes: (Element | null)[] = [];
      try {
        nodes = resolveKeys(page, data.elements);
      } catch {
        nodes = [];
      }
      found = [];
      const missing: OverlayElement[] = [];
      for (const [index, item] of data.elements.entries()) {
        const node = nodes[index] ?? null;
        if (node === null) missing.push(item);
        else found.push({ item, node });
      }
      draw();
      const said = snapshotMissingMessage(missing, found.length);
      const text = JSON.stringify(said);
      if (peer !== null && text !== lastMissing) {
        lastMissing = text;
        peer.window.postMessage(said, peer.origin);
      }
    };

    const fit = () => {
      const scale = fitScale(stage.clientWidth, stage.clientHeight, view.width, view.height);
      wrapper.style.width = `${view.width}px`;
      wrapper.style.height = `${view.height}px`;
      wrapper.style.transform = `translate(${(stage.clientWidth - view.width * scale) / 2}px, ${(stage.clientHeight - view.height * scale) / 2}px) scale(${scale})`;
    };
    const resized = new ResizeObserver(fit);
    resized.observe(stage);
    fit();

    let frameRequest = 0;
    const drawSoon = () => {
      cancelAnimationFrame(frameRequest);
      frameRequest = requestAnimationFrame(draw);
    };
    /**
     * The view's listeners: a link or a form in it does nothing, scrolling
     * redraws, and stylesheets, fonts, and images arriving move the
     * elements. Added again whenever rrweb builds the page again, as its
     * build (document.open) erases them.
     */
    const listen = () => {
      page.addEventListener("click", still, true);
      page.addEventListener("submit", still, true);
      pageWindow.addEventListener("scroll", drawSoon, { passive: true, capture: true });
      pageWindow.addEventListener("load", resolve);
    };
    listen();
    player.on("fullsnapshot-rebuilded", () => {
      listen();
      resolve();
    });
    const timers = SETTLE_MS.map((ms) => setTimeout(resolve, ms));
    cleanups.push(() => {
      resized.disconnect();
      cancelAnimationFrame(frameRequest);
      for (const timer of timers) clearTimeout(timer);
    });
    resolve();
  })();

  return {
    ready,
    destroy: () => {
      destroyed = true;
      for (const cleanup of cleanups) cleanup();
      replayer?.destroy();
      shell.remove();
    },
  };
}
