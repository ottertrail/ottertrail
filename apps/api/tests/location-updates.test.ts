import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";

import { loadConfig } from "../src/config.ts";
import { createDatabase } from "../src/db/database.ts";
import { migrations } from "../src/db/migrations/index.ts";
import { gunzippedLines } from "../src/enrichment/data-center-sources.ts";
import { DataCenters } from "../src/enrichment/data-centers.ts";
import { GeoDatabase } from "../src/enrichment/geo.ts";
import {
  dataCentersDue,
  DOWNLOAD_LIMITS,
  LEASE_MS,
  type DownloadLimits,
  type Fetch,
  locationsDue,
  locationsUrl,
  readUpdateStatus,
  monthMarkerPath,
  partialPath,
  readTextCapped,
  retryDelayMs,
  stampOf,
  UPDATE_CHECK_INTERVAL_MS,
  UpdateSchedule,
  type UpdateStatus,
  updateLocationData,
} from "../src/enrichment/updates.ts";
import { updateInstanceSettings } from "../src/settings/settings.ts";
import {
  allSources,
  fakeFetch,
  hangingFetch,
  locationFile,
  type Redirect,
} from "./helpers/location-sources.ts";
import {
  createTestDatabase,
  migrateTestDatabase,
  MIGRATION_TEST_MS,
  type TestDatabase,
} from "./helpers/test-database.ts";

const HOUR = 3_600_000;
const MINUTE = 60_000;
const DAY = 24 * HOUR;
const MID_NOVEMBER = new Date("2026-11-15T12:00:00.000Z");

function recorded(version: string, file: { size: number; modifiedMs: number }): UpdateStatus {
  return {
    lastAttemptAt: MID_NOVEMBER,
    lastSuccessAt: MID_NOVEMBER,
    version,
    builtAt: null,
    providers: null,
    file,
    lastError: null,
    failures: 0,
  };
}

describe("when the location database is due", () => {
  const file = { size: 1000, modifiedMs: Date.parse("2026-11-02T00:00:00.000Z") };

  test("a missing file is due", () => {
    expect(locationsDue(null, null, MID_NOVEMBER)).toEqual({ due: true, have: null, known: false });
  });

  test("last month's file is due; this month's is not", () => {
    expect(locationsDue(file, recorded("2026-10", file), MID_NOVEMBER)).toEqual({
      due: true,
      have: "2026-10",
      known: true,
    });
    expect(locationsDue(file, recorded("2026-11", file), MID_NOVEMBER)).toEqual({
      due: false,
      have: "2026-11",
      known: true,
    });
  });

  test("a file the last update did not write counts by the month it was written in", () => {
    // Replaced since (another size): the recorded month no longer says what it holds.
    const replaced = { ...file, size: 2000 };
    expect(locationsDue(replaced, recorded("2026-10", file), MID_NOVEMBER).due).toBe(false);
    const october = { size: 1000, modifiedMs: Date.parse("2026-10-20T00:00:00.000Z") };
    expect(locationsDue(october, null, MID_NOVEMBER)).toEqual({
      due: true,
      have: "2026-10",
      known: false,
    });
  });
});

/** A data-center file written `daysAgo` before mid-November. */
const written = (daysAgo: number) => ({
  version: 1 as const,
  updatedAt: new Date(MID_NOVEMBER.getTime() - daysAgo * DAY).toISOString(),
  providers: [],
});

describe("when the data-center ranges are due", () => {
  test("missing is due; 6 days old is not; 8 days old is", () => {
    expect(dataCentersDue(undefined, MID_NOVEMBER)).toBe(true);
    expect(dataCentersDue(written(6), MID_NOVEMBER)).toBe(false);
    expect(dataCentersDue(written(8), MID_NOVEMBER)).toBe(true);
  });
});

