import { describe, expect, test } from "vite-plus/test";

import {
  readTimeMessage,
  SEEK_MESSAGE,
  seekMessage,
  TIME_MESSAGE,
} from "../src/lib/replay-messages.ts";

const ORIGIN = "https://ottertrail.example";
/** The player's frame window: the check compares it, nothing more. */
const frame = {};

describe("messages with the replay player", () => {
  test("asks the player to move, in whole ms, within a day", () => {
    expect(seekMessage(1234.4)).toEqual({ type: SEEK_MESSAGE, offsetMs: 1234 });
    expect(seekMessage(-5).offsetMs).toBe(0);
    expect(seekMessage(10 ** 12).offsetMs).toBe(86_400_000);
  });

  test("hears where the player is, only from its frame, on its origin, in its shape", () => {
    const data = { type: TIME_MESSAGE, offsetMs: 5000, totalMs: 60_000 };
    expect(readTimeMessage({ origin: ORIGIN, source: frame, data }, frame, ORIGIN)).toEqual({
      offsetMs: 5000,
      totalMs: 60_000,
    });
    const ignored = [
      // Another origin, another window, no frame yet.
      [{ origin: "https://evil.example", source: frame, data }, frame],
      [{ origin: ORIGIN, source: {}, data }, frame],
      [{ origin: ORIGIN, source: null, data }, frame],
      [{ origin: ORIGIN, source: frame, data }, null],
      // Other shapes.
      [{ origin: ORIGIN, source: frame, data: null }, frame],
      [{ origin: ORIGIN, source: frame, data: "5000" }, frame],
      [{ origin: ORIGIN, source: frame, data: [TIME_MESSAGE, 5000, 60_000] }, frame],
      [{ origin: ORIGIN, source: frame, data: { ...data, type: SEEK_MESSAGE } }, frame],
      [{ origin: ORIGIN, source: frame, data: { ...data, offsetMs: "5000" } }, frame],
      [{ origin: ORIGIN, source: frame, data: { ...data, offsetMs: -1 } }, frame],
      [{ origin: ORIGIN, source: frame, data: { ...data, totalMs: Number.NaN } }, frame],
      [{ origin: ORIGIN, source: frame, data: { type: TIME_MESSAGE, offsetMs: 1 } }, frame],
      [{ origin: ORIGIN, source: frame, data: { ...data, html: "<b>" } }, frame],
    ] as const;
    for (const [event, from] of ignored) {
      expect(readTimeMessage(event, from, ORIGIN)).toBeNull();
    }
  });
});
