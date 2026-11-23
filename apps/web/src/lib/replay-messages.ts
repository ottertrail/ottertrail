/**
 * Dashboard/player messages (docs/session-replay.md, "The timeline"). Keep names aligned
 * with packages/replay-player/src/format.ts. The iframe has its own Content Security Policy.
 * Accept only messages of this shape from the other window on this origin.
 */
export const SEEK_MESSAGE = "ottertrail:replay-seek";
export const TIME_MESSAGE = "ottertrail:replay-time";
export const PAUSE_MESSAGE = "ottertrail:replay-pause";
export const THEME_MESSAGE = "ottertrail:replay-theme";
/** Offsets past this are no moment of any replay: a day. */
const MAX_OFFSET_MS = 86_400_000;

/** Asks the player to move to `offsetMs` from the recording's start. */
export const seekMessage = (offsetMs: number) => ({
  type: SEEK_MESSAGE,
  offsetMs: Math.min(MAX_OFFSET_MS, Math.max(0, Math.round(offsetMs))),
});

/** Asks the player to pause, as when its pane is hidden. */
export const pauseMessage = () => ({ type: PAUSE_MESSAGE });

/** Gives the player the dashboard's theme, as it changes (its page opens in it: playerUrlInTheme). */
export const themeMessage = (theme: "light" | "dark") => ({ type: THEME_MESSAGE, theme });

/** The player page's address with the dashboard's theme, for its first paint. */
export function playerUrlInTheme(playerSrc: string, theme: "light" | "dark"): string {
  return `${playerSrc}${playerSrc.includes("?") ? "&" : "?"}theme=${theme}`;
}

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
