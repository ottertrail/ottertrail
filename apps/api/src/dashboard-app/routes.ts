import { existsSync } from "node:fs";
import { basename, extname, join, sep } from "node:path";

import fastifyStatic from "@fastify/static";
import type { FastifyPluginAsync, FastifyReply } from "fastify";

/**
 * What the dashboard's pages may load: only files from this instance. The
 * built dashboard has no inline scripts and loads its styles from its own
 * files. Vite inlines files under 4 KB as data: URLs, which includes one of
 * the font subsets. `frame-ancestors 'none'` stops other sites from framing
 * a signed-in dashboard to trick clicks out of it.
 */
export const DASHBOARD_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

/**
 * Whether to send Strict-Transport-Security for this public URL: HTTPS, and
 * not this computer. A browser that kept HSTS for localhost would refuse
 * plain-HTTP development servers there (any port) for a year.
 */
export function sendsHsts(publicUrl: string): boolean {
  const url = URL.parse(publicUrl);
  if (url === null || url.protocol !== "https:") {
    return false;
  }
  const host = url.hostname;
  return !(
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "[::1]" ||
    /^127\.\d+\.\d+\.\d+$/.test(host)
  );
}

/** Vite's build output, whose names change with their content: safe to cache for good. */
const HASHED_ASSETS_DIRECTORY = "assets";

/**
 * Serves the built dashboard (apps/web/dist) from the instance's own origin,
 * so one process answers the dashboard, its API, and the tracker.
 *
 * - Files that exist at startup get a route each; a new build needs a restart.
 * - Any other GET without a file extension, outside /api/, answers with
 *   index.html: the dashboard's router reads the path in the browser.
 * - index.html is revalidated on every load, so a new release shows at once;
 *   hashed files under /assets/ are cached for a year.
 *
 * Without a build (index.html missing), pages answer 503, as /t.js does.
 */
export const dashboardAppRoutes: FastifyPluginAsync<{
  /** The built dashboard's directory. */
  root: string;
  /** Send Strict-Transport-Security (see sendsHsts). */
  hsts: boolean;
}> = async (app, { root, hsts }) => {
  app.addHook("onSend", async (_request, reply) => {
    reply
      .header("content-security-policy", DASHBOARD_CONTENT_SECURITY_POLICY)
      .header("x-frame-options", "DENY")
      .header("x-content-type-options", "nosniff")
      // Dashboard URLs hold project IDs and filters: other sites need not see them.
      .header("referrer-policy", "same-origin");
    if (hsts) {
      reply.header("strict-transport-security", "max-age=31536000");
    }
  });

  if (!existsSync(join(root, "index.html"))) {
    app.log.warn({ root }, "the dashboard is not built here; run `vp run -r build`");
    app.get("/*", async (request, reply) => {
      if (!isPagePath(request.url)) {
        return reply.callNotFound();
      }
      return reply
        .code(503)
        .header("cache-control", "no-store")
        .type("text/plain; charset=utf-8")
        .send("The dashboard has not been built on this instance.");
    });
    return;
  }

  const hashedPrefix = join(root, HASHED_ASSETS_DIRECTORY) + sep;
  await app.register(fastifyStatic, {
    root,
    // A route per file found at startup, instead of reading any path asked for.
    wildcard: false,
    cacheControl: false,
    setHeaders(reply: FastifyReply, path: string) {
      reply.header("cache-control", cacheControlFor(path, hashedPrefix));
    },
  });

  app.get("/*", async (request, reply) => {
    if (!isPagePath(request.url)) {
      return reply.callNotFound();
    }
    return reply.sendFile("index.html");
  });
};

function cacheControlFor(path: string, hashedPrefix: string): string {
  if (basename(path) === "index.html") {
    return "no-cache";
  }
  if (path.startsWith(hashedPrefix)) {
    return "public, max-age=31536000, immutable";
  }
  return "public, max-age=3600";
}

/**
 * A path the dashboard's router may own: not the API, and not a missing
 * file such as /assets/old-build.js, which must stay a 404 instead of
 * turning into a page. Every path under /projects/ is a page, extension or
 * not: a user's page ends in the site's own ID, which may hold a dot
 * (/projects/…/users/john.doe).
 */
function isPagePath(url: string): boolean {
  const path = url.split("?", 1)[0] ?? "";
  if (path === "/api" || path.startsWith("/api/")) return false;
  return path.startsWith("/projects/") || extname(path) === "";
}
