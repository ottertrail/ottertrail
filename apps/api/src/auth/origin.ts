import type { FastifyReply, FastifyRequest } from "fastify";

/**
 * Config.trustedOrigins may use :* to allow any port for a protocol and host
 * in development, such as http://localhost:*.
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
 * SameSite=Lax permits sibling subdomains. Requiring the dashboard Origin
 * blocks cross-site request forgery from those subdomains too.
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
 * Protect sensitive reads such as the Server log stream. Reject cross-site
 * Sec-Fetch-Site or untrusted Origin headers. Clients sending neither header
 * (such as curl with a session cookie) pass.
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
