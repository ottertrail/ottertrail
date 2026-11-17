import { gunzipSync } from "node:zlib";

import { describe, expect, test } from "vite-plus/test";

import { createPacker, MAX_CHUNK_BYTES, MAX_REPLAY_BYTES, type Piece } from "../src/replay-pack.ts";

/** The pieces joined and decompressed, as the API reads them (zlib reads every gzip member). */
const unpack = (pieces: Piece[]) =>
  gunzipSync(Buffer.concat(pieces.map((piece) => piece.bytes))).toString("utf8");

/** Text that hardly compresses. */
function noise(
  length: number,
  alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
) {
  const characters = Array.from(alphabet); // Whole characters, not UTF-16 units.
  let text = "";
  for (let i = 0; i < length; i += 1) {
    text += characters[Math.floor(Math.random() * characters.length)];
  }
  return text;
}

/** Random characters outside the BMP, which hardly compress. */
const astral = (length: number) =>
  Array.from({ length }, () =>
    String.fromCodePoint(0x2_00_00 + Math.floor(Math.random() * 40_000)),
  ).join("");

const event = (n: number, payload = "") => JSON.stringify({ type: 3, n, payload });

function expectPieces(pieces: Piece[], cut = false) {
  expect(pieces.filter((piece) => piece.last)).toHaveLength(1);
  expect(pieces.at(-1)).toMatchObject({ last: true, cut });
  for (const piece of pieces) expect(piece.bytes.length).toBeLessThanOrEqual(MAX_CHUNK_BYTES);
}

describe("packing a recording", () => {
  test("small events make one piece of the whole JSON", async () => {
    const packer = createPacker();
    const pieces = await packer.add([event(1), event(2)], true);
    expectPieces(pieces);
    expect(pieces).toHaveLength(1);
    expect(unpack(pieces)).toBe(`{"v":1,"events":[${event(1)},${event(2)}]}`);
    expect(packer.done()).toBe(true);
    expect(await packer.add([event(3)], true)).toEqual([]);
  });

  test("events added in steps join into the same JSON", async () => {
    const packer = createPacker();
    const first = await packer.add([event(1)], false);
    const second = await packer.add([], false);
    const third = await packer.add([event(2), event(3)], true);
    const pieces = [...first, ...second, ...third];
    expectPieces(pieces);
    expect(JSON.parse(unpack(pieces))).toEqual({
      v: 1,
      events: [1, 2, 3].map((n) => ({ type: 3, n, payload: "" })),
    });
  });

  test("an event larger than a piece is split, characters kept whole", async () => {
    // Characters outside the BMP are two UTF-16 units: a split between them
    // would break the text. Random ones hardly compress, so the event must be
    // split, wherever they start.
    for (const prefix of ["", "a", "aa", "aaa", "aaaa", "aaaaa"]) {
      const big = event(1, prefix + astral(60_000));
      const pieces = await createPacker().add([event(0), big, event(2)], true);
      expectPieces(pieces);
      expect(pieces.length).toBeGreaterThan(3);
      const text = unpack(pieces);
      expect(text).not.toContain("\uFFFD"); // A replacement character: a broken pair.
      expect(text).toBe(`{"v":1,"events":[${event(0)},${big},${event(2)}]}`);
    }
  }, 30_000);

  test("past 2 MB, the recording ends after the last whole event that fits, marked cut", async () => {
    const events = Array.from({ length: 40 }, (_, n) => event(n, noise(80_000)));
    const pieces = await createPacker().add(events, true);
    expectPieces(pieces, true);
    const total = pieces.reduce((sum, piece) => sum + piece.bytes.length, 0);
    expect(total).toBeLessThanOrEqual(MAX_REPLAY_BYTES);
    const recording = JSON.parse(unpack(pieces)) as { v: number; events: { n: number }[] };
    expect(recording.events.length).toBeGreaterThan(20);
    expect(recording.events.length).toBeLessThan(40);
    expect(recording.events.map((item) => item.n)).toEqual(recording.events.map((_, n) => n));
  }, 30_000);
});
