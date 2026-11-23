import { mkdtemp, rename, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";

import type { DataCenterFile } from "../src/enrichment/data-centers.ts";
import { GeoDatabase } from "../src/enrichment/geo.ts";
import { LiveLocationData } from "../src/enrichment/reload.ts";
import { stampOf, updateLocationData } from "../src/enrichment/updates.ts";
import { PUBLIC_URL, signedInDashboard, signedInUser } from "./helpers/dashboard.ts";
import { allSources, fakeFetch } from "./helpers/location-sources.ts";
import { fakeMmdb } from "./helpers/mmdb.ts";

const request = { ip: "8.8.8.8", headers: {} };

/** Node's gc(), without starting the test process with --expose-gc; runs it until things settle. */
function collectGarbage(): () => Promise<void> {
  setFlagsFromString("--expose-gc");
  const gc = runInNewContext("gc") as () => void;
  return async () => {
    for (let round = 0; round < 5; round += 1) {
      gc();
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
}

function rangesFile(range: string, updatedAt = "2026-11-17T00:00:00.000Z"): DataCenterFile {
  return {
    version: 1,
    updatedAt,
    providers: [
      { id: "test", name: "Test cloud", source: "test", fetchedAt: updatedAt, ranges: [range] },
    ],
  };
}

describe("the API reloads changed files without a restart", () => {
  let dir = "";
  let databasePath = "";
  let dataCentersPath = "";
  const warnings: string[] = [];
  const log = { info: () => {}, warn: (msg: string) => warnings.push(msg) };
  let tick = Date.parse("2026-11-15T00:00:00.000Z");

  /** Replaces a file in one step, as an update does, with a modification time of its own. */
  async function replace(path: string, content: string | Buffer) {
    await writeFile(`${path}.new`, content);
    tick += 60_000;
    await utimes(`${path}.new`, new Date(tick), new Date(tick));
    await rename(`${path}.new`, path);
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ottertrail-reload-"));
    databasePath = join(dir, "dbip-city-lite.mmdb");
    dataCentersPath = join(dir, "data-centers.json");
    warnings.length = 0;
    return () => rm(dir, { recursive: true, force: true });
  });

  function open(geoSource: "database" | "none" = "database") {
    return LiveLocationData.open({ geoSource, databasePath, dataCentersPath });
  }

  test("a new location database replaces the one in use", async () => {
    await replace(databasePath, fakeMmdb({ city: "First" }));
    const { data } = await open();
    expect(data.locate(request)).toEqual({ country: "US", city: "First" });

    await data.reload(log);
    expect(data.locate(request).city).toBe("First");

    await replace(databasePath, fakeMmdb({ city: "Second", builtAt: new Date("2026-12-01") }));
    // Not before the next look.
    expect(data.locate(request).city).toBe("First");
    await data.reload(log);
    expect(data.locate(request).city).toBe("Second");
    expect(data.loaded.locations).toEqual({
      type: "DBIP-City-Lite",
      builtAt: new Date("2026-12-01"),
      fileModifiedAt: new Date(tick),
    });
    expect(warnings).toEqual([]);
  });

  test("a broken or wrong new file keeps the old data, with a warning", async () => {
    await replace(databasePath, fakeMmdb({ city: "First" }));
    await replace(dataCentersPath, JSON.stringify(rangesFile("203.0.113.0/24")));
    const { data } = await open();

    await replace(databasePath, "not a database");
    await data.reload(log);
    expect(data.locate(request).city).toBe("First");
    // Opens, but is not a City database that places 8.8.8.8 in the US.
    await replace(databasePath, fakeMmdb({ country: "DE" }));
    await data.reload(log);
    expect(data.locate(request).city).toBe("First");

    await replace(dataCentersPath, "{ cut off");
    await data.reload(log);
    expect(data.isDataCenter("203.0.113.5")).toBe(true);

    expect(warnings).toHaveLength(3);
    // The Settings page shows why.
    expect(data.loaded.locationsError).toMatch(/^unexpected database DBIP-City-Lite/);
    expect(data.loaded.dataCentersError).toMatch(/JSON/);
    expect(warnings[0]).toMatch(/location database .* changed but could not be used/);
    expect(warnings[2]).toMatch(/data-center ranges .* changed but could not be used/);
    // A failed file is not tried again until it changes again.
    await data.reload(log);
    expect(warnings).toHaveLength(3);
  });

  test("files missing at startup are loaded once they appear", async () => {
    const { data, messages } = await open();
    expect(messages.map((message) => message.ok)).toEqual([false, false]);
    expect(data.locate(request)).toEqual({});
    expect(data.isDataCenter("203.0.113.5")).toBe(false);
    expect(data.loaded).toEqual({
      geoSource: "database",
      locations: null,
      locationsError: null,
      dataCenters: null,
      dataCentersError: null,
    });

    await replace(databasePath, fakeMmdb());
    await replace(dataCentersPath, JSON.stringify(rangesFile("203.0.113.0/24")));
    await data.reload(log);
    expect(data.locate(request).country).toBe("US");
    expect(data.isDataCenter("203.0.113.5")).toBe(true);
    expect(data.loaded.dataCenters).toEqual({
      providers: 1,
      updatedAt: new Date("2026-11-17T00:00:00.000Z"),
      fileModifiedAt: new Date(tick),
    });

    await replace(dataCentersPath, JSON.stringify(rangesFile("198.51.100.0/24")));
    await data.reload(log);
    expect(data.isDataCenter("203.0.113.5")).toBe(false);
    expect(data.isDataCenter("198.51.100.5")).toBe(true);
  });

  test("an IPv6 database, as DB-IP's, places IPv6 addresses after a reload", async () => {
    await replace(databasePath, fakeMmdb({ city: "First" }));
    const { data } = await open();
    await replace(databasePath, fakeMmdb({ city: "Sixth", ipVersion: 6 }));
    await data.reload(log);
    expect(data.locate({ ip: "2001:db8::1", headers: {} })).toEqual({
      country: "US",
      city: "Sixth",
    });
    expect(data.locate(request).city).toBe("Sixth");
  });

  test("a replaced database is released: only the copy in use stays in memory", async () => {
    const gc = collectGarbage();
    const opened: WeakRef<GeoDatabase>[] = [];
    // Wrapped by hand: a vi.spyOn would keep every result, and so every database.
    const original = Object.getOwnPropertyDescriptor(GeoDatabase, "open")!;
    const realOpen = GeoDatabase.open.bind(GeoDatabase);
    GeoDatabase.open = async (path) => {
      const geo = await realOpen(path);
      opened.push(new WeakRef(geo));
      return geo;
    };
    try {
      await replace(databasePath, fakeMmdb({ city: "First" }));
      // Kept whole, as server.ts keeps it: nothing in it may hold a database.
      const startup = await open();
      const { data } = startup;
      await replace(databasePath, fakeMmdb({ city: "Second" }));
      await data.reload(log);
      await replace(databasePath, fakeMmdb({ city: "Third" }));
      await data.reload(log);
      expect(opened).toHaveLength(3);
      await gc();
      // The startup copy and the second are gone; the third is in use.
      expect(opened.map((ref) => ref.deref() !== undefined)).toEqual([false, false, true]);
      expect(data.locate(request).city).toBe("Third");
      expect(startup.messages).toHaveLength(2);
    } finally {
      Object.defineProperty(GeoDatabase, "open", original);
    }
  });

  test("with location lookup off, a location file is never loaded", async () => {
    const { data } = await open("none");
    await replace(databasePath, fakeMmdb());
    await data.reload(log);
    expect(data.locate(request)).toEqual({});
    expect(data.loaded.locations).toBeNull();
  });
});

describe("the location data on the Settings page", () => {
  let dir = "";
  let dashboard: Awaited<ReturnType<typeof signedInDashboard>>;
  let live: LiveLocationData;

  function call(cookie: string | undefined, method: "GET" | "PATCH", url: string, body?: object) {
    return dashboard.app.inject({
      method,
      url,
      headers: {
        ...(cookie === undefined ? {} : { cookie }),
        origin: PUBLIC_URL,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });
  }

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "ottertrail-location-status-"));
    live = (
      await LiveLocationData.open({
        geoSource: "database",
        databasePath: join(dir, "dbip-city-lite.mmdb"),
        dataCentersPath: join(dir, "data-centers.json"),
      })
    ).data;
    dashboard = await signedInDashboard({ locationData: live });
  });
  afterAll(async () => {
    await dashboard?.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("before any update: nothing loaded, nothing recorded", async () => {
    const response = await call(dashboard.cookie, "GET", "/api/settings/location-data");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      now: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      geoSource: "database",
      locations: { loaded: null, loadError: null, lastUpdate: null },
      dataCenters: { loaded: null, loadError: null, lastUpdate: null },
    });
  });

  test("after an update: what the API loaded, and what the update recorded", async () => {
    const now = new Date("2026-11-15T12:00:00.000Z");
    await updateLocationData({
      db: dashboard.db,
      geoSource: "database",
      databasePath: join(dir, "dbip-city-lite.mmdb"),
      dataCentersPath: join(dir, "data-centers.json"),
      fetch: fakeFetch(allSources("2026-11")),
      now: () => now,
      log: () => {},
    });
    await live.reload({ info: () => {}, warn: () => {} });

    const response = await call(dashboard.cookie, "GET", "/api/settings/location-data");
    // What the API loaded is the file the update wrote.
    const locationsFile = new Date((await stampOf(join(dir, "dbip-city-lite.mmdb")))!.modifiedMs);
    const dataCentersFile = new Date((await stampOf(join(dir, "data-centers.json")))!.modifiedMs);
    expect(response.json()).toEqual({
      now: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      geoSource: "database",
      locations: {
        loaded: {
          type: "DBIP-City-Lite",
          builtAt: "2026-11-01T02:52:26.000Z",
          fileModifiedAt: locationsFile.toISOString(),
        },
        loadError: null,
        lastUpdate: {
          lastAttemptAt: now.toISOString(),
          lastSuccessAt: now.toISOString(),
          version: "2026-11",
          builtAt: "2026-11-01T02:52:26.000Z",
          providers: null,
          fileModifiedAt: locationsFile.toISOString(),
          lastError: null,
        },
      },
      dataCenters: {
        loaded: {
          providers: 14,
          updatedAt: now.toISOString(),
          fileModifiedAt: dataCentersFile.toISOString(),
        },
        loadError: null,
        lastUpdate: {
          lastAttemptAt: now.toISOString(),
          lastSuccessAt: now.toISOString(),
          version: null,
          builtAt: now.toISOString(),
          providers: 14,
          fileModifiedAt: dataCentersFile.toISOString(),
          lastError: null,
        },
      },
    });

    // A file the API cannot use: the route says why.
    await writeFile(join(dir, "data-centers.json"), "{ cut off");
    await live.reload({ info: () => {}, warn: () => {} });
    const broken = (await call(dashboard.cookie, "GET", "/api/settings/location-data")).json();
    expect(broken.dataCenters.loadError).toMatch(/JSON/);
    expect(broken.dataCenters.loaded.providers).toBe(14);
  });

  test("only the owner reads the status and changes the setting, as the other instance settings", async () => {
    const admin = await signedInUser(dashboard, {
      name: "Dee",
      email: "dee@example.com",
      role: "admin",
    });
    const member = await signedInUser(dashboard, {
      name: "Carol",
      email: "carol@example.com",
      grants: { projects: "all", areas: { web_analytics: "view" } },
    });
    for (const cookie of [admin.cookie, member.cookie]) {
      const status = await call(cookie, "GET", "/api/settings/location-data");
      expect(status.statusCode).toBe(403);
      expect(status.json()).toMatchObject({ error: "forbidden" });
      const change = await call(cookie, "PATCH", "/api/settings", { updateLocationData: false });
      expect(change.statusCode).toBe(403);
    }
    expect((await call(undefined, "GET", "/api/settings/location-data")).statusCode).toBe(401);
    expect((await call(dashboard.cookie, "GET", "/api/settings")).json().settings).toMatchObject({
      updateLocationData: true,
    });
  });

  test("the owner turns automatic updates off and on; anything but true or false is refused", async () => {
    const off = await call(dashboard.cookie, "PATCH", "/api/settings", {
      updateLocationData: false,
    });
    expect(off.statusCode).toBe(200);
    expect(off.json().settings).toMatchObject({ updateLocationData: false });
    const row = await dashboard.db
      .selectFrom("instance_settings")
      .select("update_location_data")
      .executeTakeFirstOrThrow();
    expect(row.update_location_data).toBe(false);

    // Not even the values Fastify would otherwise coerce to false.
    for (const value of [null, 0, "", "false", "true", 1, [true], "maybe", { on: true }]) {
      const refused = await call(dashboard.cookie, "PATCH", "/api/settings", {
        updateLocationData: value,
      });
      expect(refused.statusCode).toBe(400);
    }
    // The name and timezone stay as they were.
    const on = await call(dashboard.cookie, "PATCH", "/api/settings", { updateLocationData: true });
    expect(on.json().settings).toEqual({
      name: "Ada's company",
      timeZone: "UTC",
      updateLocationData: true,
      avatarUrl: null,
    });
  });
});
