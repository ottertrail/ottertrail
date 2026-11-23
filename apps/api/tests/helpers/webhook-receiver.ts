import { Buffer } from "node:buffer";
import http, { type IncomingHttpHeaders } from "node:http";

/**
 * /hook uses `answer`; /slow times out. Other paths return 200 so followed
 * redirects appear in `requests`.
 */
export interface WebhookReceiver {
  /** http://127.0.0.1:<port> */
  origin: string;
  port: number;
  requests: { method: string; path: string; headers: IncomingHttpHeaders; body: string }[];
  answer: { status: number; location?: string | undefined };
  close(): Promise<void>;
}

export async function startWebhookReceiver(): Promise<WebhookReceiver> {
  const state: Pick<WebhookReceiver, "requests" | "answer"> = {
    requests: [],
    answer: { status: 200 },
  };
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const path = request.url ?? "/";
      state.requests.push({
        method: request.method ?? "",
        path,
        headers: request.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      if (path === "/slow") return;
      if (path === "/hook") {
        const { status, location } = state.answer;
        response.writeHead(status, location === undefined ? {} : { location });
        response.end("an answer the sender does not read");
        return;
      }
      response.writeHead(200);
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    ...state,
    origin: `http://127.0.0.1:${port}`,
    port,
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
