import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { FastifyPluginCallback, FastifyReply, FastifyRequest } from "fastify";

/** Where sites load the tracker from: <script src="https://analytics.example.com/t.js">. */
export const TRACKER_SCRIPT_URL_PATH = "/t.js";

/**
 * The Web Vitals script the tracker loads from beside itself, built next to
 * it (packages/tracker/src/vitals.ts): v.js in the tracker's folder.
 */
export const VITALS_SCRIPT_URL_PATH = "/v.js";

/**
 * The session replay recorder the tracker loads from beside itself when a
 * page asks for it (packages/tracker/src/replay.ts; docs/session-replay.md):
 * r.js in the tracker's folder.
 */
export const REPLAY_SCRIPT_URL_PATH = "/r.js";

/**
 * Heatmap capture, which the tracker loads from beside itself when a page
 * asks for it (packages/tracker/src/heatmaps.ts; docs/web-analytics.md,
 * "Heatmaps"): h.js in the tracker's folder.
 */
export const HEATMAP_SCRIPT_URL_PATH = "/h.js";

/**
 * The heatmap overlay, which the tracker loads from beside itself when the
 * page's address carries an overlay link (packages/tracker/src/overlay.ts;
 * docs/web-analytics.md, "The overlay on your site"): o.js in the
 * tracker's folder.
 */
export const OVERLAY_SCRIPT_URL_PATH = "/o.js";

/**
 * Saved heatmap views, which the overlay loads from beside itself when the
 * owner presses "Save this view" (packages/tracker/src/snapshot.ts;
 * docs/web-analytics.md, "Saved views"): s.js in the tracker's folder.
 */
export const SNAPSHOT_SCRIPT_URL_PATH = "/s.js";

/**
 * Scripts found missing, logged once each: every page of every site asks
 * for them, and a missing v.js breaks nothing visible that would get it
 * noticed and fixed.
 */
const reportedMissing = new Set<string>();

interface LoadedScript {
  /** The file's identity: a rebuild changes its inode or change time, even at the same size. */
  version: string;
  script: Buffer;
  etag: string;
}

/** Each script as last read, by path: read and hashed again only when its file changes. */
const loaded = new Map<string, LoadedScript>();

async function loadScript(path: string): Promise<LoadedScript> {
  const { ino, ctimeMs, mtimeMs, size } = await stat(path);
  const version = `${ino}:${ctimeMs}:${mtimeMs}:${size}`;
  const cached = loaded.get(path);
  if (cached?.version === version) return cached;
  const script = await readFile(path);
  const etag = `"${createHash("sha256").update(script).digest("base64url").slice(0, 27)}"`;
  // The stat before the read: a build written in between is read again next time.
  const fresh = { version, script, etag };
  loaded.set(path, fresh);
  return fresh;
}

/** One built script, checked on each request, so a new build needs no restart. */
async function sendScript(request: FastifyRequest, reply: FastifyReply, path: string) {
  let script: Buffer;
  let etag: string;
  try {
    ({ script, etag } = await loadScript(path));
  } catch {
    loaded.delete(path);
    if (!reportedMissing.has(path)) {
      reportedMissing.add(path);
      request.log.error(
        { scriptPath: path },
        "a tracker script is missing; run `vp run -r build` (logged once)",
      );
    }
    return reply
      .code(503)
      .header("cache-control", "no-store")
      .type("text/plain; charset=utf-8")
      .send("The tracker script has not been built on this instance.");
  }
  reply
    .header("cache-control", "public, max-age=3600")
    .header("etag", etag)
    .header("x-content-type-options", "nosniff")
    // Lets sites that isolate themselves (Cross-Origin-Embedder-Policy) load it.
    .header("cross-origin-resource-policy", "cross-origin");
  if (request.headers["if-none-match"] === etag) {
    return reply.code(304).send();
  }
  return reply.type("text/javascript; charset=utf-8").send(script);
}

/**
 * Serves the built browser tracker, and the Web Vitals, session replay,
 * heatmap, and heatmap overlay scripts it loads, so each site loads them from the instance it reports to. The paths are
 * short and neutral: ad-block lists often match file names such as
 * "tracker.js" or "analytics.js".
 *
 * Each file is kept in memory with its ETag, and its inode, change and
 * modification times, and size checked on each request, so a new build is served without
 * restarting the API. Browsers may cache them for an hour and then
 * revalidate them with their ETags.
 */
export const trackerScriptRoutes: FastifyPluginCallback<{ scriptPath: string }> = (
  app,
  { scriptPath },
  done,
) => {
  app.get(TRACKER_SCRIPT_URL_PATH, (request, reply) => sendScript(request, reply, scriptPath));
  app.get(VITALS_SCRIPT_URL_PATH, (request, reply) =>
    sendScript(request, reply, join(dirname(scriptPath), "v.js")),
  );
  app.get(REPLAY_SCRIPT_URL_PATH, (request, reply) =>
    sendScript(request, reply, join(dirname(scriptPath), "r.js")),
  );
  app.get(HEATMAP_SCRIPT_URL_PATH, (request, reply) =>
    sendScript(request, reply, join(dirname(scriptPath), "h.js")),
  );
  app.get(OVERLAY_SCRIPT_URL_PATH, (request, reply) =>
    sendScript(request, reply, join(dirname(scriptPath), "o.js")),
  );
  app.get(SNAPSHOT_SCRIPT_URL_PATH, (request, reply) =>
    sendScript(request, reply, join(dirname(scriptPath), "s.js")),
  );
  done();
};
