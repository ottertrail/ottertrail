/**
 * Messages between the dashboard and the replay player, which runs in a
 * frame on the dashboard's own origin under its own Content Security
 * Policy (docs/session-replay.md, "The timeline"). The dashboard asks the
 * player to move to a moment; the player says where it is. The player has
 * the same names (packages/replay-player/src/format.ts). Each side takes a
 * message only from the other window, from its own origin, in exactly this
 * shape; anything else is ignored.
 */
export const SEEK_MESSAGE = "ottertrail:replay-seek";
export const TIME_MESSAGE = "ottertrail:replay-time";
/** Offsets past this are no moment of any replay: a day. */
const MAX_OFFSET_MS = 86_400_000;

/** Asks the player to move to `offsetMs` from the recording's start. */
export const seekMessage = (offsetMs: number) => ({
  type: SEEK_MESSAGE,
  offsetMs: Math.min(MAX_OFFSET_MS, Math.max(0, Math.round(offsetMs))),
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isOffset = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_OFFSET_MS;

/**
 * Where the player is, from a message event: only from the player's frame
 * (`frame`), on `origin`, in exactly the player's shape; null for anything
 * else.
 */
export function readTimeMessage(
  event: { origin: string; source: unknown; data: unknown },
  frame: object | null | undefined,
  origin: string,
): { offsetMs: number; totalMs: number } | null {
  if (frame === null || frame === undefined || event.source !== frame || event.origin !== origin) {
    return null;
  }
  const { data } = event;
  if (!isRecord(data)) return null;
  const keys = Object.keys(data);
  if (keys.length !== 3 || !["type", "offsetMs", "totalMs"].every((key) => keys.includes(key))) {
    return null;
  }
  const { type, offsetMs, totalMs } = data;
  if (type !== TIME_MESSAGE || !isOffset(offsetMs) || !isOffset(totalMs)) return null;
  return { offsetMs, totalMs };
}
