import { afterAll, describe, expect, test } from "vite-plus/test";

import { buildApp } from "../src/app.ts";

describe("GET /api/health", () => {
  const app = buildApp();

  afterAll(async () => {
    await app.close();
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
