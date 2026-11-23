import { once } from "node:events";
import { connect } from "node:net";

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import { buildApp } from "../src/app.ts";
import type { ClickHouseClient } from "../src/clickhouse/clickhouse.ts";
import { createTestDatabase, type TestDatabase } from "./helpers/test-database.ts";

let testDb: TestDatabase | undefined;
let app: FastifyInstance | undefined;
let port = 0;

beforeAll(async () => {
  testDb = await createTestDatabase();
  app = buildApp({
    db: testDb.db,
    // Never reached: the requests here are cut off before their bodies arrive.
    collection: { clickhouse: {} as ClickHouseClient },
    timeouts: { requestMs: 500, headersMs: 300, checkIntervalMs: 50 },
  });
  // A response that takes longer than a request may: as the Server log's stream does.
  app.get("/slow-answer", (_request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, { "content-type": "text/plain" });
    reply.raw.write("first\n");
    setTimeout(() => reply.raw.end("last\n"), 1200);
  });
  port = Number(new URL(await app.listen({ host: "127.0.0.1", port: 0 })).port);
});

afterAll(async () => {
  await app?.close();
  await testDb?.destroy();
});

/** Opens a connection, sends `head`, and gives what the server answers before it closes. */
async function exchange(head: string) {
  const socket = connect(port, "127.0.0.1");
  await once(socket, "connect");
  let answer = "";
  socket.on("data", (chunk: Buffer) => {
    answer += chunk.toString();
  });
  const started = Date.now();
  socket.write(head);
  await once(socket, "close");
  return { answer, after: Date.now() - started };
}

describe("request timeouts", () => {
  test("a body that stops arriving is cut off", async () => {
    const { answer, after } = await exchange(
      [
        "POST /api/events HTTP/1.1",
        "Host: localhost",
        "Content-Type: text/plain",
        "Content-Length: 1000",
        "",
        '{"v":1,',
      ].join("\r\n"),
    );
    expect(answer).toMatch(/^HTTP\/1\.1 408/);
    expect(after).toBeLessThan(3000);
  });

  test("headers that stop arriving are cut off", async () => {
    const { answer } = await exchange("GET /api/health HTTP/1.1\r\nHost: localhost\r\n");
    expect(answer).toMatch(/^HTTP\/1\.1 408/);
  });

  test("a response may take longer than a request may", async () => {
    const { answer, after } = await exchange(
      "GET /slow-answer HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
    );
    expect(answer).toMatch(/^HTTP\/1\.1 200/);
    expect(answer).toContain("last");
    expect(after).toBeGreaterThan(1000);
  });
});
