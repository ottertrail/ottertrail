import { Buffer } from "node:buffer";
import { once } from "node:events";
import { connect, type Socket } from "node:net";

import type { FastifyInstance } from "fastify";
import { expect } from "vite-plus/test";

/**
 * Listens on a free local port and returns a client that sends a request's
 * whole body, waits until `held()` says the server is working on it (an
 * insert held by a fake ClickHouse), then disconnects without reading the
 * answer, and resolves once the server has seen the connection close.
 */
export async function hangingUpClient(app: FastifyInstance) {
  // Registered before listening, after Node's own, so its close listener
  // runs once Node has closed the response.
  const serverSockets: Socket[] = [];
  app.server.on("connection", (socket: Socket) => {
    serverSockets.push(socket);
  });
  const port = Number(new URL(await app.listen({ host: "127.0.0.1", port: 0 })).port);

  return async (
    path: string,
    headers: Record<string, string>,
    body: Buffer | string,
    held: () => boolean,
  ) => {
    const before = serverSockets.length;
    const client = connect(port, "127.0.0.1");
    await once(client, "connect");
    await expect.poll(() => serverSockets.length).toBe(before + 1);
    const serverSide = serverSockets[before]!;
    let answer = "";
    client.on("data", (chunk: Buffer) => {
      answer += chunk.toString();
    });
    const payload = typeof body === "string" ? Buffer.from(body) : body;
    const head = [
      `POST ${path} HTTP/1.1`,
      "host: 127.0.0.1",
      `content-length: ${payload.length}`,
      ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
      "",
      "",
    ].join("\r\n");
    client.write(Buffer.concat([Buffer.from(head), payload]));
    await expect.poll(() => held() || answer !== "").toBe(true);
    expect(answer, "the server answered before it held the request").toBe("");
    const closed = once(serverSide, "close");
    client.destroy();
    await closed;
    await new Promise((resolve) => setImmediate(resolve));
  };
}
