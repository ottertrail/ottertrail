import { describe, expect, test } from "vite-plus/test";

import {
  errorOffset,
  fitScale,
  formatClock,
  fromPeer,
  markerPercent,
  readRecording,
  readSeekMessage,
  SEEK_MESSAGE,
  TIME_MESSAGE,
  timeMessage,
  startOffset,
  timelineText,
} from "../src/format.ts";

describe("formatClock", () => {
  test("writes minutes and seconds, rounded down", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(5_999)).toBe("0:05");
    expect(formatClock(65_000)).toBe("1:05");
    expect(formatClock(12 * 60_000)).toBe("12:00");
  });

  test("adds hours past an hour", () => {
    expect(formatClock(3_723_000)).toBe("1:02:03");
  });

  test("never writes a negative or broken time", () => {
    expect(formatClock(-1_000)).toBe("0:00");
    expect(formatClock(Number.NaN)).toBe("0:00");
  });

  test("speaks the timeline's place as a part of the whole", () => {
    expect(timelineText(12_000, 65_000)).toBe("0:12 of 1:05");
  });
});

describe("the error on the timeline", () => {
  const start = 1_700_000_000_000;

  test("sits at its time from the recording's start", () => {
    expect(errorOffset(start, 90_000, start + 30_000)).toBe(30_000);
    expect(markerPercent(30_000, 90_000)).toBeCloseTo(33.333, 2);
  });

  test("is left out without a time, or outside the recording", () => {
    expect(errorOffset(start, 90_000, null)).toBeNull();
    expect(errorOffset(start, 90_000, start - 1)).toBeNull();
    // Just past the end, as when nothing changed after the error: at the end.
    expect(errorOffset(start, 90_000, start + 92_000)).toBe(90_000);
    expect(errorOffset(start, 90_000, start + 90_000 + 15_001)).toBeNull();
  });

  test("stays on the track", () => {
    expect(markerPercent(0, 90_000)).toBe(0);
    expect(markerPercent(90_000, 90_000)).toBe(100);
    expect(markerPercent(10, 0)).toBe(0);
  });

  test("playing starts a minute before it at most, never before the recording", () => {
    expect(startOffset(null)).toBe(0);
    expect(startOffset(30_000)).toBe(0);
    expect(startOffset(150_000)).toBe(90_000);
  });
});

describe("fitScale", () => {
  test("fits the whole viewport, keeping its shape", () => {
    expect(fitScale(800, 600, 1600, 900)).toBe(0.5);
    expect(fitScale(800, 300, 1600, 900)).toBeCloseTo(1 / 3, 5);
    expect(fitScale(1600, 1800, 800, 900)).toBe(2);
  });

  test("leaves it as it is without sizes", () => {
    expect(fitScale(0, 600, 1600, 900)).toBe(1);
    expect(fitScale(800, 600, 0, 900)).toBe(1);
  });
});

describe("readRecording", () => {
  const meta = {
    type: 4,
    timestamp: 1000,
    data: { href: "https://example.com/", width: 1280, height: 720 },
  };
  const snapshot = {
    type: 2,
    timestamp: 1001,
    data: { node: { type: 0, childNodes: [], id: 1 }, initialOffset: { top: 0, left: 0 } },
  };

  test("takes a version 1 recording, its events by time, with the first viewport's size", () => {
    const later = { type: 3, timestamp: 5000, data: { source: 2 } };
    const recording = readRecording({ v: 1, events: [later, meta, snapshot] });
    expect(recording).toEqual({ v: 1, events: [meta, snapshot, later], width: 1280, height: 720 });
  });

  test("refuses anything else", () => {
    for (const value of [
      null,
      [],
      "text",
      { v: 2, events: [meta, snapshot] },
      { v: 1 },
      { v: 1, events: [meta] },
      // No full snapshot: nothing to show.
      { v: 1, events: [meta, { ...meta, timestamp: 2000 }] },
      // No Meta event: no size.
      { v: 1, events: [snapshot, { ...snapshot, timestamp: 2000 }] },
      { v: 1, events: [{ ...meta, data: { width: "1280", height: 720 } }, snapshot] },
      { v: 1, events: [{ ...meta, data: { width: 0, height: 720 } }, snapshot] },
      { v: 1, events: [meta, snapshot, { type: "3", timestamp: 3, data: {} }] },
      { v: 1, events: [meta, snapshot, { type: 3, timestamp: Number.NaN, data: {} }] },
      { v: 1, events: [meta, snapshot, { type: 3, timestamp: 3, data: null }] },
      { v: 1, events: [meta, { type: 2, timestamp: 1001, data: {} }] },
    ]) {
      expect(readRecording(value)).toBeNull();
    }
  });
});

describe("messages from the dashboard", () => {
  test("takes a seek to a moment, in exactly its shape", () => {
    expect(readSeekMessage({ type: SEEK_MESSAGE, offsetMs: 0 })).toBe(0);
    expect(readSeekMessage({ type: SEEK_MESSAGE, offsetMs: 12_345.5 })).toBe(12_345.5);
  });

  test("ignores any other shape", () => {
    for (const data of [
      null,
      "ottertrail:replay-seek",
      [SEEK_MESSAGE, 1],
      { type: SEEK_MESSAGE },
      { type: SEEK_MESSAGE, offsetMs: "100" },
      { type: SEEK_MESSAGE, offsetMs: -1 },
      { type: SEEK_MESSAGE, offsetMs: Number.NaN },
      { type: SEEK_MESSAGE, offsetMs: Number.POSITIVE_INFINITY },
      { type: SEEK_MESSAGE, offsetMs: 86_400_001 },
      { type: TIME_MESSAGE, offsetMs: 1 },
      { type: "seek", offsetMs: 1 },
      // Anything more than the two keys.
      { type: SEEK_MESSAGE, offsetMs: 1, html: "<img onerror=alert(1)>" },
    ]) {
      expect(readSeekMessage(data)).toBeNull();
    }
  });

  test("comes only from the peer window, on its origin", () => {
    const parent = { postMessage: () => undefined };
    const peer = { window: parent, origin: "https://ottertrail.example" };
    expect(fromPeer({ origin: "https://ottertrail.example", source: parent }, peer)).toBe(true);
    expect(fromPeer({ origin: "https://evil.example", source: parent }, peer)).toBe(false);
    expect(fromPeer({ origin: "https://ottertrail.example", source: {} }, peer)).toBe(false);
    expect(fromPeer({ origin: "https://ottertrail.example", source: null }, peer)).toBe(false);
  });

  test("tells where the player is, in whole ms", () => {
    expect(timeMessage(1234.6, 60_000.2)).toEqual({
      type: TIME_MESSAGE,
      offsetMs: 1235,
      totalMs: 60_000,
    });
    expect(timeMessage(-5, 10).offsetMs).toBe(0);
  });
});
