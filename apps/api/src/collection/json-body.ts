import type { FastifyInstance } from "fastify";

/**
 * Parses text/plain bodies as JSON, with Fastify's secure parser, as it
 * parses application/json: a `__proto__` or `constructor` key is refused
 * (400). Pages send text/plain because it needs no CORS preflight.
 * Scoped to the plugin that calls it.
 */
export function parseTextPlainAsJson(app: FastifyInstance, bodyLimit: number): void {
  const parseJson = app.getDefaultJsonParser("error", "error");
  app.addContentTypeParser(
    "text/plain",
    { parseAs: "string", bodyLimit },
    (request, body, parsed) => {
      // The default parser is synchronous: it calls back before it returns.
      void parseJson(request, String(body), (error, value) => {
        if (error === null) {
          parsed(null, value);
        } else {
          parsed(
            Object.assign(
              new Error("The body is not valid JSON, or has a __proto__ or constructor key."),
              { statusCode: 400 },
            ),
          );
        }
      });
    },
  );
}
