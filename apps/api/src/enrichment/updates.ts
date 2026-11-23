import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, open, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";

import { type Kysely, sql } from "kysely";

import type { GeoSource } from "../config.ts";
import type { Database } from "../db/schema.ts";
import { readInstanceSettings } from "../settings/settings.ts";
import { downloadDataCenters, yearMonth } from "./data-center-sources.ts";
import { type DataCenterFile, DataCenters, isDataCenterFile } from "./data-centers.ts";
import { GeoDatabase } from "./geo.ts";

/**
 * Keeps the two files the API reads about IP addresses current
 * (docs/web-analytics.md, "Keeping the files current"):
 *
 * - the location database, DB-IP's City Lite, published monthly, when
 *   GEO_SOURCE is "database";
 * - the data-center ranges (data-center-sources.ts), whatever the source:
 *   collection checks them for every project that ignores data centers.
 *
 * The worker calls updateLocationData() when UpdateSchedule says so; it
 * downloads only what is due, and only while the instance's "Update
 * location data automatically" setting is on. `vp run geo:update`
 * (scripts/update-geo.ts) calls it with `force`, whatever the setting.
 * Each file is downloaded beside the old one, checked, and moved over it
 * in one step: a failure keeps the old file. The API notices the new file
 * within minutes and loads it (reload.ts).
 */

/** How often the worker looks whether an update is due, when nothing failed. */
export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** How often the worker reads the setting, so turning it on starts an update within this. */
export const SETTING_POLL_MS = 60 * 1000;

/** A missing file is tried again after this, doubling with each failure up to UPDATE_CHECK_INTERVAL_MS. */
export const MISSING_RETRY_MS = 15 * 60 * 1000;

/** After this many failures in a row, a file that exists is tried once a day. */
export const FAILURES_BEFORE_DAILY = 3;
export const DAILY_RETRY_MS = 24 * 60 * 60 * 1000;

/** Providers add ranges every week: the ranges are downloaded again after this. */
export const DATA_CENTERS_MAX_AGE_DAYS = 7;

/** An update that takes longer than this is presumed dead, and another may start. */
export const LEASE_MS = 60 * 60 * 1000;

/** A round stops this long before its lease would expire, so two never overlap. */
export const LEASE_MARGIN_MS = 5 * 60 * 1000;

/** A slow server gets this long for the 130 MB location file, then the attempt fails. */
const LOCATIONS_TIMEOUT_MS = 15 * 60 * 1000;
/** Each data-center source, and DB-IP's ASN file. */
const DATA_CENTERS_TIMEOUT_MS = 2 * 60 * 1000;

/** What a download may be at most; a server that sends more is refused. Tests make them small. */
export interface DownloadLimits {
  /** The location file, unzipped: about 130 MB in November 2026. */
  locationBytes: number;
  /** Each provider's list, as text: a few MB at most. */
  textBytes: number;
  /** One line of DB-IP's ASN file: under 200 characters. */
  lineLength: number;
}

export const DOWNLOAD_LIMITS: DownloadLimits = {
  locationBytes: 1_000_000_000,
  textBytes: 50_000_000,
  lineLength: 64 * 1024,
};

const MAX_REDIRECTS = 5;

/** DB-IP's City Lite file of one month ("2026-11"), gzipped MMDB. */
export const locationsUrl = (month: string) =>
  `https://download.db-ip.com/free/dbip-city-lite-${month}.mmdb.gz`;

export type Fetch = (
  url: string,
  init?: { signal?: AbortSignal; redirect?: "manual" },
) => Promise<Response>;

export type UpdateKind = "locations" | "data_centers";

/** One line per message; the worker's log() and the script's console fit. */
export type UpdateLog = (
  level: "info" | "warn" | "error",
  msg: string,
  fields?: Record<string, unknown>,
) => void;

export interface FileStamp {
  size: number;
  /** Modification time, whole milliseconds. */
  modifiedMs: number;
}

