import { existsSync } from "node:fs";
import { basename, extname, join, sep } from "node:path";

import fastifyStatic from "@fastify/static";
import type { FastifyPluginAsync, FastifyReply } from "fastify";

/**
 * Vite inlines files under 4 KB, including a font subset, as data: URLs.
 * Blocking frames prevents clickjacking of the signed-in dashboard.
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

/** HSTS on localhost would block plain HTTP development servers on every port for a year. */
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

/** Content hashes make these assets safe to cache for a year. */
const HASHED_ASSETS_DIRECTORY = "assets";

/**
 * Files are registered at startup, so a new build needs a restart.
 * Revalidate index.html on each load; cache hashed /assets/ files for a year.
 * Missing index.html returns 503. Other page paths use the browser router.
 */
export const dashboardAppRoutes: FastifyPluginAsync<{
  root: string;
  /** See sendsHsts for localhost exclusions. */
  hsts: boolean;
}> = async (app, { root, hsts }) => {
  app.addHook("onSend", async (_request, reply) => {
    reply
      .header("content-security-policy", DASHBOARD_CONTENT_SECURITY_POLICY)
      .header("x-frame-options", "DENY")
      .header("x-content-type-options", "nosniff")
      // Keep project IDs and filters out of cross-origin referrers.
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
    // Register known files to avoid serving arbitrary paths.
    wildcard: false,
    cacheControl: false,
    setHeaders(reply: FastifyReply, path: string) {
      reply.header("cache-control", cacheControlFor(path, hashedPrefix));
    },
  });

  const sharePage = existsSync(join(root, SHARE_PAGE));
  app.get("/*", async (request, reply) => {
    if (!isPagePath(request.url)) {
      return reply.callNotFound();
    }
    if (isSharePath(request.url)) {
      // A shared link's page is its own small app, without the signed-in dashboard's code.
      if (!sharePage) return reply.callNotFound();
      return reply.header("x-robots-tag", "noindex, nofollow").sendFile(SHARE_PAGE);
    }
    return reply.sendFile("index.html");
  });
};

/** The page of a shared link (docs/web-analytics.md, "Shared links"), a second entry of the build. */
const SHARE_PAGE = "share.html";

/** `/share/<token>`: a shared link's page. */
function isSharePath(url: string): boolean {
  const path = url.split("?", 1)[0] ?? "";
  return path.startsWith("/share/");
}

function cacheControlFor(path: string, hashedPrefix: string): string {
  if (basename(path) === "index.html" || basename(path) === SHARE_PAGE) {
    return "no-cache";
  }
  if (path.startsWith(hashedPrefix)) {
    return "public, max-age=31536000, immutable";
  }
  return "public, max-age=3600";
}

/**
 * Missing files must stay 404. /projects/ paths can contain dots in user IDs
 * (/projects/…/users/john.doe), so they always count as pages.
 */
function isPagePath(url: string): boolean {
  const path = url.split("?", 1)[0] ?? "";
  if (path === "/api" || path.startsWith("/api/")) return false;
  return path.startsWith("/projects/") || extname(path) === "";
}
