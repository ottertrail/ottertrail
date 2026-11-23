import type { IsDataCenter } from "./data-centers.ts";
import { GeoDatabase, type Locate, noLocation } from "./geo.ts";
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

/**
 * How often the API checks whether any project uses the location database,
 * so the file is loaded or dropped within this after a change. The project
 * routes also ask for a check at once (checkNeeded).
 */
export const NEEDED_CHECK_MS = 60 * 1000;

/**
 * How long the check may take. A network that drops packets could otherwise
 * hold the queue, and with it every reload, for as long as TCP waits.
 */
export const NEEDED_TIMEOUT_MS = 5_000;

/** Whether any project's location source is "database" (projects/projects.ts). */
export type LocationFileNeeded = () => Promise<boolean>;

export interface ReloadLog {
  info(msg: string): void;
  warn(msg: string): void;
}

export interface LoadedLocationData {
  /** The location database in use; null when none is loaded (or lookup is off). */
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

/** The check's answer, or an error after NEEDED_TIMEOUT_MS. The query may go on; nothing waits for it. */
async function bounded(needed: LocationFileNeeded): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      needed(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`no answer within ${NEEDED_TIMEOUT_MS / 1000} seconds`)),
          NEEDED_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const modified = (stamp: FileStamp | null) => (stamp === null ? null : new Date(stamp.modifiedMs));

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Reloads files when size or modification time changes. Swap only after a full
 * load and validation so lookups never see partial data. Failed loads keep the old
 * copy and retry only after another file change; replaced copies can be freed.
 *
 * The location file is loaded only while some project's location source is
 * "database". When none is, the loaded copy (about 130 MB) is dropped, and
 * the garbage collector frees it; when one is again, the file is loaded if it
 * exists. The data-center ranges, for bot filtering, load either way.
 */
export class LiveLocationData {
  readonly #needed: LocationFileNeeded;
  readonly #databasePath: string;
  readonly #dataCentersPath: string;
  #locate: Locate;
  #isDataCenter: IsDataCenter;
  #locationStamp: FileStamp | null = null;
  #dataCenterStamp: FileStamp | null = null;
  #loaded: LoadedLocationData;
  #timer: ReturnType<typeof setInterval> | undefined;
  #neededTimer: ReturnType<typeof setInterval> | undefined;
  #reloading: Promise<void> | undefined;
  /** Whether some project used the file at the last check. */
  #on = true;
  /** Runs reloads and checks one at a time. */
  #queue: Promise<void> = Promise.resolve();
  #log: ReloadLog = { info: () => {}, warn: () => {} };
  /** Log each outage of the check once, and its end once. */
  #failing = false;

  private constructor(needed: LocationFileNeeded, databasePath: string, dataCentersPath: string) {
    this.#needed = needed;
    this.#databasePath = databasePath;
    this.#dataCentersPath = dataCentersPath;
    this.#locate = noLocation;
    this.#isDataCenter = () => false;
    this.#loaded = {
      locations: null,
      locationsError: null,
      dataCenters: null,
      dataCentersError: null,
    };
  }

  readonly locate: Locate = (ip) => this.#locate(ip);

  readonly isDataCenter: IsDataCenter = (ip) => this.#isDataCenter(ip);

  get loaded(): LoadedLocationData {
    return this.#loaded;
  }

  /**
   * Missing or stale files allow startup with warnings in messages. Keep only text
   * there so replaced startup data can be freed.
   */
  static async open(options: {
    needed: LocationFileNeeded;
    databasePath: string;
    dataCentersPath: string;
    now?: Date;
  }): Promise<{ data: LiveLocationData; messages: StartupMessage[] }> {
    const data = new LiveLocationData(
      options.needed,
      options.databasePath,
      options.dataCentersPath,
    );
    const messages: StartupMessage[] = [];
    try {
      data.#on = await bounded(options.needed);
    } catch (error) {
      // As if it were; the next check corrects it.
      messages.push({
        ok: false,
        message: `Could not check whether any project uses the location database, so it loads: ${message(error)}`,
      });
    }
    // Stamp first so a file replaced during loading is retried at the next poll.
    // While no project uses it, no stamp: when one does, the file loads.
    data.#locationStamp = data.#on ? await stampOf(options.databasePath) : null;
    data.#dataCenterStamp = await stampOf(options.dataCentersPath);
    const location = await setUpLocation(data.#on, options.databasePath, options.now);
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
    for (const { ok, message: text } of [location, dataCenters])
      messages.push({ ok, message: text });
    return { data, messages };
  }

  /** Runs one task after the ones before it. */
  #serial(task: () => Promise<void>): Promise<void> {
    const run = this.#queue.then(task);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  /**
   * Checks whether any project uses the location file; drops it when none
   * does any more, and loads it when one does again. Never throws.
   */
  checkNeeded(log: ReloadLog = this.#log): Promise<void> {
    return this.#serial(() => this.#checkNeeded(log));
  }

  async #checkNeeded(log: ReloadLog): Promise<void> {
    let on: boolean;
    try {
      on = await bounded(this.#needed);
    } catch (error) {
      if (!this.#failing) {
        log.warn(
          `Could not check whether any project uses the location database; it stays as it is: ${message(error)}`,
        );
      }
      this.#failing = true;
      return;
    }
    if (this.#failing)
      log.info("Checking whether any project uses the location database works again");
    this.#failing = false;
    if (on === this.#on) {
      // Needed and none loaded, as on a new install: a file the worker just
      // downloaded loads within a minute, not at the next 10-minute look.
      if (on && this.#loaded.locations === null) await this.#reloadLocations(log);
      return;
    }
    this.#on = on;
    // Either way, the next load reads the file afresh.
    this.#locationStamp = null;
    if (on) {
      log.info("A project uses the location database again: loading it");
      await this.#reloadLocations(log);
      return;
    }
    // Nothing else holds the database, so the garbage collector frees it.
    this.#locate = noLocation;
    this.#loaded = { ...this.#loaded, locations: null, locationsError: null };
    log.info("No project uses the location database: it was dropped from memory");
  }

  /**
   * Checks whether the location file is needed, then looks for changed
   * files and loads them. Never throws; a run in progress is shared.
   */
  reload(log: ReloadLog): Promise<void> {
    this.#reloading ??= this.#serial(() => this.#reload(log)).finally(() => {
      this.#reloading = undefined;
    });
    return this.#reloading;
  }

  async #reload(log: ReloadLog): Promise<void> {
    await this.#checkNeeded(log);
    if (this.#on) await this.#reloadLocations(log);
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
      this.#locate = (ip) => geo.lookup(ip);
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

  /**
   * Looks for changed files every `intervalMs`, and checks whether the
   * location file is needed every `neededIntervalMs`, until stop(). The
   * timers do not keep the process alive.
   */
  start(
    log: ReloadLog,
    intervalMs: number = RELOAD_INTERVAL_MS,
    neededIntervalMs: number = NEEDED_CHECK_MS,
  ): void {
    this.stop();
    this.#log = log;
    this.#timer = setInterval(() => void this.reload(log), intervalMs);
    this.#timer.unref();
    this.#neededTimer = setInterval(() => void this.checkNeeded(log), neededIntervalMs);
    this.#neededTimer.unref();
  }

  stop(): void {
    clearInterval(this.#timer);
    clearInterval(this.#neededTimer);
    this.#timer = undefined;
    this.#neededTimer = undefined;
  }
}