/** The file's size and modification time, or null when it is missing. */
export async function stampOf(path: string): Promise<FileStamp | null> {
  try {
    const found = await stat(path);
    return { size: found.size, modifiedMs: Math.floor(found.mtimeMs) };
  } catch {
    return null;
  }
}

export const sameStamp = (a: FileStamp | null, b: FileStamp | null) =>
  a === null || b === null ? a === b : a.size === b.size && a.modifiedMs === b.modifiedMs;

/** Each holder writes a separate partial file to avoid collisions. */
export const partialPath = (path: string, holder: string) => `${path}.${holder}.download`;

export const newHolder = () => randomUUID();

/**
 * Which month a location file holds, written beside it after each update
 * (`dbip-city-lite.mmdb.month`), with the file's stamp: it says the month
 * even when PostgreSQL could not record it.
 */
export const monthMarkerPath = (path: string) => `${path}.month`;

interface MonthMarker extends FileStamp {
  month: string;
}

async function readMonthMarker(path: string): Promise<MonthMarker | null> {
  try {
    const value: unknown = JSON.parse(await readFile(monthMarkerPath(path), "utf8"));
    if (
      typeof value === "object" &&
      value !== null &&
      "month" in value &&
      typeof value.month === "string" &&
      /^\d{4}-\d{2}$/.test(value.month) &&
      "size" in value &&
      typeof value.size === "number" &&
      "modifiedMs" in value &&
      typeof value.modifiedMs === "number"
    ) {
      return { month: value.month, size: value.size, modifiedMs: value.modifiedMs };
    }
  } catch {
    // Fall back to recorded status or file time if the marker is unreadable.
  }
  return null;
}

