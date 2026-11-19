/**
 * dist/player.js: the script of the player page the API serves at
 * /api/projects/:id/replays/:replayId/player. Its body names the recording
 * and the error's time.
 */
import { startPlayer } from "./player.ts";

function errorAtOf(text: string | undefined): number | null {
  if (text === undefined || !/^\d+$/.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
}

const { replayUrl, errorAt } = document.body.dataset;
// Only a path on this origin: the page's own policy allows nothing else.
if (replayUrl !== undefined && replayUrl.startsWith("/") && !replayUrl.startsWith("//")) {
  startPlayer(document.body, {
    replayUrl,
    errorAt: errorAtOf(errorAt),
    // The dashboard that frames this page (frame-ancestors 'self'): the
    // parent window, on this page's own origin. Not framed: no messages.
    peer: window.parent === window ? null : { window: window.parent, origin: location.origin },
  });
} else {
  const message = document.createElement("p");
  message.setAttribute("role", "alert");
  message.textContent = "This page does not specify a replay.";
  document.body.append(message);
}