describe("updateLocationData", () => {
  let testDb: TestDatabase;
  let dir = "";
  let databasePath = "";
  let dataCentersPath = "";
  const logged: { level: string; msg: string }[] = [];

  beforeAll(async () => {
    testDb = await createTestDatabase();
  });
  afterAll(async () => {
    await testDb?.destroy();
  });
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ottertrail-location-data-"));
    databasePath = join(dir, "geo", "dbip-city-lite.mmdb");
    dataCentersPath = join(dir, "geo", "data-centers.json");
    logged.length = 0;
    await testDb.db.deleteFrom("location_data_updates").execute();
    await testDb.db.deleteFrom("location_data_lease").execute();
    await updateInstanceSettings(testDb.db, { updateLocationData: true });
    await useLocationDatabase(true);
  });

  /** Whether the one project looks locations up in the database. */
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

  async function update(
    fetchFn: Fetch,
    now: Date,
    options: {
      /** Whether a project uses the location database; set first. */
      locationsNeeded?: boolean;
      force?: boolean;
      db?: TestDatabase["db"] | null;
      stop?: AbortSignal;
      removePartials?: boolean;
      limits?: Partial<DownloadLimits>;
      holder?: string;
      roundTimeoutMs?: number;
      /** Called with each log message, as it is logged. */
      onLog?: (msg: string) => void;
    } = {},
  ) {
    const db = options.db === undefined ? testDb.db : options.db;
    if (options.locationsNeeded !== undefined) await useLocationDatabase(options.locationsNeeded);
    return updateLocationData({
      db,
      databasePath,
      dataCentersPath,
      fetch: fetchFn,
      now: () => now,
      log: (level, msg) => {
        logged.push({ level, msg });
        options.onLog?.(msg);
      },
      ...(options.force === undefined ? {} : { force: options.force }),
      ...(options.stop === undefined ? {} : { stop: options.stop }),
      ...(options.removePartials === undefined ? {} : { removePartials: options.removePartials }),
      limits: { ...DOWNLOAD_LIMITS, ...options.limits },
      ...(options.holder === undefined ? {} : { holder: options.holder }),
      ...(options.roundTimeoutMs === undefined ? {} : { roundTimeoutMs: options.roundTimeoutMs }),
    });
  }

  test("downloads both missing files, checks them, and records what they hold", async () => {
    const fetchFn = fakeFetch(allSources("2026-11"));
    expect(await update(fetchFn, MID_NOVEMBER)).toEqual({
      ran: true,
      locations: "updated",
      dataCenters: "updated",
      nextCheckInMs: UPDATE_CHECK_INTERVAL_MS,
    });

    const geo = await GeoDatabase.open(databasePath);
    expect(geo.lookup("8.8.8.8").country).toBe("US");
    expect((await DataCenters.open(dataCentersPath)).providers).toHaveLength(14);
    // Nothing half-written is left beside them.
    expect((await readdir(join(dir, "geo"))).toSorted()).toEqual([
      "data-centers.json",
      "dbip-city-lite.mmdb",
      "dbip-city-lite.mmdb.month",
    ]);

    const status = await readUpdateStatus(testDb.db);
    expect(status.locations).toEqual({
      lastAttemptAt: MID_NOVEMBER,
      lastSuccessAt: MID_NOVEMBER,
      version: "2026-11",
      builtAt: new Date("2026-11-01T02:52:26.000Z"),
      providers: null,
      file: await stampOf(databasePath),
      lastError: null,
      failures: 0,
    });
    expect(status.data_centers).toEqual({
      lastAttemptAt: MID_NOVEMBER,
      lastSuccessAt: MID_NOVEMBER,
      version: null,
      builtAt: MID_NOVEMBER,
      providers: 14,
      file: await stampOf(dataCentersPath),
      lastError: null,
      failures: 0,
    });

    // A round later the same day, nothing is due, and nothing is downloaded.
    const again = fakeFetch(allSources("2026-11"));
    expect(await update(again, new Date(MID_NOVEMBER.getTime() + 6 * 3_600_000))).toMatchObject({
      ran: true,
      locations: "not_due",
      dataCenters: "not_due",
    });
    expect(again.urls).toEqual([]);
  });

  test("early on the 1st it takes last month's file, then this month's once it is out", async () => {
    const firstEarly = new Date("2026-11-01T01:00:00.000Z");
    const october = allSources("2026-10");
    delete october[locationsUrl("2026-11")];
    const before = fakeFetch(october);
    expect(await update(before, firstEarly)).toMatchObject({ locations: "updated" });
    expect(before.urls.filter((url) => url.includes("city-lite"))).toEqual([
      locationsUrl("2026-11"),
      locationsUrl("2026-10"),
    ]);
    expect((await readUpdateStatus(testDb.db)).locations?.version).toBe("2026-10");

    // Six hours later: still due, but last month's is not downloaded again.
    const stillOctober = fakeFetch(october);
    expect(
      await update(stillOctober, new Date(firstEarly.getTime() + 6 * 3_600_000)),
    ).toMatchObject({ locations: "latest" });
    expect(stillOctober.urls).toEqual([locationsUrl("2026-11")]);
    expect((await readUpdateStatus(testDb.db)).locations).toMatchObject({
      version: "2026-10",
      lastError: null,
    });

    const published = fakeFetch(allSources("2026-11", locationFile({ city: "November" })));
    expect(await update(published, new Date(firstEarly.getTime() + 12 * 3_600_000))).toMatchObject({
      locations: "updated",
    });
    expect((await GeoDatabase.open(databasePath)).lookup("8.8.8.8").city).toBe("November");
    expect((await readUpdateStatus(testDb.db)).locations?.version).toBe("2026-11");
  });

  test("the data-center ranges are downloaded again after 7 days, not after 6", async () => {
    await update(fakeFetch(allSources("2026-11")), MID_NOVEMBER);

    const sixDays = fakeFetch(allSources("2026-11"));
    expect(await update(sixDays, new Date(MID_NOVEMBER.getTime() + 6 * DAY))).toMatchObject({
      dataCenters: "not_due",
    });
    expect(sixDays.urls).toEqual([]);

    const eightDays = fakeFetch(allSources("2026-11"));
    expect(await update(eightDays, new Date(MID_NOVEMBER.getTime() + 8 * DAY))).toMatchObject({
      locations: "not_due",
      dataCenters: "updated",
    });
    expect(eightDays.urls.some((url) => url.includes("amazonaws"))).toBe(true);
  });

  test("a file that fails its check keeps the old one, and the failure is recorded", async () => {
    await update(fakeFetch(allSources("2026-10")), new Date("2026-10-15T12:00:00.000Z"));
    const old = await readFile(databasePath);
    const oldStatus = (await readUpdateStatus(testDb.db)).locations;

    // November's file opens, but places 8.8.8.8 in Germany: not the database expected.
    const wrong = fakeFetch(allSources("2026-11", locationFile({ country: "DE" })));
    expect(await update(wrong, MID_NOVEMBER)).toMatchObject({ locations: "failed" });
    expect(await readFile(databasePath)).toEqual(old);
    expect(existsSync(`${databasePath}.download`)).toBe(false);
    expect(logged).toContainEqual({
      level: "warn",
      msg: "updating the location database failed; the old file stays",
    });
    const failed = (await readUpdateStatus(testDb.db)).locations;
    expect(failed).toMatchObject({
      lastAttemptAt: MID_NOVEMBER,
      lastSuccessAt: oldStatus?.lastSuccessAt,
      version: "2026-10",
      file: oldStatus?.file,
    });
    expect(failed?.lastError).toMatch(/failed its check: unexpected database .*"country":"DE"/);

    // A download that is not gzip at all fails the same way, at the next check 6 hours later.
    const garbage = fakeFetch(allSources("2026-11", Buffer.from("<html>maintenance</html>")));
    expect(await update(garbage, new Date(MID_NOVEMBER.getTime() + 6 * HOUR))).toMatchObject({
      locations: "failed",
    });
    expect(await readFile(databasePath)).toEqual(old);
    expect((await readUpdateStatus(testDb.db)).locations?.lastError).toMatch(
      /downloading .* failed/,
    );
  });

  test("when data-center sources fail, the others' ranges are saved; when all fail, nothing is", async () => {
    await update(fakeFetch(allSources("2026-11")), MID_NOVEMBER);
    const later = new Date(MID_NOVEMBER.getTime() + 8 * DAY);

    // Every source fails: the old file stays as it was, still due, and the failure is recorded.
    const old = await readFile(dataCentersPath, "utf8");
    expect(await update(fakeFetch({}), later)).toMatchObject({ dataCenters: "failed" });
    expect(await readFile(dataCentersPath, "utf8")).toBe(old);
    expect((await readUpdateStatus(testDb.db)).data_centers).toMatchObject({
      lastAttemptAt: later,
      lastSuccessAt: MID_NOVEMBER,
      lastError: expect.stringMatching(/^no source could be downloaded: aws: 404/),
    });

    // Only AWS fails, at the next check: the file is written, AWS keeps its old ranges, and the problem is noted.
    const nextCheck = new Date(later.getTime() + 6 * HOUR);
    const withoutAws = allSources("2026-11");
    delete withoutAws["https://ip-ranges.amazonaws.com/ip-ranges.json"];
    expect(await update(fakeFetch(withoutAws), nextCheck)).toMatchObject({
      dataCenters: "updated",
    });
    const file = JSON.parse(await readFile(dataCentersPath, "utf8"));
    expect(file.providers).toHaveLength(14);
    expect(file.providers.find((provider: { id: string }) => provider.id === "aws")).toMatchObject({
      fetchedAt: MID_NOVEMBER.toISOString(),
    });
    expect((await readUpdateStatus(testDb.db)).data_centers).toMatchObject({
      lastSuccessAt: nextCheck,
      failures: 0,
      lastError: expect.stringMatching(
        /^Some sources failed and kept their previous ranges: aws: 404 .* \(kept 2026-11-15/,
      ),
    });

    // Without an old file, every source failing writes nothing.
    await rm(dataCentersPath);
    expect(await update(fakeFetch({}), nextCheck)).toMatchObject({ dataCenters: "failed" });
    expect(existsSync(dataCentersPath)).toBe(false);
  });

  test("only one updater runs at a time: a second one does nothing", async () => {
    const { promise: held, resolve: release } = Promise.withResolvers<void>();
    const { promise: downloading, resolve: started } = Promise.withResolvers<void>();
    const sources = allSources("2026-11");
    const slow: Fetch = async (url, init) => {
      started();
      await held;
      return fakeFetch(sources)(url, init);
    };
    const first = update(slow, MID_NOVEMBER);
    await downloading;

    const second = fakeFetch(sources);
    expect(await update(second, MID_NOVEMBER)).toMatchObject({ ran: false, reason: "locked" });
    expect(second.urls).toEqual([]);

    release();
    expect(await first).toMatchObject({ ran: true, locations: "updated" });
    // Released: the next one runs.
    expect(await update(fakeFetch(sources), MID_NOVEMBER, { force: true })).toMatchObject({
      ran: true,
    });
  });

  test("with the setting off, nothing is downloaded; the manual command still downloads", async () => {
    await updateInstanceSettings(testDb.db, { updateLocationData: false });
    const off = fakeFetch(allSources("2026-11"));
    expect(await update(off, MID_NOVEMBER)).toEqual({ ran: false, reason: "off" });
    expect(off.urls).toEqual([]);
    expect(existsSync(databasePath)).toBe(false);
    expect(await readUpdateStatus(testDb.db)).toEqual({ locations: null, data_centers: null });

    const manual = fakeFetch(allSources("2026-11"));
    expect(await update(manual, MID_NOVEMBER, { force: true })).toMatchObject({
      ran: true,
      locations: "updated",
      dataCenters: "updated",
    });
    expect(existsSync(databasePath)).toBe(true);
  });

  test("with no project using the location database, only the data-center ranges are downloaded", async () => {
    const fetchFn = fakeFetch(allSources("2026-11"));
    expect(await update(fetchFn, MID_NOVEMBER, { locationsNeeded: false })).toMatchObject({
      ran: true,
      locations: "not_needed",
      dataCenters: "updated",
    });
    expect(fetchFn.urls.some((url) => url.includes("city-lite"))).toBe(false);
    expect(existsSync(databasePath)).toBe(false);
  });

  test("the manual command without PostgreSQL updates without the lease or a status", async () => {
    // A file in place, written this month so not due: forced, it is downloaded anyway.
    await update(fakeFetch(allSources("2026-11")), MID_NOVEMBER, { db: null });
    const before = await stampOf(databasePath);
    await utimes(databasePath, new Date("2026-11-02"), new Date("2026-11-02"));
    expect(
      await update(fakeFetch(allSources("2026-11")), MID_NOVEMBER, { db: null, force: true }),
    ).toMatchObject({ ran: true, locations: "updated" });
    expect(await stampOf(databasePath)).not.toEqual(before);
    expect(await readUpdateStatus(testDb.db)).toEqual({ locations: null, data_centers: null });
  });

  test("a missing file that fails is tried again after 15 minutes, then 30", async () => {
    const noLocations = { locationsNeeded: false };
    expect(await update(fakeFetch({}), MID_NOVEMBER, noLocations)).toMatchObject({
      dataCenters: "failed",
      nextCheckInMs: 15 * MINUTE,
    });
    const early = fakeFetch({});
    expect(
      await update(early, new Date(MID_NOVEMBER.getTime() + 10 * MINUTE), noLocations),
    ).toMatchObject({ dataCenters: "waiting", nextCheckInMs: 5 * MINUTE });
    expect(early.urls).toEqual([]);
    expect(
      await update(fakeFetch({}), new Date(MID_NOVEMBER.getTime() + 15 * MINUTE), noLocations),
    ).toMatchObject({ dataCenters: "failed", nextCheckInMs: 30 * MINUTE });
    expect((await readUpdateStatus(testDb.db)).data_centers?.failures).toBe(2);
  });

  test("a file in place that keeps failing is tried every 6 hours, then once a day after 3", async () => {
    const noLocations = { locationsNeeded: false };
    await update(fakeFetch(allSources("2026-11")), MID_NOVEMBER, noLocations);
    const start = MID_NOVEMBER.getTime() + 8 * DAY;
    const at = (hours: number) => new Date(start + hours * HOUR);
    expect(await update(fakeFetch({}), at(0), noLocations)).toMatchObject({
      dataCenters: "failed",
      nextCheckInMs: 6 * HOUR,
    });
    expect(await update(fakeFetch({}), at(5), noLocations)).toMatchObject({
      dataCenters: "waiting",
    });
    expect(await update(fakeFetch({}), at(6), noLocations)).toMatchObject({
      dataCenters: "failed",
    });
    // The third: rounds still run every 6 hours, but this file waits a day.
    expect(await update(fakeFetch({}), at(12), noLocations)).toMatchObject({
      dataCenters: "failed",
      nextCheckInMs: 6 * HOUR,
    });
    for (const hours of [18, 24, 30]) {
      const quiet = fakeFetch({});
      expect(await update(quiet, at(hours), noLocations)).toMatchObject({
        dataCenters: "waiting",
      });
      expect(quiet.urls).toEqual([]);
    }
    // The manual command does not wait.
    expect(await update(fakeFetch({}), at(30), { ...noLocations, force: true })).toMatchObject({
      dataCenters: "failed",
    });
    expect(await update(fakeFetch(allSources("2026-11")), at(30 + 24), noLocations)).toMatchObject({
      dataCenters: "updated",
      nextCheckInMs: UPDATE_CHECK_INTERVAL_MS,
    });
    expect((await readUpdateStatus(testDb.db)).data_centers?.failures).toBe(0);
  });

  test("a lease left by a process that died is taken over once it expires", async () => {
    await testDb.db
      .insertInto("location_data_lease")
      .values({ holder: "a dead worker", expires_at: new Date(Date.now() + 60_000) })
      .execute();
    expect(await update(fakeFetch({}), MID_NOVEMBER)).toMatchObject({
      ran: false,
      reason: "locked",
      until: expect.any(Date),
    });
    await testDb.db
      .updateTable("location_data_lease")
      .set({ expires_at: new Date(Date.now() - 1000) })
      .execute();
    expect(await update(fakeFetch(allSources("2026-11")), MID_NOVEMBER)).toMatchObject({
      ran: true,
      locations: "updated",
    });
    // Given back at the end.
    expect(await testDb.db.selectFrom("location_data_lease").selectAll().execute()).toEqual([]);
  });

  test("PostgreSQL ending the updater's connections mid-download breaks nothing", async () => {
    // The updater's own pool, named, so its backends can be found and ended.
    const name = `ottertrail_geo_${Math.random().toString(36).slice(2, 10)}`;
    const url = new URL(loadConfig().databaseUrl);
    url.searchParams.set("application_name", name);
    const idleErrors: string[] = [];
    const db = createDatabase({
      connectionString: url.toString(),
      schema: testDb.schema,
      // As the API and the worker pass their own log.
      onIdleError: (error) => idleErrors.push(error.message),
    });
    try {
      await update(fakeFetch(allSources("2026-10")), new Date("2026-10-15T12:00:00.000Z"), {
        db,
      });
      const sources = fakeFetch(allSources("2026-11", locationFile({ city: "November" })));
      let ended = 0;
      const ending: Fetch = async (fetchUrl, init) => {
        if (fetchUrl === locationsUrl("2026-11")) {
          const { rows } = await sql<{ pid: number }>`
            select pg_terminate_backend(pid) as ended, pid from pg_stat_activity
            where application_name = ${name}
          `.execute(testDb.db);
          ended = rows.length;
          // Long enough for the ended connections to report it.
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        return sources(fetchUrl, init);
      };
      const run = await update(ending, MID_NOVEMBER, { db });
      expect(ended).toBeGreaterThan(0);
      // The ended idle connections were reported to the process's own log.
      expect(idleErrors.length).toBeGreaterThan(0);
      // Nothing held a connection during the download: it finished, and was recorded.
      expect(run).toMatchObject({ ran: true, locations: "updated" });
      expect((await GeoDatabase.open(databasePath)).lookup("8.8.8.8").city).toBe("November");
      expect((await readUpdateStatus(testDb.db)).locations?.version).toBe("2026-11");
      // The next update works, on new connections.
      expect(
        await update(fakeFetch(allSources("2026-11")), MID_NOVEMBER, { db, force: true }),
      ).toMatchObject({ ran: true, locations: "updated" });
    } finally {
      await db.destroy();
    }
  });

  test("an unzipped location file over the limit is refused, and nothing is left", async () => {
    const run = await update(fakeFetch(allSources("2026-11")), MID_NOVEMBER, {
      limits: { locationBytes: 100 },
    });
    expect(run).toMatchObject({ locations: "failed" });
    expect(existsSync(databasePath)).toBe(false);
    expect((await readdir(join(dir, "geo"))).filter((name) => name.endsWith(".download"))).toEqual(
      [],
    );
    expect((await readUpdateStatus(testDb.db)).locations?.lastError).toMatch(
      /the unzipped location database is larger than 100 bytes/,
    );
  });

  test("a provider's list over the limit, or an ASN line too long, counts as that source failing", async () => {
    const run = await update(fakeFetch(allSources("2026-11")), MID_NOVEMBER, {
      locationsNeeded: false,
      limits: { textBytes: 100 },
    });
    expect(run).toMatchObject({ dataCenters: "updated" });
    expect((await readUpdateStatus(testDb.db)).data_centers?.lastError).toMatch(
      /aws: .* is larger than 100 bytes/,
    );

    await rm(dataCentersPath);
    // Both months' ASN files, so both fail the same way.
    const bothMonths = { ...allSources("2026-10"), ...allSources("2026-11") };
    const lines = await update(fakeFetch(bothMonths), MID_NOVEMBER, {
      locationsNeeded: false,
      limits: { lineLength: 10 },
      force: true,
    });
    expect(lines).toMatchObject({ dataCenters: "updated" });
    expect((await readUpdateStatus(testDb.db)).data_centers?.lastError).toMatch(
      /hetzner: a line longer than 10 characters/,
    );
  });

  test("a body is read up to its limit", async () => {
    await expect(readTextCapped(new Response("x".repeat(101)), 100)).rejects.toThrow(
      "larger than 100 bytes",
    );
    expect(await readTextCapped(new Response("x".repeat(100)), 100)).toHaveLength(100);
  });

  test("redirects are followed to https only", async () => {
    const mirror = "https://mirror.example/city.mmdb.gz";
    const sources = allSources("2026-11");
    const followed = fakeFetch({
      ...sources,
      [locationsUrl("2026-11")]: { redirect: mirror },
      [mirror]: sources[locationsUrl("2026-11")]!,
    });
    expect(await update(followed, MID_NOVEMBER)).toMatchObject({ locations: "updated" });
    expect(followed.urls).toContain(mirror);

    const plain = fakeFetch({
      ...sources,
      [locationsUrl("2026-11")]: { redirect: "http://mirror.example/city.mmdb.gz" },
    });
    expect(await update(plain, MID_NOVEMBER, { force: true })).toMatchObject({
      locations: "failed",
    });
    expect(plain.urls).not.toContain("http://mirror.example/city.mmdb.gz");
    expect((await readUpdateStatus(testDb.db)).locations?.lastError).toBe(
      "refused http://mirror.example/city.mmdb.gz: only https is followed",
    );
  });

  test("the month beside the file keeps the 1st-of-month rule when no status was recorded", async () => {
    const firstEarly = new Date("2026-11-01T01:00:00.000Z");
    const october = allSources("2026-10");
    delete october[locationsUrl("2026-11")];
    // Without PostgreSQL, nothing is recorded there.
    await update(fakeFetch(october), firstEarly, { db: null });
    expect(JSON.parse(await readFile(monthMarkerPath(databasePath), "utf8"))).toMatchObject({
      month: "2026-10",
      ...(await stampOf(databasePath)),
    });
    // The file was written today, by the real clock: by its time alone it
    // would pass for this month's, and November's would be skipped.
    const later = fakeFetch(october);
    expect(
      await update(later, new Date(firstEarly.getTime() + 6 * HOUR), { db: null }),
    ).toMatchObject({ locations: "latest" });
    expect(later.urls.filter((url) => url.includes("city-lite"))).toEqual([
      locationsUrl("2026-11"),
    ]);
  });

  test("a stop after the new file is in place still records it; a stop before keeps the old file", async () => {
    // Stopped right after the file is moved into place, before it is recorded.
    const afterRename = new AbortController();
    expect(
      await update(fakeFetch(allSources("2026-11")), MID_NOVEMBER, {
        stop: afterRename.signal,
        onLog: (msg) => {
          if (msg === "location database updated") afterRename.abort();
        },
      }),
    ).toMatchObject({ locations: "updated", dataCenters: "not_due" });
    const status = await readUpdateStatus(testDb.db);
    expect(status.locations).toMatchObject({ version: "2026-11", failures: 0 });
    expect(status.data_centers).toBeNull();
    expect(existsSync(dataCentersPath)).toBe(false);

    const old = await readFile(databasePath);
    const beforeDownload = new AbortController();
    beforeDownload.abort();
    expect(
      await update(fakeFetch(allSources("2026-11")), MID_NOVEMBER, {
        stop: beforeDownload.signal,
        force: true,
      }),
    ).toMatchObject({ locations: "failed" });
    expect(await readFile(databasePath)).toEqual(old);
    // The stop's failure says nothing about the source: not recorded.
    expect((await readUpdateStatus(testDb.db)).locations).toMatchObject({
      lastError: null,
      failures: 0,
    });
  });

  test("a stop while the body is read keeps the old file, and leaves no partial file", async () => {
    await update(fakeFetch(allSources("2026-10")), new Date("2026-10-15T12:00:00.000Z"));
    const old = await readFile(databasePath);
    const sources = fakeFetch(allSources("2026-11"));
    const duringBody = new AbortController();
    const stopsDuringBody: Fetch = async (url, init) => {
      const response = await sources(url, init);
      if (url === locationsUrl("2026-11")) duringBody.abort();
      return response;
    };
    expect(await update(stopsDuringBody, MID_NOVEMBER, { stop: duringBody.signal })).toMatchObject({
      locations: "failed",
      dataCenters: "not_due",
    });
    expect(await readFile(databasePath)).toEqual(old);
    expect((await readdir(join(dir, "geo"))).filter((name) => name.endsWith(".download"))).toEqual(
      [],
    );
    expect((await readUpdateStatus(testDb.db)).locations).toMatchObject({ version: "2026-10" });
  });

  test("a round gives up before its lease could run out, and the failure is recorded", async () => {
    // A server that never answers: only the round's own deadline ends it.
    expect(await update(hangingFetch, MID_NOVEMBER, { roundTimeoutMs: 50 })).toMatchObject({
      ran: true,
      locations: "failed",
    });
    expect((await readUpdateStatus(testDb.db)).locations).toMatchObject({ failures: 1 });
    expect(await testDb.db.selectFrom("location_data_lease").selectAll().execute()).toEqual([]);
  });

  test("a holder takes its own lease back, as a worker whose release failed", async () => {
    await testDb.db
      .insertInto("location_data_lease")
      .values({ holder: "this-worker", expires_at: new Date(Date.now() + 30 * 60_000) })
      .execute();
    expect(await update(fakeFetch({}), MID_NOVEMBER, { holder: "another-worker" })).toMatchObject({
      ran: false,
      reason: "locked",
    });
    expect(
      await update(fakeFetch(allSources("2026-11")), MID_NOVEMBER, { holder: "this-worker" }),
    ).toMatchObject({ ran: true, locations: "updated" });
  });

  test("a damaged file in place, written by no update, is due at once", async () => {
    await mkdir(join(dir, "geo"), { recursive: true });
    for (const content of ["", "<html>not a database</html>"]) {
      // Written this month, so by its time alone it would pass for this month's file.
      await writeFile(databasePath, content);
      await testDb.db.deleteFrom("location_data_updates").execute();
      const fetchFn = fakeFetch(allSources("2026-11"));
      expect(await update(fetchFn, new Date())).toMatchObject({ locations: "updated" });
      expect((await GeoDatabase.open(databasePath)).lookup("8.8.8.8").country).toBe("US");
      await rm(monthMarkerPath(databasePath), { force: true });
    }
    // A good file in place that no update wrote is not downloaded again.
    await testDb.db.deleteFrom("location_data_updates").execute();
    const quiet = fakeFetch(allSources("2026-11"));
    expect(await update(quiet, new Date())).toMatchObject({ locations: "not_due" });
    expect(quiet.urls.filter((url) => url.includes("city-lite"))).toEqual([]);
  });

  test("a month marker that cannot be written still counts the update as a success", async () => {
    // A folder where the marker goes: the rename onto it fails.
    await mkdir(join(monthMarkerPath(databasePath), "in-the-way"), { recursive: true });
    expect(await update(fakeFetch(allSources("2026-11")), MID_NOVEMBER)).toMatchObject({
      locations: "updated",
    });
    expect(logged).toContainEqual({
      level: "warn",
      msg: "the location database's month could not be written beside it",
    });
    expect((await readUpdateStatus(testDb.db)).locations).toMatchObject({
      version: "2026-11",
      lastError: null,
      failures: 0,
    });
  });

  test("redirects: at most 5, and relative ones resolved against the address that sent them", async () => {
    const sources = allSources("2026-11");
    const file = sources[locationsUrl("2026-11")]!;
    const chain = (hops: number) => {
      const files: Record<string, string | Buffer | Redirect> = { ...sources };
      let from = locationsUrl("2026-11");
      for (let hop = 1; hop <= hops; hop += 1) {
        const to = `/hop-${hop}`;
        files[from] = { redirect: to };
        from = new URL(to, from).toString();
      }
      files[from] = file;
      return fakeFetch(files);
    };
    const five = chain(5);
    expect(await update(five, MID_NOVEMBER)).toMatchObject({ locations: "updated" });
    expect(five.urls).toContain("https://download.db-ip.com/hop-5");
    expect(await update(chain(6), MID_NOVEMBER, { force: true })).toMatchObject({
      locations: "failed",
    });
    expect((await readUpdateStatus(testDb.db)).locations?.lastError).toBe(
      `more than 5 redirects from ${locationsUrl("2026-11")}`,
    );
  });

  test("partial files are named per updater; only those older than a lease are deleted", async () => {
    await mkdir(join(dir, "geo"), { recursive: true });
    const stale = [
      partialPath(databasePath, "dead-worker"),
      partialPath(monthMarkerPath(databasePath), "dead-worker"),
      partialPath(dataCentersPath, "dead-worker"),
      // The name before partials were named per updater.
      `${databasePath}.download`,
    ];
    // Another updater's download in progress, such as the manual command without PostgreSQL.
    const live = partialPath(databasePath, "manual-command");
    for (const path of [...stale, live]) await writeFile(path, "in progress");
    const longAgo = new Date(Date.now() - LEASE_MS - 60_000);
    for (const path of stale) await utimes(path, longAgo, longAgo);

    await update(fakeFetch({}), MID_NOVEMBER, { locationsNeeded: false });
    expect([...stale, live].map((path) => existsSync(path))).toEqual([
      true,
      true,
      true,
      true,
      true,
    ]);

    // This updater's own download writes its own partial file; the other's is untouched.
    await update(fakeFetch(allSources("2026-11")), MID_NOVEMBER, {
      locationsNeeded: true,
      removePartials: true,
      holder: "this-worker",
    });
    expect(stale.map((path) => existsSync(path))).toEqual([false, false, false, false]);
    expect(await readFile(live, "utf8")).toBe("in progress");
    expect(existsSync(databasePath)).toBe(true);
  });
});

