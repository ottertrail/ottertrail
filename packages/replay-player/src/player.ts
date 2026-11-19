import { Replayer } from "@rrweb/replay";

import {
  errorOffset,
  fitScale,
  formatClock,
  fromPeer,
  markerPercent,
  type MessagePeer,
  readRecording,
  readSeekMessage,
  type Recording,
  startOffset,
  timeMessage,
  timelineText,
} from "./format.ts";
import { PLAYER_CSS } from "./styles.ts";

/**
 * The session replay player (docs/session-replay.md, "Playback"). It runs in
 * a page of its own that the API serves with a strict Content Security
 * Policy, shown in a frame of the dashboard; that page's body names the
 * recording (data-replay-url) and the error's time (data-error-at, ms since
 * the epoch).
 *
 * A recording is whatever a browser sent with a public key, so it is
 * untrusted HTML: only rrweb's Replayer puts it on screen, in an iframe it
 * sandboxes without allow-scripts. Nothing from it is written into this
 * page's own document, and UNSAFE_replayCanvas, which allows scripts, is
 * never set.
 */
import rrwebStyle from "@rrweb/replay/dist/style.css?inline";

export const NOTE =
  "The visitor's browser masked content as the site specified. Hidden content never reached Ottertrail.";
export const NOT_AVAILABLE = "This replay is unavailable. It may have expired.";
export const NOT_LOADED = "The replay could not be loaded. Close it. Try again in a moment.";
export const NOT_READABLE =
  "This replay could not be read. The player does not support its recording format.";

const SPEEDS = [1, 2, 4] as const;

/** The timeline's arrow keys move this far. */
const ARROW_STEP_MS = 5_000;
/** While playing, the dashboard hears where the player is this often at most. */
const TIME_MESSAGE_MS = 250;

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** An element with its class and, optionally, its text. */
function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function addStyles(doc: Document) {
  const style = doc.createElement("style");
  style.textContent = `${rrwebStyle}\n${PLAYER_CSS}`;
  doc.head.append(style);
}

/** The recorded page's new viewport, as the Replayer reports it. */
const isViewport = (value: unknown): value is { width: number; height: number } =>
  typeof value === "object" &&
  value !== null &&
  "width" in value &&
  "height" in value &&
  typeof value.width === "number" &&
  typeof value.height === "number" &&
  value.width > 0 &&
  value.height > 0;

/** Space toggles playing, unless focus is in a control that Space works. */
function usesSpace(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target instanceof HTMLInputElement) return target.type !== "range";
  return (
    target instanceof HTMLButtonElement ||
    target instanceof HTMLSelectElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLAnchorElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

/** Loads the recording; a message for the viewer when it cannot be had. */
async function load(
  fetchRecording: Fetch,
  url: string,
): Promise<{ recording: Recording } | { message: string }> {
  let response: Response;
  try {
    response = await fetchRecording(url, {
      credentials: "same-origin",
      headers: { accept: "application/json" },
    });
  } catch {
    return { message: NOT_LOADED };
  }
  if (response.status === 404) return { message: NOT_AVAILABLE };
  if (!response.ok) return { message: NOT_LOADED };
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { message: NOT_READABLE };
  }
  const recording = readRecording(body);
  return recording === null ? { message: NOT_READABLE } : { recording };
}

export interface PlayerOptions {
  /** Where the recording is, on this origin. */
  replayUrl: string;
  /** When the error happened, ms since the epoch; null without one. */
  errorAt: number | null;
  /** The page's fetch; tests pass a fake. */
  fetch?: Fetch;
  /**
   * The dashboard that shows the player in a frame: its window and origin.
   * It may ask the player to move to a moment (readSeekMessage), and hears
   * where it is (timeMessage). Without one, no message is taken or sent.
   */
  peer?: MessagePeer | null;
}

export interface Player {
  /** Settles once the recording is on screen, or its message is. */
  ready: Promise<void>;
  destroy: () => void;
}

