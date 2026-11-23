import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { run } from "../src/main.ts";

/** Assemble a fake key from parts to avoid secret-scanner alerts. */
export const SECRET_KEY = `sk_${"0123456789abcdef".repeat(2)}`;

export interface ReceivedRequest {
  method: string;
  url: URL;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

export type Handler = (request: ReceivedRequest, response: ServerResponse) => void;

export async function startServer(handler: Handler) {
  const requests: ReceivedRequest[] = [];
  const server = createServer((incoming, response) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
      const request = {
        method: incoming.method ?? "",
        url: new URL(incoming.url ?? "/", "http://localhost"),
        headers: incoming.headers,
        body: Buffer.concat(chunks),
      };
      requests.push(request);
      handler(request, response);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no TCP address");
  const { port } = address;
  return {
    host: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export function reply(response: ServerResponse, status: number, body?: unknown, headers = {}) {
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(body === undefined ? "" : JSON.stringify(body));
}

export const sourceMap = (name: string) =>
  JSON.stringify({ version: 3, sources: [`src/${name}.ts`], names: [], mappings: "AAAA" });

/** A temporary build directory holding `files` (path → content). */
export async function buildDirectory(files: Record<string, string>) {
  const directory = await mkdtemp(join(tmpdir(), "ottertrail-sourcemaps-"));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(directory, path)), { recursive: true });
    await writeFile(join(directory, path), content);
  }
  return { directory, remove: () => rm(directory, { recursive: true, force: true }) };
}

export async function runCommand(
  argv: string[],
  {
    env = { OTTERTRAIL_SECRET_KEY: SECRET_KEY },
    sleep = async () => {},
  }: {
    env?: Record<string, string | undefined>;
    sleep?: (milliseconds: number) => Promise<void>;
  } = {},
) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await run(argv, {
    env,
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
    sleep,
  });
  return { code, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
}
