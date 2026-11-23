import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { FastifyPluginCallback, FastifyReply, FastifyRequest } from "fastify";

export const TRACKER_SCRIPT_URL_PATH = "/t.js";

/** Built from packages/tracker/src/vitals.ts beside the tracker. */
export const VITALS_SCRIPT_URL_PATH = "/v.js";

/** Loaded on demand (packages/tracker/src/replay.ts; docs/session-replay.md). */
export const REPLAY_SCRIPT_URL_PATH = "/r.js";

/** Loaded on demand (packages/tracker/src/heatmaps.ts; docs/web-analytics.md, "Heatmaps"). */
export const HEATMAP_SCRIPT_URL_PATH = "/h.js";

/**
 * Loaded for overlay links (packages/tracker/src/overlay.ts; docs/web-analytics.md, "The overlay
 * on your site").
 */
export const OVERLAY_SCRIPT_URL_PATH = "/o.js";

/**
 * Loaded for Save this view (packages/tracker/src/snapshot.ts; docs/web-analytics.md, "Saved
 * views").
 */
export const SNAPSHOT_SCRIPT_URL_PATH = "/s.js";

/** Log missing scripts once: repeated requests are noisy and missing v.js has no visible failure. */
const reportedMissing = new Set<string>();

interface LoadedScript {
  /** Inode or change time detects same-size rebuilds. */
  version: string;
  script: Buffer;
  etag: string;
}

/** Reread and rehash only when the file changes. */
const loaded = new Map<string, LoadedScript>();

async function loadScript(path: string): Promise<LoadedScript> {
  const { ino, ctimeMs, mtimeMs, size } = await stat(path);
  const version = `${ino}:${ctimeMs}:${mtimeMs}:${size}`;
  const cached = loaded.get(path);
  if (cached?.version === version) return cached;
  const script = await readFile(path);
  const etag = `"${createHash("sha256").update(script).digest("base64url").slice(0, 27)}"`;
  // Use pre-read stat so a concurrent rebuild triggers another read next request.
  const fresh = { version, script, etag };
  loaded.set(path, fresh);
  return fresh;
}

/** Checks each request so rebuilds need no restart. */
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
    // Allows loading from pages using Cross-Origin-Embedder-Policy.
    .header("cross-origin-resource-policy", "cross-origin");
  if (request.headers["if-none-match"] === etag) {
    return reply.code(304).send();
  }
  return reply.type("text/javascript; charset=utf-8").send(script);
}

/**
 * Short neutral paths avoid common ad-block matches such as tracker.js or analytics.js. Check file
 * identity per request to serve rebuilds without restarting. Cache in memory with ETags; browsers
 * revalidate after one hour.
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