/** Builds the player into `root` and loads the recording. */
export function startPlayer(root: HTMLElement, options: PlayerOptions): Player {
  const doc = root.ownerDocument;
  addStyles(doc);

  const shell = element("div", "ot-player");
  const stage = element("div", "ot-stage");
  const message = element("p", "ot-message", "Loading the replay…");
  message.setAttribute("role", "status");
  stage.append(message);

  const controls = element("div", "ot-controls");
  controls.hidden = true;
  controls.setAttribute("role", "group");
  controls.setAttribute("aria-label", "Replay controls");

  const play = element("button", "ot-button ot-play", "Play");
  play.type = "button";

  const timeline = element("div", "ot-timeline");
  const slider = element("input", "");
  slider.type = "range";
  slider.min = "0";
  slider.step = "100";
  slider.setAttribute("aria-label", "Time in the replay");
  const marker = element("span", "ot-marker");
  marker.hidden = true;
  marker.append(element("span", "ot-sr-only", "The error"));
  timeline.append(slider, marker);

  const time = element("span", "ot-time", "0:00 / 0:00");
  time.setAttribute("aria-hidden", "true");

  const jump = element("button", "ot-button", "Jump to the error");
  jump.type = "button";
  jump.hidden = true;

  const speeds = element("div", "ot-group");
  speeds.setAttribute("role", "group");
  speeds.setAttribute("aria-label", "Speed");
  const speedButtons = SPEEDS.map((speed) => {
    const button = element("button", "ot-button", `${speed}×`);
    button.type = "button";
    button.setAttribute("aria-pressed", String(speed === 1));
    button.setAttribute("aria-label", `Speed ${speed}×`);
    speeds.append(button);
    return { speed, button };
  });

  const skipLabel = element("label", "ot-check");
  const skip = element("input", "");
  skip.type = "checkbox";
  skip.checked = true;
  skipLabel.append(skip, doc.createTextNode("Skip inactivity"));

  controls.append(play, timeline, time, jump, speeds, skipLabel);
  const note = element("p", "ot-note", NOTE);
  shell.append(stage, controls, note);
  root.append(shell);

  let replayer: Replayer | null = null;
  let destroyed = false;
  let frame = 0;
  let resizeObserver: ResizeObserver | null = null;
  const cleanups: (() => void)[] = [];
  const peer = options.peer ?? null;
  /** Where the dashboard asked to go before the recording was ready. */
  let pendingSeek: number | null = null;
  /** Moves to a moment the dashboard asked for; set once the recording plays. */
  let seekTo: ((offset: number) => void) | null = null;

  const win = doc.defaultView;
  if (peer !== null && win !== null) {
    const onMessage = (event: MessageEvent) => {
      // Only the dashboard that framed this page, from its own origin, in the one shape.
      if (!fromPeer(event, peer)) return;
      const offset = readSeekMessage(event.data);
      if (offset === null) return;
      if (seekTo === null) pendingSeek = offset;
      else seekTo(offset);
    };
    win.addEventListener("message", onMessage);
    cleanups.push(() => win.removeEventListener("message", onMessage));
  }

  const ready = (async () => {
    const loaded = await load(
      options.fetch ?? ((input, init) => fetch(input, init)),
      options.replayUrl,
    );
    if (destroyed) return;
    if ("message" in loaded) {
      message.textContent = loaded.message;
      message.dataset.tone = "error";
      message.setAttribute("role", "alert");
      return;
    }
    const { recording } = loaded;
    const view = { width: recording.width, height: recording.height };
    const player = new Replayer(
      // Checked by readRecording; the Replayer reads the rest of each event.
      recording.events,
      {
        root: stage,
        skipInactive: true,
        showWarning: false,
        mouseTail: { duration: 500, lineCap: "round", lineWidth: 3, strokeStyle: "#a557aa" },
        // Never UNSAFE_replayCanvas: it lets the recording run scripts.
        UNSAFE_replayCanvas: false,
      },
    );
    replayer = player;
    message.remove();

    const { startTime, totalTime } = player.getMetaData();
    const errorAtOffset = errorOffset(startTime, totalTime, options.errorAt);
    let current = startOffset(errorAtOffset);
    let playing = false;

    slider.max = String(totalTime);
    let lastPosted = Number.NEGATIVE_INFINITY;
    let lastPostedAt = 0;

    const fit = () => {
      const wrapper = stage.querySelector<HTMLElement>(".replayer-wrapper");
      if (wrapper === null) return;
      const scale = fitScale(stage.clientWidth, stage.clientHeight, view.width, view.height);
      wrapper.style.width = `${view.width}px`;
      wrapper.style.height = `${view.height}px`;
      wrapper.style.transform = `translate(${(stage.clientWidth - view.width * scale) / 2}px, ${(stage.clientHeight - view.height * scale) / 2}px) scale(${scale})`;
    };
    player.on("resize", (size) => {
      if (isViewport(size)) {
        view.width = size.width;
        view.height = size.height;
        fit();
      }
    });
    resizeObserver = new ResizeObserver(fit);
    resizeObserver.observe(stage);
    fit();

    const show = () => {
      const shown = Math.min(Math.max(current, 0), totalTime);
      slider.value = String(shown);
      slider.setAttribute("aria-valuetext", timelineText(shown, totalTime));
      time.textContent = `${formatClock(shown)} / ${formatClock(totalTime)}`;
      play.textContent = playing ? "Pause" : "Play";
      play.setAttribute("aria-label", playing ? "Pause the replay" : "Play the replay");
      // Tells the dashboard where the player is: a few times a second while playing.
      const at = performance.now();
      if (
        peer !== null &&
        shown !== lastPosted &&
        (!playing || at - lastPostedAt >= TIME_MESSAGE_MS)
      ) {
        lastPosted = shown;
        lastPostedAt = at;
        peer.window.postMessage(timeMessage(shown, totalTime), peer.origin);
      }
    };

    const tick = () => {
      if (!playing) return;
      current = Math.min(player.getCurrentTime(), totalTime);
      show();
      frame = requestAnimationFrame(tick);
    };

    const seek = (offset: number) => {
      current = Math.min(Math.max(offset, 0), totalTime);
      if (playing) player.play(current);
      else player.pause(current);
      show();
    };

    const setPlaying = (next: boolean) => {
      if (next === playing) return;
      if (next) {
        // At the end, play again from the start.
        if (current >= totalTime) current = 0;
        playing = true;
        player.play(current);
        frame = requestAnimationFrame(tick);
      } else {
        current = Math.min(player.getCurrentTime(), totalTime);
        playing = false;
        cancelAnimationFrame(frame);
        player.pause();
      }
      show();
    };

    player.on("finish", () => {
      playing = false;
      cancelAnimationFrame(frame);
      current = totalTime;
      show();
    });

    play.addEventListener("click", () => setPlaying(!playing));
    slider.addEventListener("input", () => seek(Number(slider.value)));
    slider.addEventListener("keydown", (event) => {
      const step =
        event.key === "ArrowLeft" || event.key === "ArrowDown"
          ? -ARROW_STEP_MS
          : event.key === "ArrowRight" || event.key === "ArrowUp"
            ? ARROW_STEP_MS
            : 0;
      if (step === 0) return;
      event.preventDefault();
      seek(current + step);
    });

    if (errorAtOffset !== null) {
      marker.hidden = false;
      marker.style.left = `${markerPercent(errorAtOffset, totalTime)}%`;
      marker.title = `The error, at ${formatClock(errorAtOffset)}`;
      jump.hidden = false;
      jump.addEventListener("click", () => seek(errorAtOffset));
    }

    for (const { speed, button } of speedButtons) {
      button.addEventListener("click", () => {
        player.setConfig({ speed });
        for (const other of speedButtons) {
          other.button.setAttribute("aria-pressed", String(other.speed === speed));
        }
      });
    }
    skip.addEventListener("change", () => player.setConfig({ skipInactive: skip.checked }));

    const onKey = (event: KeyboardEvent) => {
      if (event.key !== " " || event.defaultPrevented || usesSpace(event.target)) return;
      event.preventDefault();
      setPlaying(!playing);
    };
    doc.addEventListener("keydown", onKey);
    cleanups.push(() => doc.removeEventListener("keydown", onKey));

    controls.hidden = false;
    player.pause(current);
    show();
    seekTo = seek;
    if (pendingSeek !== null) seek(pendingSeek);
    pendingSeek = null;
  })();

  return {
    ready,
    destroy: () => {
      destroyed = true;
      cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      for (const cleanup of cleanups) cleanup();
      replayer?.destroy();
      shell.remove();
    },
  };
}