test(
  "the migration rolls back: no status table, no lease, no setting",
  { timeout: MIGRATION_TEST_MS },
  async () => {
    // The migration before this one, whichever it is once other branches add theirs.
    const names = Object.keys(migrations).toSorted();
    const previous = names[names.indexOf("0009_location_data_updates") - 1];
    expect(previous).toBeDefined();
    const testDb = await createTestDatabase();
    try {
      const columns = () =>
        sql<{ name: string }>`
        select table_name || '.' || column_name as name from information_schema.columns
        where table_schema = ${testDb.schema}
          and (table_name in ('location_data_updates', 'location_data_lease')
            or column_name = 'update_location_data')
      `
          .execute(testDb.db)
          .then(({ rows }) => rows.length);
      expect(await columns()).toBe(14);
      await migrateTestDatabase(testDb, previous!);
      expect(await columns()).toBe(0);
      await migrateTestDatabase(testDb, "latest");
      expect(await columns()).toBe(14);
    } finally {
      await testDb.destroy();
    }
  },
);

/** A round that updated both files, and says when to look again. */
const done = (nextCheckInMs: number) =>
  ({ ran: true, locations: "updated", dataCenters: "updated", nextCheckInMs }) as const;

describe("when the worker tries again", () => {
  test("a missing file soon, doubling to 6 hours; a file in place every 6 hours, then daily", () => {
    expect([1, 2, 3, 4, 5, 6, 10].map((failures) => retryDelayMs(failures, true))).toEqual([
      15 * MINUTE,
      30 * MINUTE,
      HOUR,
      2 * HOUR,
      4 * HOUR,
      6 * HOUR,
      6 * HOUR,
    ]);
    expect([1, 2, 3, 9].map((failures) => retryDelayMs(failures, false))).toEqual([
      6 * HOUR,
      6 * HOUR,
      24 * HOUR,
      24 * HOUR,
    ]);
  });

  test("a round at start, when the last one said, and as soon as the setting is turned on", () => {
    const schedule = new UpdateSchedule();
    const start = 1_000_000;
    expect(schedule.due(start, true)).toBe(true);
    schedule.ran(start, done(6 * HOUR));
    expect(schedule.due(start + MINUTE, true)).toBe(false);
    expect(schedule.due(start + 6 * HOUR, true)).toBe(true);
    schedule.ran(start + 6 * HOUR, done(15 * MINUTE));
    expect(schedule.due(start + 6 * HOUR + 14 * MINUTE, true)).toBe(false);
    expect(schedule.due(start + 6 * HOUR + 15 * MINUTE, true)).toBe(true);
    schedule.ran(start + 7 * HOUR, done(6 * HOUR));

    // Off: never. Turned on again: at once, not hours later.
    expect(schedule.due(start + 7 * HOUR + MINUTE, false)).toBe(false);
    expect(schedule.due(start + 7 * HOUR + 2 * MINUTE, true)).toBe(true);

    // Another process held the lease: tried again in 15 minutes.
    schedule.ran(start + 8 * HOUR, { ran: false, reason: "locked", until: null });
    expect(schedule.due(start + 8 * HOUR + 14 * MINUTE, true)).toBe(false);
    expect(schedule.due(start + 8 * HOUR + 15 * MINUTE, true)).toBe(true);
  });
});

test("a gzipped stream without line breaks is refused past the line limit", async () => {
  const stream = new Response(gzipSync("a".repeat(100))).body!;
  const lines: string[] = [];
  await expect(async () => {
    for await (const line of gunzippedLines(stream, 10)) lines.push(line);
  }).rejects.toThrow("a line longer than 10 characters");
  expect(lines).toEqual([]);
});
