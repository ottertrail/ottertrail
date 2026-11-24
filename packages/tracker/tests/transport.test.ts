import { afterEach, describe, expect, test, vi } from "vite-plus/test";

import { browserTransport } from "../src/transport.ts";

const ENDPOINT = "https://ottertrail.example.com/api/events";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A browser's fetch and sendBeacon, recorded. */
function browser(fetch: (url: string, init: RequestInit) => Promise<unknown>) {
  const fetches: { url: string; init: RequestInit }[] = [];
  const beacons: { url: string; type: string }[] = [];
  vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
    fetches.push({ url, init });
    return fetch(url, init);
  });
  vi.stubGlobal("navigator", {
    sendBeacon: (url: string, blob: Blob) => {
      beacons.push({ url, type: blob.type });
      return true;
    },
  });
  return { fetches, beacons };
}

describe("sending as the page is left", () => {
  test("goes by keepalive fetch, as text/plain without credentials, never by beacon", () => {
    const { fetches, beacons } = browser(() => Promise.resolve({ status: 202 }));
    expect(browserTransport(ENDPOINT).beacon('{"events":[]}')).toBe(true);
    expect(fetches).toEqual([
      {
        url: ENDPOINT,
        init: {
          method: "POST",
          body: '{"events":[]}',
          headers: { "content-type": "text/plain" },
          keepalive: true,
          credentials: "omit",
        },
      },
    ]);
    expect(beacons).toEqual([]);
  });

  test("uses a beacon when fetch throws at once", () => {
    const { beacons } = browser(() => {
      throw new TypeError("keepalive request too large");
    });
    expect(browserTransport(ENDPOINT).beacon("{}")).toBe(true);
    expect(beacons).toEqual([{ url: ENDPOINT, type: "text/plain" }]);
  });

  test("uses a beacon when the browser refuses the fetch, while the page lasts", async () => {
    const { beacons } = browser(() => Promise.reject(new TypeError("Failed to fetch")));
    expect(browserTransport(ENDPOINT).beacon("{}")).toBe(true);
    expect(beacons).toEqual([]);
    await Promise.resolve();
    await Promise.resolve();
    expect(beacons).toEqual([{ url: ENDPOINT, type: "text/plain" }]);
  });

  test("uses a beacon where fetch has no keepalive (Firefox before 133)", () => {
    const { fetches, beacons } = browser(() => Promise.resolve({ status: 202 }));
    vi.stubGlobal("Request", function Request() {});
    expect(browserTransport(ENDPOINT).beacon("{}")).toBe(true);
    expect(fetches).toEqual([]);
    expect(beacons).toHaveLength(1);
  });
});