/** Writes a file and flushes it to disk, so a crash cannot leave it half written once renamed. */
async function writeDurably(path: string, content: string): Promise<void> {
  const handle = await open(path, "w");
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function sync(path: string): Promise<void> {
  const handle = await open(path, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeMonthMarker(path: string, marker: MonthMarker, holder: string): Promise<void> {
  const target = monthMarkerPath(path);
  await writeDurably(partialPath(target, holder), JSON.stringify(marker));
  await rename(partialPath(target, holder), target);
}

/**
 * Remove <file>.<holder>.download and legacy <file>.download partials only after
 * a lease duration without writes, to protect active downloads.
 */
export async function removeStalePartials(
  paths: string[],
  now: number = Date.now(),
): Promise<void> {
  const prefixes = paths.flatMap((path) => [path, monthMarkerPath(path)]);
  for (const directory of new Set(paths.map((path) => dirname(path)))) {
    let names: string[];
    try {
      names = await readdir(directory);
    } catch {
      continue;
    }
    for (const name of names) {
      const path = join(directory, name);
      const ours = prefixes.some(
        (prefix) =>
          dirname(prefix) === directory &&
          name.startsWith(`${basename(prefix)}.`) &&
          name.endsWith(".download"),
      );
      if (!ours) continue;
      const stamp = await stampOf(path);
      if (stamp !== null && now - stamp.modifiedMs > LEASE_MS) await rm(path, { force: true });
    }
  }
}

export interface LocationFileInfo {
  type: string;
  builtAt: Date;
}

/**
 * Throws unless the database is a City database that places 8.8.8.8 in
 * the US: a file that opens but holds something else must not replace a
 * working one.
 */
export function checkLocationDatabase(geo: GeoDatabase): LocationFileInfo {
  const check = geo.lookup("8.8.8.8");
  if (!geo.type.includes("City") || check.country !== "US") {
    throw new Error(`unexpected database ${geo.type}: 8.8.8.8 gave ${JSON.stringify(check)}`);
  }
  return { type: geo.type, builtAt: geo.builtAt };
}

/**
 * Reads the full DB-IP City Lite file (about 130 MB). The copy can be freed after
 * validation returns.
 */
export async function checkLocationFile(path: string): Promise<LocationFileInfo> {
  return checkLocationDatabase(await GeoDatabase.open(path));
}

/** Throws unless the file is a data-center file with at least one provider. */
export async function checkDataCenterFile(path: string): Promise<DataCenters> {
  const loaded = await DataCenters.open(path);
  if (loaded.providers.length === 0) throw new Error("the file holds no provider's ranges");
  return loaded;
}

/** The data-center file at `path`, or undefined when it is missing or not one. */
export async function readDataCenterFile(path: string): Promise<DataCenterFile | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return isDataCenterFile(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** The status of one file, as the last update recorded it (location_data_updates). */
export interface UpdateStatus {
  lastAttemptAt: Date;
  lastSuccessAt: Date | null;
  version: string | null;
  builtAt: Date | null;
  providers: number | null;
  file: FileStamp | null;
  lastError: string | null;
  /** Failed attempts in a row; 0 after a success. */
  failures: number;
}

/** Each file's recorded status; null for a file no update has tried yet. */
export async function readUpdateStatus(
  db: Kysely<Database>,
): Promise<Record<UpdateKind, UpdateStatus | null>> {
  const rows = await db.selectFrom("location_data_updates").selectAll().execute();
  const byKind = (kind: UpdateKind): UpdateStatus | null => {
    const row = rows.find((candidate) => candidate.kind === kind);
    if (row === undefined) return null;
    return {
      lastAttemptAt: row.last_attempt_at,
      lastSuccessAt: row.last_success_at,
      version: row.version,
      builtAt: row.built_at,
      providers: row.providers,
      file:
        row.file_size === null || row.file_modified_at === null
          ? null
          : { size: Number(row.file_size), modifiedMs: row.file_modified_at.getTime() },
      lastError: row.last_error,
      failures: row.failures,
    };
  };
  return { locations: byKind("locations"), data_centers: byKind("data_centers") };
}

type Attempt =
  | {
      ok: true;
      version?: string | null;
      builtAt: Date;
      providers?: number | null;
      file: FileStamp | null;
      /** Sources that failed while the file was still written. */
      problem?: string | null;
    }
  | { ok: false; error: string };

const MAX_ERROR_LENGTH = 2000;

async function recordAttempt(
  db: Kysely<Database>,
  kind: UpdateKind,
  attempt: Attempt,
  now: Date,
): Promise<void> {
  if (attempt.ok) {
    const values = {
      last_attempt_at: now,
      last_success_at: now,
      version: attempt.version ?? null,
      built_at: attempt.builtAt,
      providers: attempt.providers ?? null,
      file_size: attempt.file?.size ?? null,
      file_modified_at: attempt.file === null ? null : new Date(attempt.file.modifiedMs),
      last_error: attempt.problem?.slice(0, MAX_ERROR_LENGTH) ?? null,
      failures: 0,
    };
    await db
      .insertInto("location_data_updates")
      .values({ kind, ...values })
      .onConflict((conflict) => conflict.column("kind").doUpdateSet(values))
      .execute();
    return;
  }
  const error = attempt.error.slice(0, MAX_ERROR_LENGTH);
  await db
    .insertInto("location_data_updates")
    .values({ kind, last_attempt_at: now, last_error: error, failures: 1 })
    .onConflict((conflict) =>
      conflict.column("kind").doUpdateSet({
        last_attempt_at: now,
        last_error: error,
        failures: sql`location_data_updates.failures + 1`,
      }),
    )
    .execute();
}

/**
 * Whether the location database is due: when it is missing, or older than
 * this month's file. Which month a file holds comes from the last recorded
 * update, or else the month marker beside it, if either still describes
 * this file (same size and time); otherwise from the month it was written in.
 */
export function locationsDue(
  file: FileStamp | null,
  recorded: UpdateStatus | null,
  now: Date,
  marker: MonthMarker | null = null,
): { due: boolean; have: string | null; known: boolean } {
  if (file === null) return { due: true, have: null, known: false };
  let have: string;
  let known = true;
  if (recorded !== null && recorded.version !== null && sameStamp(recorded.file, file)) {
    have = recorded.version;
  } else if (marker !== null && sameStamp(marker, file)) {
    have = marker.month;
  } else {
    have = yearMonth(0, new Date(file.modifiedMs));
    known = false;
  }
  return { due: have < yearMonth(0, now), have, known };
}

/** Whether the data-center ranges are due: missing, unreadable, or written over 7 days ago. */
export function dataCentersDue(file: DataCenterFile | undefined, now: Date): boolean {
  if (file === undefined) return true;
  const ageMs = now.getTime() - Date.parse(file.updatedAt);
  return ageMs > DATA_CENTERS_MAX_AGE_DAYS * 86_400_000;
}

/**
 * Missing files retry after 15 minutes, doubling to 6 hours. Existing files retry
 * at the next check, or daily after 3 consecutive failures.
 */
export function retryDelayMs(failures: number, missing: boolean): number {
  if (missing) {
    return Math.min(MISSING_RETRY_MS * 2 ** Math.max(0, failures - 1), UPDATE_CHECK_INTERVAL_MS);
  }
  return failures >= FAILURES_BEFORE_DAILY ? DAILY_RETRY_MS : UPDATE_CHECK_INTERVAL_MS;
}

/** Gives up after `timeoutMs`, or as soon as `stop` aborts. */
const deadline = (timeoutMs: number, stop: AbortSignal | undefined) =>
  stop === undefined
    ? AbortSignal.timeout(timeoutMs)
    : AbortSignal.any([AbortSignal.timeout(timeoutMs), stop]);

/** Follows at most 5 redirects, all HTTPS. */
export async function fetchHttps(
  fetchFn: Fetch,
  url: string,
  signal: AbortSignal,
): Promise<Response> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (new URL(current).protocol !== "https:") {
      throw new Error(`refused ${current}: only https is followed`);
    }
    const response = await fetchFn(current, { signal, redirect: "manual" });
    const location = response.headers.get("location");
    if (response.status < 300 || response.status >= 400 || location === null) return response;
    await response.body?.cancel();
    current = new URL(location, current).toString();
  }
  throw new Error(`more than ${MAX_REDIRECTS} redirects from ${url}`);
}

async function fetchOk(fetchFn: Fetch, url: string, signal: AbortSignal): Promise<Response> {
  const response = await fetchHttps(fetchFn, url, signal);
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`${response.status} from ${url}`);
  }
  return response;
}

