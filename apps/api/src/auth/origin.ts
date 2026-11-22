import type { FastifyReply, FastifyRequest } from "fastify";

/**
 * Whether a browser's Origin header is one of the trusted origins
 * (Config.trustedOrigins). A pattern ending in ":*" accepts any port of
 * that protocol and host, as development needs ("http://localhost:*").
 */
export function isTrustedOrigin(origin: string, trustedOrigins: readonly string[]): boolean {
  const url = URL.parse(origin);
  if (url === null || url.origin !== origin) {
    return false;
  }
  return trustedOrigins.some((pattern) => {
    if (!pattern.endsWith(":*")) {
      return pattern === origin;
    }
    const base = URL.parse(pattern.slice(0, -2));
    return (
      base !== null &&
      base.protocol === url.protocol &&
      base.hostname === url.hostname &&
      /^\d+$/.test(url.port)
    );
  });
}

/**
 * A preHandler for dashboard requests that change something. The session
 * cookie is SameSite=Lax, which already keeps it off other sites' form posts
 * and background requests, but sites on sibling subdomains count as the same
 * site. Requiring the dashboard's own Origin closes that gap (cross-site
 * request forgery). Browsers send Origin with every POST, PATCH, and DELETE.
 */
export function requireTrustedOrigin(trustedOrigins: readonly string[]) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const origin = request.headers.origin;
    if (origin === undefined || !isTrustedOrigin(origin, trustedOrigins)) {
      return reply.code(403).send({
        error: "untrusted_origin",
        message: "This request must come from the dashboard.",
      });
    }
    return undefined;
  };
}

/**
 * A preHandler for dashboard reads a page on another site must not open,
 * such as the Server log's stream, which holds one of a few places: a
 * browser marks a same-origin GET with `Sec-Fetch-Site: same-origin`, and
 * sends Origin only on some, so any other Sec-Fetch-Site, or an Origin
 * that is not the dashboard's, is refused. A client that sends neither
 * (curl, with the session's cookie) passes.
 */
export function requireSameOriginRead(trustedOrigins: readonly string[]) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const site = request.headers["sec-fetch-site"];
    const origin = request.headers.origin;
    if (
      (site !== undefined && site !== "same-origin") ||
      (origin !== undefined && !isTrustedOrigin(origin, trustedOrigins))
    ) {
      return reply.code(403).send({
        error: "untrusted_origin",
        message: "This request must come from the dashboard.",
      });
    }
    return undefined;
  };
}
