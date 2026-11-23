import { createServer, type Server, type ServerResponse } from "node:http";

/**
 * Match Garage v2.5.0 admin responses for storage/garage-admin.ts.
 * Require a bearer token and record each request.
 */
export interface FakeGarage {
  url: string;
  token: string;
  bucket: {
    id: string;
    alias: string;
    objects: number;
    bytes: number;
    maxSize: number | null;
  } | null;
  dataPartition: { available: number; total: number } | null;
  requests: { method: string; path: string; authorization: string | undefined; body: unknown }[];
  /** While set, every request answers this HTTP status. */
  failWith: number | null;
  close(): Promise<void>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function sendJson(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

export async function startFakeGarage(token: string): Promise<FakeGarage> {
  const fake: Omit<FakeGarage, "url" | "close"> = {
    token,
    bucket: {
      id: "0fe090406fe8bad2bd774e9dc1cc2a84d98aae10bd1e84456aa66a80c7e2ea31",
      alias: "ottertrail",
      objects: 42,
      bytes: 123_456_789,
      maxSize: null,
    },
    dataPartition: { available: 70_000_000_000, total: 100_000_000_000 },
    requests: [],
    failWith: null,
  };
  const server: Server = createServer((request, response) => {
    let text = "";
    request.on("data", (chunk: Buffer) => (text += chunk.toString("utf8")));
    request.on("end", () => {
      const url = new URL(request.url ?? "/", "http://garage");
      const body: unknown = text === "" ? null : JSON.parse(text);
      fake.requests.push({
        method: request.method ?? "",
        path: `${url.pathname}${url.search}`,
        authorization: request.headers.authorization,
        body,
      });
      if (fake.failWith !== null)
        return sendJson(response, fake.failWith, { code: "InternalError" });
      if (request.headers.authorization !== `Bearer ${fake.token}`) {
        return sendJson(response, 403, {
          code: "AccessDenied",
          message: "Forbidden: Invalid bearer token",
        });
      }
      const bucket = fake.bucket;
      if (request.method === "GET" && url.pathname === "/v2/GetBucketInfo") {
        if (bucket === null || url.searchParams.get("globalAlias") !== bucket.alias) {
          return sendJson(response, 404, { code: "NoSuchBucket" });
        }
        return sendJson(response, 200, {
          id: bucket.id,
          globalAliases: [bucket.alias],
          objects: bucket.objects,
          bytes: bucket.bytes,
          unfinishedUploads: 0,
          quotas: { maxSize: bucket.maxSize, maxObjects: null },
        });
      }
      if (request.method === "GET" && url.pathname === "/v2/GetClusterStatus") {
        return sendJson(response, 200, {
          layoutVersion: 1,
          nodes: [
            {
              id: "f4802a77",
              isUp: true,
              ...(fake.dataPartition === null ? {} : { dataPartition: fake.dataPartition }),
            },
          ],
        });
      }
      if (request.method === "POST" && url.pathname === "/v2/UpdateBucket") {
        if (bucket === null || url.searchParams.get("id") !== bucket.id) {
          return sendJson(response, 404, { code: "NoSuchBucket" });
        }
        const quotas = isRecord(body) && isRecord(body.quotas) ? body.quotas : undefined;
        if (quotas !== undefined) {
          bucket.maxSize = typeof quotas.maxSize === "number" ? quotas.maxSize : null;
        }
        return sendJson(response, 200, {
          id: bucket.id,
          quotas: { maxSize: bucket.maxSize, maxObjects: null },
        });
      }
      return sendJson(response, 400, { code: "InvalidRequest" });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No port to listen on");
  const { port } = address;
  return Object.assign(fake, {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  });
}
