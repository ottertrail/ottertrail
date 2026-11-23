/**
 * Keep the current and previous full-snapshot stretches (30 to 60 seconds)
 * in memory. The first error starts a replay, ending after AFTER_ERROR_MS.
 * Only one replay is sent per recording; again() can start another recording.
 * Every event passes replay-filter.ts before storage. Filter failure drops
 * the recording so unmasked content cannot be sent.
 * See docs/session-replay.md, "Recording", and replay-pack.ts.
 */
import { createFilter, ERROR_TAG, type FilterOptions } from "./replay-filter.ts";
import type { Recorder } from "./replay-names.ts";
import { createPacker, type Piece } from "./replay-pack.ts";
import { backoffMs, MAX_ATTEMPTS } from "./tracker.ts";
import { outcomeForStatus, type SendOutcome } from "./transport.ts";

/** How long recording goes on after the first error, to show what it did to the page. */
export const AFTER_ERROR_MS = 10_000;
/** How often rrweb takes a full snapshot: a stretch of the buffer. */
export const CHECKOUT_MS = 30_000;

/** rrweb's Meta event, which begins each full snapshot. */
const META = 4;
const CUSTOM = 5;

export type Emit = (event: unknown, isCheckout?: boolean) => void;

export interface RecorderOptions extends Pick<
  FilterOptions,
  "showText" | "showMedia" | "base" | "live"
> {
  endpoint: string;
  key: string;
  /** Starts rrweb with these privacy settings; returns the function that stops it. */
  record: (emit: Emit) => (() => void) | undefined;
  randomId: () => string;
  /** fetch, as the page has it. */
  fetch: typeof fetch;
  /** navigator.sendBeacon; false when the browser refused. */
  beacon: (url: string, body: Blob) => boolean;
  afterErrorMs?: number;
  /** Starts a new recorder in this one's place: Recorder.again. */
  again?: () => void;
}

export interface ReplayRecorder extends Recorder {
  /** Starts rrweb; apart from creating, so the tracker can stop the recorder first. */
  start: () => void;
  /** The page is hidden or left: end the recording and send what is ready by beacon. */
  exit: () => void;
}

type State = "recording" | "after-error" | "sending" | "done";

/** A piece as a request body: text/plain, which needs no CORS preflight and suits a beacon. */
const body = (piece: Piece) => new Blob([piece.bytes], { type: "text/plain;charset=UTF-8" });

