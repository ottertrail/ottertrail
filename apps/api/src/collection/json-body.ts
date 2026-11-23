import type { FastifyInstance } from "fastify";

/**
 * text/plain avoids CORS preflights. Use Fastify's secure JSON parser to reject __proto__ and
 * constructor keys with 400. Scoped to the calling plugin.
 */
export function parseTextPlainAsJson(app: FastifyInstance, bodyLimit: number): void {
  const parseJson = app.getDefaultJsonParser("error", "error");
  app.addContentTypeParser(
    "text/plain",
    { parseAs: "string", bodyLimit },
    (request, body, parsed) => {
      // The default parser invokes its callback synchronously.
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
