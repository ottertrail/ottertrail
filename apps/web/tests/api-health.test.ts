import { describe, expect, test } from "vite-plus/test";

import { fetchApiHealth } from "../src/lib/api-health.ts";

function respondWith(response: Response): typeof fetch {
  return () => Promise.resolve(response);
}

const failingFetch: typeof fetch = () => Promise.reject(new TypeError("fetch failed"));

/** Never settles unless its request signal aborts. */
const hangingFetch: typeof fetch = (_input, init) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () =>
      reject(new DOMException("Aborted", "AbortError")),
    );
  });

describe("fetchApiHealth", () => {
  test("reports ok for a healthy response", async () => {
    const fetchImpl = respondWith(Response.json({ status: "ok" }));
    await expect(fetchApiHealth(undefined, fetchImpl)).resolves.toEqual({ state: "ok" });
  });

  test("reports the HTTP status for an error response", async () => {
    const fetchImpl = respondWith(new Response("Bad gateway", { status: 502 }));
    await expect(fetchApiHealth(undefined, fetchImpl)).resolves.toEqual({
      state: "unreachable",
      reason: "HTTP 502",
    });
  });

  test("rejects an unexpected body", async () => {
    const fetchImpl = respondWith(Response.json({ status: "maybe" }));
    await expect(fetchApiHealth(undefined, fetchImpl)).resolves.toEqual({
      state: "unreachable",
      reason: "Unexpected response",
    });
  });

  test("reports network failures as unreachable", async () => {
    await expect(fetchApiHealth(undefined, failingFetch)).resolves.toEqual({
      state: "unreachable",
      reason: "fetch failed",
    });
  });

  test("rejects when the caller aborts", async () => {
    const controller = new AbortController();
    const pending = fetchApiHealth(controller.signal, hangingFetch);
    controller.abort();
    await expect(pending).rejects.toThrow("Aborted");
  });
});
