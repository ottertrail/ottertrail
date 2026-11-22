/**
 * dist/player.js: the script of the player pages the API serves. The
 * replay player's (/api/projects/:id/replays/:replayId/player) body names
 * the recording and the error's time; a saved heatmap view's
 * (/api/projects/:id/heatmaps/snapshots/:device/player) names the
 * snapshot and its heatmap (snapshot.ts).
 */
import { startPlayer } from "./player.ts";
import { startSnapshot } from "./snapshot.ts";

function errorAtOf(text: string | undefined): number | null {
  if (text === undefined || !/^\d+$/.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
}

/** Only a path on this origin: the page's own policy allows nothing else. */
const isOwnPath = (url: string | undefined): url is string =>
  url !== undefined && url.startsWith("/") && !url.startsWith("//");

const { replayUrl, errorAt, snapshotUrl, heatmapUrl } = document.body.dataset;
// The dashboard that frames this page (frame-ancestors 'self'): the
// parent window, on this page's own origin. Not framed: no messages.
const peer = window.parent === window ? null : { window: window.parent, origin: location.origin };
if (isOwnPath(snapshotUrl) && isOwnPath(heatmapUrl)) {
  startSnapshot(document.body, { snapshotUrl, heatmapUrl, peer });
} else if (isOwnPath(replayUrl)) {
  startPlayer(document.body, { replayUrl, errorAt: errorAtOf(errorAt), peer });
} else {
  const message = document.createElement("p");
  message.setAttribute("role", "alert");
  message.textContent = "This page does not specify a replay.";
  document.body.append(message);
}
