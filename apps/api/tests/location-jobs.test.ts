import { EventEmitter } from "node:events";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";

import { manualUpdate, stopOnSignals } from "../src/enrichment/manual-update.ts";
import { type Fetch, LocationDataJob, readUpdateStatus } from "../src/enrichment/updates.ts";
import { updateInstanceSettings } from "../src/settings/settings.ts";
import { allSources, fakeFetch, hangingFetch } from "./helpers/location-sources.ts";
import { createTestDatabase, type TestDatabase } from "./helpers/test-database.ts";

let testDb: TestDatabase;
let dir = "";
const logged: { level: string; msg: string }[] = [];

beforeAll(async () => {
  testDb = await createTestDatabase();
});
afterAll(async () => {
  await testDb?.destroy();
});
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ottertrail-location-jobs-"));
  logged.length = 0;
  await testDb.db.deleteFrom("location_data_updates").execute();
  await testDb.db.deleteFrom("location_data_lease").execute();
  await updateInstanceSettings(testDb.db, { updateLocationData: true });
  await useLocationDatabase(true);
});

/** Whether the one project looks locations up in the database: only then is the file downloaded. */
async function useLocationDatabase(used: boolean) {
  await testDb.db.deleteFrom("projects").execute();
  await testDb.db
    .insertInto("projects")
    .values({ name: "Site", allowed_hostnames: [], location_source: used ? "database" : "off" })
    .execute();
}
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const paths = () => ({
  databasePath: join(dir, "dbip-city-lite.mmdb"),
  dataCentersPath: join(dir, "data-centers.json"),
});

const leases = () => testDb.db.selectFrom("location_data_lease").selectAll().execute();

function job(fetchFn: Fetch, db: TestDatabase["db"] = testDb.db) {
  return new LocationDataJob({
    db,
    ...paths(),
    fetch: fetchFn,
    log: (level, msg) => logged.push({ level, msg }),
  });
}

describe("the worker's location data job", () => {
  test("off, a tick does nothing; turned on, the next tick runs a round", async () => {
    await updateInstanceSettings(testDb.db, { updateLocationData: false });
    const fetchFn = fakeFetch(allSources(new Date().toISOString().slice(0, 7)));
    const worker = job(fetchFn);
    await worker.tick();
    expect(fetchFn.urls).toEqual([]);

    // The worker ticks every minute: the round starts within one.
    await updateInstanceSettings(testDb.db, { updateLocationData: true });
    await worker.tick();
    expect(fetchFn.urls.length).toBeGreaterThan(0);
    expect((await readUpdateStatus(testDb.db)).locations).toMatchObject({ failures: 0 });

    // Then not again until the round said so.
    const before = fetchFn.urls.length;
    await worker.tick();
    expect(fetchFn.urls).toHaveLength(before);
    await worker.stop();
  });

  test("with no project using the location database, only the data-center ranges are downloaded", async () => {
    await useLocationDatabase(false);
    const fetchFn = fakeFetch(allSources(new Date().toISOString().slice(0, 7)));
    const worker = job(fetchFn);
    await worker.tick();
    expect(fetchFn.urls.some((url) => url.includes("city-lite"))).toBe(false);
    expect(fetchFn.urls.length).toBeGreaterThan(0);
    const status = await readUpdateStatus(testDb.db);
    expect(status.locations).toBeNull();
    expect(status.data_centers).toMatchObject({ failures: 0 });
    expect(await readdir(dir)).toEqual(["data-centers.json"]);

    // A project uses it: the next tick downloads the location file, without waiting hours.
    await useLocationDatabase(true);
    await worker.tick();
    expect(fetchFn.urls.some((url) => url.includes("city-lite"))).toBe(true);
    expect((await readUpdateStatus(testDb.db)).locations).toMatchObject({ failures: 0 });
    await worker.stop();
  });

  test("shutdown cuts the download off, waits for the round, and gives the lease back", async () => {
    const worker = job(hangingFetch);
    const ticking = worker.tick();
    // The round holds the lease while it waits for the server.
    await expect.poll(async () => (await leases()).length).toBe(1);
    let ended = false;
    void ticking.then(() => {
      ended = true;
    });
    await worker.stop();
    // stop() itself waited for the round: it has ended, and its lease is back.
    expect(ended).toBe(true);
    expect(await leases()).toEqual([]);
    // A stop is not a failure of the source.
    expect(await readUpdateStatus(testDb.db)).toEqual({ locations: null, data_centers: null });
    // Stopped: later ticks do nothing.
    await worker.tick();
    expect(await leases()).toEqual([]);
  });

  test("an outage is logged once, and its end once", async () => {
    // A database of its own, whose settings go missing for a while.
    const other = await createTestDatabase();
    try {
      const worker = job(fakeFetch({}), other.db);
      await sql`alter table instance_settings rename to instance_settings_away`.execute(other.db);
      await worker.tick();
      await worker.tick();
      await worker.tick();
      expect(logged.filter((line) => line.level === "error")).toEqual([
        { level: "error", msg: "checking for location data updates failed" },
      ]);
      await sql`alter table instance_settings_away rename to instance_settings`.execute(other.db);
      await worker.tick();
      await worker.tick();
      expect(logged.filter((line) => line.msg.includes("works again"))).toEqual([
        { level: "info", msg: "checking for location data updates works again" },
      ]);
      await worker.stop();
    } finally {
      await other.destroy();
    }
  });
});

