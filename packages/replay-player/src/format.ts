/**
 * Pure helpers of the replay player: time text, where the error sits on the
 * timeline, how the recorded viewport fits the frame, and the recording's
 * shape. No DOM, so they are tested in Node.js (tests/format.test.ts).
 */

/** The player starts this long before the error, at most. */
export const LEAD_BEFORE_ERROR_MS = 60_000;

/** "0:05", "1:05", "12:00", "1:02:03": whole seconds, rounded down. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
    : `${minutes}:${seconds}`;
}

/** The timeline's spoken value: "0:12 of 1:05". */
export const timelineText = (currentMs: number, totalMs: number) =>
  `${formatClock(currentMs)} of ${formatClock(totalMs)}`;

/**
 * How far past the recording's end an error time may fall and still mark
 * its end. A recording ends with its last change: a page where nothing
 * changes after the error ends there, and the error's time, from the
 * server's corrected clock, can land a moment later.
 */
export const ERROR_AFTER_END_MS = 15_000;

/**
 * Where the error is, in ms from the recording's start, at its end when it
 * falls just after it; null without an error time, or when it falls outside
 * the recording.
 */
export function errorOffset(
  startTime: number,
  totalMs: number,
  errorAt: number | null,
): number | null {
  if (errorAt === null || !Number.isFinite(errorAt)) return null;
  const offset = errorAt - startTime;
  if (offset < 0 || offset > totalMs + ERROR_AFTER_END_MS) return null;
  return Math.min(offset, totalMs);
}

/** The error marker's place along the timeline, from 0 to 100 (percent). */
export function markerPercent(offset: number, totalMs: number): number {
  if (totalMs <= 0) return 0;
  return Math.min(100, Math.max(0, (offset / totalMs) * 100));
}

/** Where playing starts, in ms from the recording's start: a minute before the error at most. */
export function startOffset(errorAtOffset: number | null): number {
  return errorAtOffset === null ? 0 : Math.max(0, errorAtOffset - LEAD_BEFORE_ERROR_MS);
}

/** The scale that fits a recorded viewport into the frame, whole, keeping its shape. */
export function fitScale(
  frameWidth: number,
  frameHeight: number,
  recordedWidth: number,
  recordedHeight: number,
): number {
  if (recordedWidth <= 0 || recordedHeight <= 0 || frameWidth <= 0 || frameHeight <= 0) return 1;
  return Math.min(frameWidth / recordedWidth, frameHeight / recordedHeight);
}

/** An rrweb event, as far as the player checks it; the Replayer reads the rest. */
export interface RecordedEvent {
  type: number;
  timestamp: number;
  data: Record<string, unknown>;
}

export interface Recording {
  v: 1;
  /** By time, oldest first. */
  events: RecordedEvent[];
  /** The first viewport's size, from the Meta event. */
  width: number;
  height: number;
}

/** rrweb's event types the player needs: a page to show, and its size. */
const FULL_SNAPSHOT = 2;
const META = 4;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isEvent = (value: unknown): value is RecordedEvent =>
  isRecord(value) &&
  Number.isInteger(value.type) &&
  typeof value.timestamp === "number" &&
  Number.isFinite(value.timestamp) &&
  isRecord(value.data);

const isSize = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

/**
 * The recording the API sent, `{"v":1,"events":[…]}`, checked: version 1,
 * rrweb events, at least two, a Meta event with the viewport's size, and a
 * full snapshot to build the page from. null when it is anything else.
 * Events come back sorted by time.
 */
export function readRecording(value: unknown): Recording | null {
  if (!isRecord(value) || value.v !== 1 || !Array.isArray(value.events)) return null;
  const raw: unknown[] = value.events;
  if (raw.length < 2 || !raw.every(isEvent)) return null;
  const events = raw.filter(isEvent).toSorted((a, b) => a.timestamp - b.timestamp);
  const meta = events.find((event) => event.type === META);
  if (meta === undefined || !isSize(meta.data.width) || !isSize(meta.data.height)) return null;
  if (!events.some((event) => event.type === FULL_SNAPSHOT && isRecord(event.data.node))) {
    return null;
  }
  return { v: 1, events, width: meta.data.width, height: meta.data.height };
}

/**
 * Messages between the dashboard and the player page, which the dashboard
 * shows in a frame (docs/session-replay.md, "The timeline"): the dashboard
 * asks the player to move to a moment, and the player says where it is.
 * The dashboard has the same names (apps/web/src/lib/replay-messages.ts).
 * Each side takes a message only from the other window, from its own
 * origin, in exactly this shape; anything else is ignored.
 */
export const SEEK_MESSAGE = "ottertrail:replay-seek";
export const TIME_MESSAGE = "ottertrail:replay-time";
/** Offsets past this are no moment of any replay: a day. */
export const MAX_MESSAGE_OFFSET_MS = 86_400_000;

const isOffset = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= MAX_MESSAGE_OFFSET_MS;

/** Exactly these keys, and no others: what a structured clone of the message gives. */
const hasExactly = (value: Record<string, unknown>, keys: readonly string[]) => {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => own.includes(key));
};

/** The offset a seek message asks for, in ms from the recording's start; null for anything else. */
export function readSeekMessage(data: unknown): number | null {
  if (!isRecord(data) || !hasExactly(data, ["type", "offsetMs"])) return null;
  if (data.type !== SEEK_MESSAGE || !isOffset(data.offsetMs)) return null;
  return data.offsetMs;
}

/** Where the player is, for the dashboard: ms from the recording's start, and its length. */
export const timeMessage = (offsetMs: number, totalMs: number) => ({
  type: TIME_MESSAGE,
  offsetMs: Math.max(0, Math.round(offsetMs)),
  totalMs: Math.max(0, Math.round(totalMs)),
});

/** Where messages to the player may come from: its parent window, on its own origin. */
export interface MessagePeer {
  window: { postMessage: (message: unknown, targetOrigin: string) => void };
  origin: string;
}

/** Whether a message event comes from the peer: its window, and its origin. */
export const fromPeer = (event: { origin: string; source: unknown }, peer: MessagePeer) =>
  event.origin === peer.origin && event.source === peer.window;