export function createRecorder(options: RecorderOptions): ReplayRecorder {
  const { endpoint, key, fetch, beacon, randomId, afterErrorMs = AFTER_ERROR_MS } = options;
  const filter = createFilter(options);
  let state: State = "recording";
  let stopRecording: (() => void) | undefined;
  /** The stretch before the current one, and the current one: events as JSON text. */
  let previous: string[] = [];
  let current: string[] = [];
  let replayId: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const packer = createPacker();
  /** Packing in order: each step waits for the one before. */
  let packing: Promise<unknown> = Promise.resolve();
  /** Pieces ready and not yet accepted by the API, in order, with their numbers. */
  const queue: (Piece & { seq: number })[] = [];
  let nextSeq = 0;
  let uploading = false;
  /** The page is going away: pieces go by beacon, as soon as they are ready. */
  let exiting = false;
  /** Upload only once the recording is complete and passed the filter. */
  let complete = false;
  /** Why recording ended early: the page's stop(), or the recorder itself. */
  let stoppedBy: "page" | "itself" | undefined;
  let restarted = false;

  const halt = () => {
    try {
      stopRecording?.();
    } catch {
      // rrweb's own cleanup failed; nothing more is kept either way.
    }
    stopRecording = undefined;
    if (timer !== undefined) clearTimeout(timer);
  };

  /** Stops for good and drops everything not sent. */
  const drop = () => {
    stoppedBy ??= "itself";
    halt();
    state = "done";
    previous = [];
    current = [];
    queue.length = 0;
  };

  const keep = (event: unknown) => {
    const clean = filter(event);
    if (clean !== undefined) current.push(JSON.stringify(clean));
  };

  const emit: Emit = (event, isCheckout) => {
    if (state !== "recording" && state !== "after-error") return;
    try {
      // A new full snapshot begins a stretch; the one before the last goes.
      // Not after an error: all of that replay is kept.
      if (
        isCheckout &&
        state === "recording" &&
        typeof event === "object" &&
        event !== null &&
        "type" in event &&
        event.type === META
      ) {
        previous = current;
        current = [];
      }
      keep(event);
    } catch {
      drop(); // Fails closed: nothing that was not masked as configured is sent.
    }
  };

  const url = (piece: Piece & { seq: number }) => {
    const target = new URL(endpoint);
    target.search = new URLSearchParams({
      key,
      replay: replayId ?? "",
      seq: String(piece.seq),
      last: piece.last ? "1" : "0",
      cut: piece.cut ? "1" : "0",
    }).toString();
    return target.href;
  };
  /** The page is leaving: every ready piece goes now, without waiting for answers. */
  const flushByBeacon = () => {
    for (const piece of queue.splice(0)) {
      const target = url(piece);
      if (!beacon(target, body(piece))) {
        void fetch(target, {
          method: "POST",
          body: body(piece),
          keepalive: true,
          credentials: "omit",
        }).catch(() => undefined);
      }
    }
  };

  async function send(piece: Piece & { seq: number }): Promise<SendOutcome | "off"> {
    try {
      const response = await fetch(url(piece), {
        method: "POST",
        body: body(piece),
        credentials: "omit",
      });
      if (response.status === 403) {
        const answer: unknown = await response.json().catch(() => undefined);
        if (
          typeof answer === "object" &&
          answer !== null &&
          "error" in answer &&
          answer.error === "replay_off"
        ) {
          return "off";
        }
      }
      return outcomeForStatus(response.status, response.headers.get("retry-after"));
    } catch {
      return { type: "retry" };
    }
  }

  /** Uploading ends when the replay is done or dropped, or the page is leaving. */
  const stopped = () => state === "done" || exiting;

  /** Sends the queue in order, each piece retried as event batches are. */
  async function upload() {
    if (uploading) return;
    uploading = true;
    let failures = 0;
    while (queue.length > 0 && !stopped()) {
      const piece = queue[0];
      if (piece === undefined) break;
      const outcome = await send(piece);
      if (stopped()) break;
      if (outcome === "off" || outcome.type === "drop") {
        drop(); // Refused: sending it again would fail again.
        break;
      }
      if (outcome.type === "retry") {
        failures += 1;
        if (failures >= MAX_ATTEMPTS) {
          drop();
          break;
        }
        await new Promise((resolve) =>
          setTimeout(resolve, outcome.retryAfterMs ?? backoffMs(failures)),
        );
        continue;
      }
      failures = 0;
      queue.shift();
      if (piece.last) state = "done";
    }
    uploading = false;
  }

  /** Pieces made: queued, then sent as the page allows. */
  const ready = (pieces: Piece[]) => {
    if (state === "done") return;
    for (const piece of pieces) queue.push({ ...piece, seq: nextSeq++ });
    if (exiting) flushByBeacon();
    else if (complete) void upload();
  };

  /** Compresses these events after any before them. */
  const pack = (events: string[], final: boolean) => {
    packing = packing
      .then(() => (state === "done" || packer.done() ? [] : packer.add(events, final)))
      .then(ready)
      .catch(drop);
  };

  /** Recording ends: the rest of it is compressed, and the whole sent. */
  const finish = () => {
    if (state !== "after-error") return;
    halt();
    state = "sending";
    const rest = current;
    current = [];
    complete = true;
    pack(rest, true);
  };

  return {
    error() {
      try {
        if (state === "recording") {
          const events = [...previous, ...current];
          if (events.length === 0) return undefined; // rrweb has not started: no snapshot.
          replayId = randomId();
          state = "after-error";
          previous = [];
          current = [];
          // Compressed now, so it is ready if the page is left before the end.
          pack(events, false);
          timer = setTimeout(finish, afterErrorMs);
        }
        if (state === "after-error") {
          keep({ type: CUSTOM, data: { tag: ERROR_TAG, payload: {} }, timestamp: Date.now() });
          return replayId;
        }
      } catch {
        drop();
      }
      return undefined;
    },
    stop() {
      stoppedBy ??= "page";
      drop();
    },
    again() {
      if (stoppedBy !== "page" || restarted) return;
      restarted = true;
      try {
        options.again?.();
      } catch {
        // Keep restart failures inside the tracker.
      }
    },
    exit() {
      try {
        if (state === "after-error") finish();
        if (state === "sending" && !exiting) {
          exiting = true;
          flushByBeacon();
        }
      } catch {
        drop();
      }
    },
    start() {
      if (state !== "recording" || stopRecording !== undefined) return;
      try {
        stopRecording = options.record(emit);
      } catch {
        drop();
      }
    },
  };
}