describe("the manual command", () => {
  test("Ctrl-C ends the round: no partial file, the lease given back, exit code 1", async () => {
    const controller = new AbortController();
    const sources = fakeFetch(allSources(new Date().toISOString().slice(0, 7)));
    // Stopped while the location file's body is read.
    const fetchFn: Fetch = async (url, init) => {
      const response = await sources(url, init);
      if (url.includes("city-lite")) controller.abort();
      return response;
    };
    const errors: string[] = [];
    const code = await manualUpdate({
      db: testDb.db,
      ...paths(),
      stop: controller.signal,
      fetch: fetchFn,
      out: { log: () => {}, error: (line) => errors.push(line) },
    });
    expect(code).toBe(1);
    expect(errors).toContain("Stopped. Old files kept; the next update retries.");
    expect(await leases()).toEqual([]);
    expect((await readdir(dir)).filter((name) => name.endsWith(".download"))).toEqual([]);
  });

  test("with no project using the location database, it skips that file and says why", async () => {
    await useLocationDatabase(false);
    const fetchFn = fakeFetch(allSources(new Date().toISOString().slice(0, 7)));
    const lines: string[] = [];
    const code = await manualUpdate({
      db: testDb.db,
      ...paths(),
      stop: new AbortController().signal,
      fetch: fetchFn,
      out: { log: (line) => lines.push(line), error: (line) => lines.push(line) },
    });
    expect(code).toBe(0);
    expect(lines).toContain(
      "Skipped the location database: no project looks up locations in it (project settings, Location data).",
    );
    expect(fetchFn.urls.some((url) => url.includes("city-lite"))).toBe(false);
    expect(await readdir(dir)).toEqual(["data-centers.json"]);
  });

  test("a running update: says when its lease ends at the latest", async () => {
    const until = new Date(Date.now() + 20 * 60_000);
    await testDb.db
      .insertInto("location_data_lease")
      .values({ holder: "the-worker", expires_at: until })
      .execute();
    const errors: string[] = [];
    const code = await manualUpdate({
      db: testDb.db,
      ...paths(),
      stop: new AbortController().signal,
      fetch: fakeFetch({}),
      out: { log: () => {}, error: (line) => errors.push(line) },
    });
    expect(code).toBe(1);
    expect(errors).toEqual([
      `Another update is running. Retry when it finishes or its lease expires at ${until.toISOString()}.`,
    ]);
  });

  test("SIGINT and SIGTERM abort the round, with the exit code the signal asks for", () => {
    for (const [signal, code] of [
      ["SIGINT", 130],
      ["SIGTERM", 143],
    ] as const) {
      const emitter = new EventEmitter();
      const controller = new AbortController();
      const signals = stopOnSignals(controller, emitter);
      expect(signals.exitCode()).toBeNull();
      emitter.emit(signal);
      expect(controller.signal.aborted).toBe(true);
      expect(signals.exitCode()).toBe(code);
      signals.remove();
      expect(emitter.listenerCount("SIGINT") + emitter.listenerCount("SIGTERM")).toBe(0);
    }
  });
});
