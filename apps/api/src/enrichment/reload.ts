import type { GeoSource } from "../config.ts";
import type { IsDataCenter } from "./data-centers.ts";
import { GeoDatabase, type Locate } from "./geo.ts";
import { setUpDataCenters, setUpLocation } from "./setup.ts";
import {
  checkDataCenterFile,
  checkLocationDatabase,
  type FileStamp,
  sameStamp,
  stampOf,
} from "./updates.ts";

/** How often the API looks whether either file changed on disk. */
export const RELOAD_INTERVAL_MS = 10 * 60 * 1000;

export interface ReloadLog {
  info(msg: string): void;
  warn(msg: string): void;
}

/** What the API has loaded, for the Settings page. */
export interface LoadedLocationData {
  geoSource: GeoSource;
  /** The location database in use; null when none is loaded (or none is needed). */
  locations: { type: string; builtAt: Date; fileModifiedAt: Date | null } | null;
  /** Why the last changed location file could not be used; null once one loads. */
  locationsError: string | null;
  /** The data-center ranges in use; null when none are loaded. */
  dataCenters: { providers: number; updatedAt: Date; fileModifiedAt: Date | null } | null;
  /** Why the last changed data-center file could not be used; null once one loads. */
  dataCentersError: string | null;
}

/** A startup message to log: a warning when `ok` is false. */
export interface StartupMessage {
  ok: boolean;
  message: string;
}

const modified = (stamp: FileStamp | null) => (stamp === null ? null : new Date(stamp.modifiedMs));

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The location database and the data-center ranges the API uses, loaded
 * at startup and again whenever a file changes on disk (its size or
 * modification time), which the worker's updates (updates.ts) and the
 * manual command do. `locate` and `isDataCenter` always read the copy in
 * use: a new one replaces it only once it has loaded completely and
 * passed the update's check, so no lookup sees half a file. A file that
 * fails keeps the old copy, and is tried again only once it changes again.
 * Only the copy in use is referenced, so a replaced one is freed.
 */
export class LiveLocationData {
  readonly #geoSource: GeoSource;
  readonly #databasePath: string;
  readonly #dataCentersPath: string;
  #locate: Locate;
  #isDataCenter: IsDataCenter;
  #locationStamp: FileStamp | null = null;
  #dataCenterStamp: FileStamp | null = null;
  #loaded: LoadedLocationData;
  #timer: ReturnType<typeof setInterval> | undefined;
  #reloading: Promise<void> | undefined;

  private constructor(geoSource: GeoSource, databasePath: string, dataCentersPath: string) {
    this.#geoSource = geoSource;
    this.#databasePath = databasePath;
    this.#dataCentersPath = dataCentersPath;
    this.#locate = () => ({});
    this.#isDataCenter = () => false;
    this.#loaded = {
      geoSource,
      locations: null,
      locationsError: null,
      dataCenters: null,
      dataCentersError: null,
    };
  }

  /** Finds the location for a request with the database in use now. */
  readonly locate: Locate = (request) => this.#locate(request);

  /** Whether an address is in the data-center ranges in use now. */
  readonly isDataCenter: IsDataCenter = (ip) => this.#isDataCenter(ip);

  get loaded(): LoadedLocationData {
    return this.#loaded;
  }

  /**
   * Loads both files as the API always has: a missing or old file starts
   * the API anyway, with a warning in `messages` to log. The messages hold
   * text only, so nothing else keeps the startup copies once replaced.
   */
  static async open(options: {
    geoSource: GeoSource;
    databasePath: string;
    dataCentersPath: string;
    now?: Date;
  }): Promise<{ data: LiveLocationData; messages: StartupMessage[] }> {
    const data = new LiveLocationData(
      options.geoSource,
      options.databasePath,
      options.dataCentersPath,
    );
    // Stamped before loading: a file replaced in between is loaded again at the next look.
    data.#locationStamp = await stampOf(options.databasePath);
    data.#dataCenterStamp = await stampOf(options.dataCentersPath);
    const location = await setUpLocation(options.geoSource, options.databasePath, options.now);
    const dataCenters = await setUpDataCenters(options.dataCentersPath, options.now);
    data.#locate = location.locate;
    data.#isDataCenter = dataCenters.isDataCenter;
    data.#loaded = {
      ...data.#loaded,
      locations:
        location.database === undefined
          ? null
          : { ...location.database, fileModifiedAt: modified(data.#locationStamp) },
      dataCenters:
        dataCenters.ranges === undefined
          ? null
          : { ...dataCenters.ranges, fileModifiedAt: modified(data.#dataCenterStamp) },
    };
    return {
      data,
      messages: [location, dataCenters].map(({ ok, message: text }) => ({ ok, message: text })),
    };
  }

  /** Looks for changed files, and loads them. Never throws; a run in progress is shared. */
  reload(log: ReloadLog): Promise<void> {
    this.#reloading ??= this.#reload(log).finally(() => {
      this.#reloading = undefined;
    });
    return this.#reloading;
  }

  async #reload(log: ReloadLog): Promise<void> {
    if (this.#geoSource === "database") await this.#reloadLocations(log);
    await this.#reloadDataCenters(log);
  }

  async #reloadLocations(log: ReloadLog): Promise<void> {
    const stamp = await stampOf(this.#databasePath);
    if (stamp === null || sameStamp(stamp, this.#locationStamp)) return;
    this.#locationStamp = stamp;
    try {
      // For a moment both copies are in memory, about 130 MB each.
      const geo = await GeoDatabase.open(this.#databasePath);
      const info = checkLocationDatabase(geo);
      this.#locate = (request) => geo.lookup(request.ip);
      this.#loaded = {
        ...this.#loaded,
        locations: { ...info, fileModifiedAt: modified(stamp) },
        locationsError: null,
      };
      log.info(
        `Loaded the new location database at ${this.#databasePath}: ${info.type}, built on ${info.builtAt.toISOString().slice(0, 10)}`,
      );
    } catch (error) {
      this.#loaded = { ...this.#loaded, locationsError: message(error) };
      log.warn(
        `The location database at ${this.#databasePath} changed but could not be used, so the one loaded before stays: ${message(error)}`,
      );
    }
  }

  async #reloadDataCenters(log: ReloadLog): Promise<void> {
    const stamp = await stampOf(this.#dataCentersPath);
    if (stamp === null || sameStamp(stamp, this.#dataCenterStamp)) return;
    this.#dataCenterStamp = stamp;
    try {
      const ranges = await checkDataCenterFile(this.#dataCentersPath);
      this.#isDataCenter = (ip) => ranges.has(ip);
      this.#loaded = {
        ...this.#loaded,
        dataCenters: {
          providers: ranges.providers.length,
          updatedAt: ranges.updatedAt,
          fileModifiedAt: modified(stamp),
        },
        dataCentersError: null,
      };
      log.info(
        `Loaded the new data-center ranges at ${this.#dataCentersPath}: ${ranges.providers.length} providers`,
      );
    } catch (error) {
      this.#loaded = { ...this.#loaded, dataCentersError: message(error) };
      log.warn(
        `The data-center ranges at ${this.#dataCentersPath} changed but could not be used, so the ones loaded before stay: ${message(error)}`,
      );
    }
  }

  /** Looks every `intervalMs` until stop(); the timer does not keep the process alive. */
  start(log: ReloadLog, intervalMs: number = RELOAD_INTERVAL_MS): void {
    this.stop();
    this.#timer = setInterval(() => void this.reload(log), intervalMs);
    this.#timer.unref();
  }

  stop(): void {
    clearInterval(this.#timer);
    this.#timer = undefined;
  }
}
