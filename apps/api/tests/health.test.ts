import { afterAll, describe, expect, test } from "vite-plus/test";

import { buildApp } from "../src/app.ts";
import { createDatabase } from "../src/db/database.ts";

describe("GET /api/health", () => {
  // The health check never queries the database, and the pool only connects
  // on first use, so this placeholder address is never contacted.
  const db = createDatabase({ connectionString: "postgres://unused@127.0.0.1:1/unused" });
  const app = buildApp({ db });

  afterAll(async () => {
    await app.close();
    await db.destroy();
  });

  test("reports that the API process is up", async () => {
    const response = await app.inject({ method: "GET", url: "/api/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  });

  test("returns 404 for unknown routes", async () => {
    const response = await app.inject({ method: "GET", url: "/api/unknown" });

    expect(response.statusCode).toBe(404);
  });
});
