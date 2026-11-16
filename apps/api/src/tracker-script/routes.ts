import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { FastifyPluginCallback } from "fastify";

/** Where sites load the tracker from: <script src="https://analytics.example.com/t.js">. */
export const TRACKER_SCRIPT_URL_PATH = "/t.js";

/**
 * Serves the built browser tracker, so each site loads it from the
 * instance it reports to. The path is short and neutral: ad-block lists
 * often match file names such as "tracker.js" or "analytics.js".
 *
 * The file is read on each request (it is about 5 KB), so a new build is
 * served without restarting the API. Browsers may cache it for an hour and
 * then revalidate it with its ETag.
 */
export const trackerScriptRoutes: FastifyPluginCallback<{ scriptPath: string }> = (
  app,
  { scriptPath },
  done,
) => {
  app.get(TRACKER_SCRIPT_URL_PATH, async (request, reply) => {
    let script: Buffer;
    try {
      script = await readFile(scriptPath);
    } catch {
      request.log.error({ scriptPath }, "the tracker script is missing; run `vp run -r build`");
      return reply
        .code(503)
        .header("cache-control", "no-store")
        .type("text/plain; charset=utf-8")
        .send("The tracker script has not been built on this instance.");
    }
    const etag = `"${createHash("sha256").update(script).digest("base64url").slice(0, 27)}"`;
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
  });
  done();
};
