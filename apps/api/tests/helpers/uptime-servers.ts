import http from "node:http";
import https from "node:https";

import type { Lookup } from "../../src/outbound/addresses.ts";
import { makeCertificate, type TestCertificate } from "./certificate.ts";

/**
 * Local HTTP and HTTPS servers. See `answer` for each path's behavior.
 */
export interface UptimeServers {
  http: string;
  https: string;
  certificate: TestCertificate;
  /** What /flaky answers. */
  flaky: { status: number };
  requests: string[];
  /** Runs before /hook sends its response. */
  onHook: { run: () => Promise<void> };
  close(): Promise<void>;
}

const MEGABYTE = 1024 * 1024;

function answer(
  servers: Pick<UptimeServers, "flaky" | "requests" | "onHook">,
  request: http.IncomingMessage,
  response: http.ServerResponse,
) {
  const url = new URL(request.url ?? "/", "http://placeholder");
  servers.requests.push(url.pathname);
  const redirect = /^\/redirect\/(\d+)$/.exec(url.pathname);
  if (redirect?.[1] !== undefined) {
    const left = Number(redirect[1]);
    response.writeHead(302, { location: left === 0 ? "/ok" : `/redirect/${left - 1}` });
    response.end();
    return;
  }
  switch (url.pathname) {
    case "/ok":
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("Everything is fine. status: healthy");
      return;
    case "/flaky":
      response.writeHead(servers.flaky.status);
      response.end(servers.flaky.status < 400 ? "healthy" : "broken");
      return;
    case "/teapot":
      response.writeHead(418);
      response.end("short and stout");
      return;
    case "/no-content":
      response.writeHead(204);
      response.end();
      return;
    case "/slow":
      // Never answers: the check's timeout ends it.
      return;
    case "/metadata":
      response.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" });
      response.end();
      return;
    case "/to-ftp":
      response.writeHead(301, { location: "ftp://files.example/" });
      response.end();
      return;
    case "/see-other":
      response.writeHead(303, { location: "/ok" });
      response.end();
      return;
    case "/big": {
      // Two megabytes, the word only in the second.
      response.writeHead(200, { "content-type": "text/plain" });
      const chunk = "a".repeat(64 * 1024);
      let sent = 0;
      const write = () => {
        while (sent < 2 * MEGABYTE) {
          sent += chunk.length;
          if (!response.write(chunk)) {
            response.once("drain", write);
            return;
          }
        }
        response.end("needle");
      };
      response.on("error", () => undefined);
      write();
      return;
    }
    case "/hook":
      void servers.onHook.run().then(() => {
        response.writeHead(200);
        response.end("ok");
      });
      return;
    default:
      response.writeHead(404);
      response.end("not found");
  }
}

function listen(server: http.Server | https.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address !== null ? address.port : 0);
    });
  });
}

export async function startUptimeServers(): Promise<UptimeServers> {
  const certificate = makeCertificate({ names: ["localhost", "status.test"] });
  const state = {
    flaky: { status: 200 },
    requests: [] as string[],
    onHook: { run: async () => undefined },
  };
  const plain = http.createServer((request, response) => answer(state, request, response));
  const secure = https.createServer(
    { cert: certificate.cert, key: certificate.privateKey },
    (request, response) => answer(state, request, response),
  );
  const [plainPort, securePort] = await Promise.all([listen(plain), listen(secure)]);
  return {
    ...state,
    http: `http://status.test:${plainPort}`,
    https: `https://status.test:${securePort}`,
    certificate,
    close: async () => {
      plain.closeAllConnections();
      secure.closeAllConnections();
      await Promise.all([
        new Promise((resolve) => plain.close(resolve)),
        new Promise((resolve) => secure.close(resolve)),
      ]);
    },
  };
}

/** Resolve status.test and localhost to 127.0.0.1 by default. Record each lookup. */
export function testLookup(table: Record<string, string[]> = {}): Lookup & { calls: string[] } {
  const calls: string[] = [];
  const answers: Record<string, string[]> = {
    "status.test": ["127.0.0.1"],
    localhost: ["127.0.0.1"],
    ...table,
  };
  const lookup = async (hostname: string) => {
    calls.push(hostname);
    const found = answers[hostname];
    if (found === undefined) {
      throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: "ENOTFOUND" });
    }
    return found.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }) as const);
  };
  return Object.assign(lookup, { calls });
}

export async function closedPort(): Promise<number> {
  const server = http.createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}
