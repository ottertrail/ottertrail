/**
 * Cuts a recording into the pieces the API takes (docs/session-replay.md,
 * "Sending"): the recording is the JSON text {"v":1,"events":[…]}, and each
 * piece is one gzip member of a part of that text, at most MAX_CHUNK_BYTES.
 * Joined in order and decompressed, the pieces give the text back exactly.
 *
 * A recording past MAX_REPLAY_BYTES in all is cut at an event's end: its
 * last piece closes the JSON, and is marked cut.
 */

/** Largest piece, in bytes: under the 64 KB browsers allow a beacon or keepalive request. */
export const MAX_CHUNK_BYTES = 60_000;
/** Largest recording, in compressed bytes over all its pieces. */
export const MAX_REPLAY_BYTES = 2_000_000;
/** Room kept for the piece that closes a cut recording: gzip of "]}" is about 22 bytes. */
const CLOSING_ROOM = 64;

const HEADER = '{"v":1,"events":[';
const FOOTER = "]}";

/** One compressed piece, in the order it is sent. */
export interface Piece {
  bytes: Uint8Array<ArrayBuffer>;
  /** The recording's last piece. */
  last: boolean;
  /** The recording was cut at MAX_REPLAY_BYTES. Only on the last piece. */
  cut: boolean;
}

/** One gzip member of the text, in UTF-8. CompressionStream works off the main thread. */
export async function gzip(text: string): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** True when ending the text at `end` would split a character made of two UTF-16 units. */
const splits = (text: string, end: number) => {
  const code = text.charCodeAt(end - 1);
  return end < text.length && code >= 0xd800 && code <= 0xdbff;
};

/** A text too large for one piece, in pieces: each try halved until it fits. */
async function splitText(text: string): Promise<Uint8Array<ArrayBuffer>[]> {
  const pieces: Uint8Array<ArrayBuffer>[] = [];
  let start = 0;
  let length = text.length;
  while (start < text.length) {
    // Even pieces of at most `length`, so no tiny piece is left at the end.
    const rest = text.length - start;
    let end = start + Math.ceil(rest / Math.ceil(rest / length));
    if (splits(text, end)) end -= 1;
    const bytes = await gzip(text.slice(start, end));
    if (bytes.length > MAX_CHUNK_BYTES && end - start > 1) {
      length = Math.max(1, Math.floor((end - start) / 2));
      continue;
    }
    pieces.push(bytes);
    start = end;
  }
  return pieces;
}

export interface Packer {
  /**
   * Compresses more events (each one JSON text), in order. With `final`,
   * the recording ends after them. Resolves with the pieces now ready.
   */
  add(events: string[], final: boolean): Promise<Piece[]>;
  /** True once the last piece is made: nothing more is added. */
  done(): boolean;
}

export function createPacker(): Packer {
  let started = false;
  let closed = false;
  let total = 0;
  /** Characters of JSON tried per piece, adjusted as pieces come out. */
  let target = 256 * 1024;

  async function add(events: string[], final: boolean): Promise<Piece[]> {
    const ready: Piece[] = [];
    let i = 0;
    // Until every event is packed, and with `final`, until the JSON is closed.
    for (;;) {
      if (closed || (i >= events.length && !final)) break;
      // As many whole events as the target allows, at least one.
      let j = i;
      let length = 0;
      while (j < events.length && (j === i || length + (events[j]?.length ?? 0) < target)) {
        length += (events[j]?.length ?? 0) + 1;
        j += 1;
      }
      const ends = final && j === events.length;
      const text =
        (started ? (i < j ? "," : "") : HEADER) +
        events.slice(i, j).join(",") +
        (ends ? FOOTER : "");
      let pieces: Uint8Array<ArrayBuffer>[];
      const bytes = await gzip(text);
      if (bytes.length <= MAX_CHUNK_BYTES) {
        pieces = [bytes];
        // Aim the next piece at about 55 KB compressed.
        target = Math.max(
          1024,
          Math.min(1024 * 1024, Math.floor((text.length * 55_000) / Math.max(1, bytes.length))),
        );
      } else if (j - i > 1) {
        target = Math.max(1, Math.floor(length / 2));
        continue; // Halved: fewer events.
      } else {
        pieces = await splitText(text); // One event larger than a piece.
      }
      const size = pieces.reduce((sum, piece) => sum + piece.length, 0);
      if (total + size > MAX_REPLAY_BYTES - (ends ? 0 : CLOSING_ROOM)) {
        // Past the limit: close the JSON after the last whole event sent.
        closed = true;
        ready.push({
          bytes: await gzip(started ? FOOTER : HEADER + FOOTER),
          last: true,
          cut: true,
        });
        break;
      }
      total += size;
      started = true;
      ready.push(...pieces.map((piece) => ({ bytes: piece, last: false, cut: false })));
      i = j;
      if (ends) {
        closed = true;
        const lastPiece = ready.at(-1);
        if (lastPiece !== undefined) lastPiece.last = true;
      }
    }
    return ready;
  }

  return { add, done: () => closed };
}