/** A body as text, refused once it passes `maxBytes`. */
export async function readTextCapped(response: Response, maxBytes: number): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`${response.url || "the response"} is larger than ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Passes bytes through, and fails the stream once more than `maxBytes` went by. */
function byteLimit(maxBytes: number, what: string): Transform {
  let total = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      total += chunk.length;
      if (total > maxBytes) callback(new Error(`${what} is larger than ${maxBytes} bytes`));
      else callback(null, chunk);
    },
  });
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export type LocationsResult =
  | { updated: true; month: string; info: LocationFileInfo; file: FileStamp | null }
  /** Nothing newer than `have` is published yet, as early on the 1st. */
  | { updated: false; reason: string };

/**
 * Downloads this month's location database (or last month's, early on the
 * 1st, before this month's is out), unzips it beside `destination`,
 * checks it, and moves it over the old file, with its month marker. Months
 * not newer than `have` are not downloaded again. Throws when the download
 * or the check fails; the old file stays.
 */
export async function downloadLocations(
  destination: string,
  {
    fetch: fetchFn,
    now,
    have = null,
    log,
    stop,
    limits = DOWNLOAD_LIMITS,
    holder = newHolder(),
  }: {
    fetch: Fetch;
    now: Date;
    have?: string | null;
    log: UpdateLog;
    stop?: AbortSignal | undefined;
    limits?: DownloadLimits;
    holder?: string;
  },
): Promise<LocationsResult> {
  const months = [yearMonth(0, now), yearMonth(1, now)].filter(
    (month) => have === null || month > have,
  );
  if (months.length === 0) return { updated: false, reason: `the ${have} file is the latest` };
  const partial = partialPath(destination, holder);
  await mkdir(dirname(destination), { recursive: true });

  let month: string | undefined;
  for (const candidate of months) {
    const url = locationsUrl(candidate);
    const response = await fetchHttps(fetchFn, url, deadline(LOCATIONS_TIMEOUT_MS, stop));
    if (!response.ok || response.body === null) {
      await response.body?.cancel();
      log("info", "location database not available", { url, status: response.status });
      continue;
    }
    log("info", "downloading the location database", { url });
    try {
      await pipeline(
        Readable.fromWeb(response.body),
        createGunzip(),
        byteLimit(limits.locationBytes, "the unzipped location database"),
        createWriteStream(partial),
      );
    } catch (error) {
      await rm(partial, { force: true });
      throw new Error(`downloading ${url} failed: ${message(error)}`, { cause: error });
    }
    month = candidate;
    break;
  }
  if (month === undefined) {
    if (have !== null) {
      return { updated: false, reason: `no file newer than ${have} is published yet` };
    }
    throw new Error("no DB-IP City Lite file is available for this month or last month");
  }

  let info: LocationFileInfo;
  try {
    await sync(partial);
    info = await checkLocationFile(partial);
  } catch (error) {
    await rm(partial, { force: true });
    throw new Error(`the downloaded file failed its check: ${message(error)}`, { cause: error });
  }
  await rename(partial, destination);
  const file = await stampOf(destination);
  if (file !== null) {
    try {
      await writeMonthMarker(destination, { month, ...file }, holder);
    } catch (error) {
      // The file is in place and recorded; without the marker, its month
      // comes from PostgreSQL, or from when it was written.
      log("warn", "the location database's month could not be written beside it", {
        err: message(error),
      });
    }
  }
  return { updated: true, month, info, file };
}

export interface DataCentersResult {
  providers: number;
  /** Ranges left out because they were malformed. */
  skipped: number;
  /** One line per source that failed; it kept its previous ranges, if any. */
  failures: string[];
  updatedAt: Date;
  file: FileStamp | null;
}

/**
 * Downloads every data-center source and writes the file in one step. A
 * source that fails keeps its ranges from the old file. Throws when no
 * source at all worked; the old file stays as it was.
 */
export async function downloadDataCenterRanges(
  destination: string,
  {
    fetch: fetchFn,
    now,
    stop,
    limits = DOWNLOAD_LIMITS,
    holder = newHolder(),
  }: {
    fetch: Fetch;
    now: Date;
    stop?: AbortSignal | undefined;
    limits?: DownloadLimits;
    holder?: string;
  },
): Promise<DataCentersResult> {
  await mkdir(dirname(destination), { recursive: true });
  const previous = await readDataCenterFile(destination);
  const { file, failures } = await downloadDataCenters({
    fetchText: async (url) =>
      readTextCapped(
        await fetchOk(fetchFn, url, deadline(DATA_CENTERS_TIMEOUT_MS, stop)),
        limits.textBytes,
      ),
    fetchStream: async (url) => {
      const response = await fetchOk(fetchFn, url, deadline(DATA_CENTERS_TIMEOUT_MS, stop));
      if (response.body === null) throw new Error(`no body from ${url}`);
      return response.body;
    },
    previous,
    now,
    maxLineLength: limits.lineLength,
  });
  // Stopped part way: every source after the stop failed, and kept old ranges.
  stop?.throwIfAborted();
  // Only kept ranges, none new: the old file stays as it is, and stays due.
  if (!file.providers.some((provider) => provider.fetchedAt === file.updatedAt)) {
    throw new Error(`no source could be downloaded: ${failures.join("; ")}`);
  }
  const loaded = DataCenters.from(file);
  const partial = partialPath(destination, holder);
  await writeDurably(partial, JSON.stringify(file));
  await rename(partial, destination);
  return {
    providers: loaded.providers.length,
    skipped: loaded.skipped,
    failures,
    updatedAt: loaded.updatedAt,
    file: await stampOf(destination),
  };
}

/**
 * Allows one updater across workers and manual commands via location_data_lease.
 * No PostgreSQL connection is held during downloads. A dead process's lease
 * expires after LEASE_MS.
 */
export async function withUpdateLease<T>(
  db: Kysely<Database>,
  work: () => Promise<T>,
  log: UpdateLog,
  holder: string = newHolder(),
): Promise<{ ran: true; value: T } | { ran: false; until: Date | null }> {
  // Reclaim our own lease if the previous release failed during a PostgreSQL outage.
  const taken = await sql<{ holder: string }>`
    insert into location_data_lease (id, holder, expires_at)
    values (true, ${holder}, now() + ${`${LEASE_MS} milliseconds`}::interval)
    on conflict (id) do update
      set holder = excluded.holder, expires_at = excluded.expires_at
      where location_data_lease.expires_at < now()
        or location_data_lease.holder = excluded.holder
    returning holder
  `.execute(db);
  if (taken.rows[0]?.holder !== holder) {
    const held = await db.selectFrom("location_data_lease").select("expires_at").executeTakeFirst();
    return { ran: false, until: held?.expires_at ?? null };
  }
  try {
    return { ran: true, value: await work() };
  } finally {
    try {
      await db.deleteFrom("location_data_lease").where("holder", "=", holder).execute();
    } catch (error) {
      log("warn", "the location data update could not give back its lease", {
        err: message(error),
      });
    }
  }
}

export type UpdateOutcome =
  /** GEO_SOURCE is not "database": no location file is needed. */
  | "not_needed"
  | "not_due"
  | "updated"
  /** Due, but nothing newer is published yet. */
  | "latest"
  /** Due, but the last attempt failed too recently (retryDelayMs). */
  | "waiting"
  | "failed";

export type UpdateRun =
  | {
      ran: true;
      locations: UpdateOutcome;
      dataCenters: UpdateOutcome;
      /** When the next round should run, by the failures and missing files it saw. */
      nextCheckInMs: number;
    }
  | { ran: false; reason: "off" }
  /** Another process holds the lease, until `until` at the latest. */
  | { ran: false; reason: "locked"; until: Date | null };

export interface UpdateOptions {
  /** Null when PostgreSQL cannot be reached: the manual command then updates without lease or status. */
  db: Kysely<Database> | null;
  geoSource: GeoSource;
  databasePath: string;
  dataCentersPath: string;
  fetch?: Fetch;
  now?: () => Date;
  log: UpdateLog;
  /** Manual updates ignore due dates, retry delays, and the automatic-update setting. */
  force?: boolean;
  /**
   * Aborting it stops the downloads under way, as the worker does on
   * shutdown: the old files stay. A file already moved into place is
   * still recorded; a failure the stop caused is not.
   */
  stop?: AbortSignal;
  /** First, delete partial downloads stopped updates left (the worker's first round). */
  removePartials?: boolean;
  limits?: DownloadLimits;
  /** The worker reuses one holder for its lifetime; other callers default to a new one. */
  holder?: string;
  /** A round gives up after this, before its lease could expire. */
  roundTimeoutMs?: number;
}

/**
 * One round: for each file, whether it is due, and if so the download,
 * the check, and the swap, recorded in location_data_updates. A failure
 * is logged and recorded, keeps the old file, and waits for retryDelayMs;
 * it never throws for a failed download.
 */
export async function updateLocationData(options: UpdateOptions): Promise<UpdateRun> {
  const { db, force = false, holder = newHolder() } = options;
  const round = () =>
    updateFiles(
      { ...options, holder },
      {
        signal: AbortSignal.any([
          ...(options.stop === undefined ? [] : [options.stop]),
          AbortSignal.timeout(options.roundTimeoutMs ?? LEASE_MS - LEASE_MARGIN_MS),
        ]),
      },
    );
  if (db === null) return { ran: true, ...(await round()) };
  if (!force && !(await readInstanceSettings(db)).updateLocationData) {
    return { ran: false, reason: "off" };
  }
  const leased = await withUpdateLease(db, round, options.log, holder);
  return leased.ran
    ? { ran: true, ...leased.value }
    : { ran: false, reason: "locked", until: leased.until };
}

async function updateFiles(
  {
    db,
    geoSource,
    databasePath,
    dataCentersPath,
    fetch: fetchFn = fetch,
    now = () => new Date(),
    log,
    force = false,
    stop,
    removePartials = false,
    limits = DOWNLOAD_LIMITS,
    holder = newHolder(),
  }: UpdateOptions,
  { signal }: { signal: AbortSignal },
): Promise<{
  locations: UpdateOutcome;
  dataCenters: UpdateOutcome;
  nextCheckInMs: number;
}> {
  if (removePartials) await removeStalePartials([databasePath, dataCentersPath]);
  const recorded = db === null ? null : await readUpdateStatus(db);
  const record = async (kind: UpdateKind, attempt: Attempt) => {
    // A failure the stop caused says nothing about the source.
    if (db === null || (!attempt.ok && stop?.aborted === true)) return;
    try {
      await recordAttempt(db, kind, attempt, now());
    } catch (error) {
      log("warn", "the update's status could not be recorded", { kind, err: message(error) });
    }
  };
  const next: number[] = [];
  const failed = (status: UpdateStatus | null, missing: boolean) => {
    if (stop?.aborted === true) return;
    next.push(retryDelayMs((status?.failures ?? 0) + 1, missing));
  };
  const waiting = (status: UpdateStatus | null, missing: boolean) => {
    if (force || status === null || status.failures === 0) return false;
    const retryAt = status.lastAttemptAt.getTime() + retryDelayMs(status.failures, missing);
    if (now().getTime() >= retryAt) return false;
    next.push(retryAt - now().getTime());
    return true;
  };

  let locations: UpdateOutcome = "not_needed";
  if (geoSource === "database") {
    const file = await stampOf(databasePath);
    const status = recorded?.locations ?? null;
    let due = locationsDue(file, status, now(), await readMonthMarker(databasePath));
    if (file !== null && !due.due && !due.known) {
      // An unrecorded file that fails validation is due immediately.
      try {
        await checkLocationFile(databasePath);
      } catch (error) {
        log("warn", "the location database in place does not open; downloading it again", {
          err: message(error),
        });
        due = { due: true, have: null, known: false };
      }
    }
    if (!due.due && !force) {
      locations = "not_due";
    } else if (waiting(status, file === null)) {
      locations = "waiting";
    } else {
      try {
        const result = await downloadLocations(databasePath, {
          fetch: fetchFn,
          now: now(),
          have: force ? null : due.have,
          log,
          stop: signal,
          limits,
          holder,
        });
        if (result.updated) {
          locations = "updated";
          log("info", "location database updated", {
            month: result.month,
            type: result.info.type,
            builtAt: result.info.builtAt.toISOString().slice(0, 10),
            bytes: result.file?.size,
          });
          await record("locations", {
            ok: true,
            version: result.month,
            builtAt: result.info.builtAt,
            file: result.file,
          });
        } else {
          locations = "latest";
          log("info", "location database not updated", { reason: result.reason });
        }
      } catch (error) {
        locations = "failed";
        log("warn", "updating the location database failed; the old file stays", {
          err: message(error),
        });
        await record("locations", { ok: false, error: message(error) });
        failed(status, file === null);
      }
    }
  }

  let dataCenters: UpdateOutcome;
  const current = await readDataCenterFile(dataCentersPath);
  const status = recorded?.data_centers ?? null;
  if (signal.aborted || (!force && !dataCentersDue(current, now()))) {
    dataCenters = "not_due";
  } else if (waiting(status, current === undefined)) {
    dataCenters = "waiting";
  } else {
    try {
      const result = await downloadDataCenterRanges(dataCentersPath, {
        fetch: fetchFn,
        now: now(),
        stop: signal,
        limits,
        holder,
      });
      dataCenters = "updated";
      log(result.failures.length === 0 ? "info" : "warn", "data-center ranges updated", {
        providers: result.providers,
        skipped: result.skipped,
        failures: result.failures,
      });
      await record("data_centers", {
        ok: true,
        builtAt: result.updatedAt,
        providers: result.providers,
        file: result.file,
        problem:
          result.failures.length === 0
            ? null
            : `Some sources failed and kept their previous ranges: ${result.failures.join("; ")}`,
      });
    } catch (error) {
      dataCenters = "failed";
      log("warn", "updating the data-center ranges failed; the old file stays", {
        err: message(error),
      });
      await record("data_centers", { ok: false, error: message(error) });
      failed(status, current === undefined);
    }
  }
  return {
    locations,
    dataCenters,
    nextCheckInMs: Math.max(SETTING_POLL_MS, Math.min(UPDATE_CHECK_INTERVAL_MS, ...next)),
  };
}

/**
 * When the worker runs a round: each minute it reads the setting, and runs
 * one when the last round said so (UpdateRun.nextCheckInMs), at start, or
 * as soon as the setting is turned on.
 */
export class UpdateSchedule {
  #nextAt = 0;
  #wasOn = false;

  due(now: number, on: boolean): boolean {
    if (!on) {
      this.#wasOn = false;
      return false;
    }
    if (!this.#wasOn) {
      this.#wasOn = true;
      this.#nextAt = 0;
    }
    return now >= this.#nextAt;
  }

  /** A round ran (or found the lease taken, and tries again in 15 minutes). */
  ran(now: number, run: UpdateRun): void {
    this.#nextAt = now + (run.ran ? run.nextCheckInMs : MISSING_RETRY_MS);
  }

  /** A round failed outright (PostgreSQL unreachable): tried again at the next check. */
  failed(now: number): void {
    this.#nextAt = now + MISSING_RETRY_MS;
  }
}

/**
 * The worker's location data job: each tick (every minute) reads the
 * setting and runs a round when UpdateSchedule says so, as one holder for
 * the worker's whole life. stop() cuts off a download under way and waits
 * for the round to finish, so its lease is given back.
 */
export class LocationDataJob {
  readonly #options: Omit<UpdateOptions, "stop" | "holder" | "removePartials" | "db"> & {
    db: Kysely<Database>;
  };
  readonly #holder = newHolder();
  readonly #abort = new AbortController();
  readonly #schedule = new UpdateSchedule();
  #firstRound = true;
  /** Log each outage and recovery once. */
  #failing = false;
  #running: Promise<void> = Promise.resolve();
  #stopped = false;

  constructor(
    options: Omit<UpdateOptions, "stop" | "holder" | "removePartials" | "db"> & {
      db: Kysely<Database>;
    },
  ) {
    this.#options = options;
  }

  tick(): Promise<void> {
    if (this.#stopped) return Promise.resolve();
    this.#running = this.#tick();
    return this.#running;
  }

  async #tick(): Promise<void> {
    const { db, log } = this.#options;
    try {
      const on = (await readInstanceSettings(db)).updateLocationData;
      if (this.#failing) log("info", "checking for location data updates works again");
      this.#failing = false;
      if (!this.#schedule.due(Date.now(), on)) return;
      const run = await updateLocationData({
        ...this.#options,
        stop: this.#abort.signal,
        holder: this.#holder,
        removePartials: this.#firstRound,
      });
      if (run.ran) this.#firstRound = false;
      this.#schedule.ran(Date.now(), run);
      if (!run.ran && run.reason === "locked") {
        log("info", "another process is updating the location data", {
          until: run.until?.toISOString(),
        });
      }
    } catch (error) {
      this.#schedule.failed(Date.now());
      if (!this.#failing) {
        log("error", "checking for location data updates failed", { err: message(error) });
      }
      this.#failing = true;
    }
  }

  /** Cuts off a download under way, and waits for its round to end. */
  async stop(): Promise<void> {
    this.#stopped = true;
    this.#abort.abort();
    await this.#running;
  }
}
