import type { EventEmitter } from "node:events";

import type { Kysely } from "kysely";

import type { GeoSource } from "../config.ts";
import type { Database } from "../db/schema.ts";
import { type Fetch, updateLocationData } from "./updates.ts";

/**
 * Aborts `controller` on SIGINT or SIGTERM, so a stopped manual command
 * still ends its round: the partial file goes, and the lease is given back.
 * Returns the exit code the signal asks for (130 or 143) once one came,
 * and a function that stops listening.
 */
export function stopOnSignals(
  controller: AbortController,
  emitter: Pick<EventEmitter, "once" | "off"> = process,
): { exitCode: () => number | null; remove: () => void } {
  let code: number | null = null;
  const handlers = {
    SIGINT: () => {
      code = 130;
      controller.abort(new Error("stopped by SIGINT"));
    },
    SIGTERM: () => {
      code = 143;
      controller.abort(new Error("stopped by SIGTERM"));
    },
  };
  emitter.once("SIGINT", handlers.SIGINT);
  emitter.once("SIGTERM", handlers.SIGTERM);
  return {
    exitCode: () => code,
    remove: () => {
      emitter.off("SIGINT", handlers.SIGINT);
      emitter.off("SIGTERM", handlers.SIGTERM);
    },
  };
}

/**
 * `vp run geo:update` (scripts/update-geo.ts): both files now, whatever is
 * due and whatever the setting. Prints what happened, and returns the
 * exit code: 0, or 1 when a download failed, the round was stopped, or
 * another update holds the lease.
 */
export async function manualUpdate(options: {
  db: Kysely<Database> | null;
  geoSource: GeoSource;
  databasePath: string;
  dataCentersPath: string;
  stop: AbortSignal;
  fetch?: Fetch;
  out?: { log: (line: string) => void; error: (line: string) => void };
}): Promise<number> {
  const out = options.out ?? { log: console.log, error: console.error };
  const run = await updateLocationData({
    db: options.db,
    geoSource: options.geoSource,
    databasePath: options.databasePath,
    dataCentersPath: options.dataCentersPath,
    force: true,
    stop: options.stop,
    // Not under the worker's first-round rule: only partials older than a lease.
    removePartials: true,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    log: (level, msg, fields = {}) => {
      const line = Object.keys(fields).length === 0 ? msg : `${msg} ${JSON.stringify(fields)}`;
      if (level === "info") out.log(line);
      else out.error(line);
    },
  });
  if (!run.ran) {
    out.error(
      run.reason === "locked" && run.until !== null
        ? `Another update is running (the worker's, or another command's). Its lease ends at ${run.until.toISOString()} at the latest; try again after that, or once it is done.`
        : "Another update is running (the worker's, or another command's). Try again later.",
    );
    return 1;
  }
  if (options.stop.aborted) {
    out.error("Stopped. The old files stay, and the next update tries again.");
    return 1;
  }
  if (run.locations === "not_needed") {
    out.log(`No location database needed: GEO_SOURCE is "${options.geoSource}".`);
  } else if (run.locations === "updated") {
    out.log(
      'Credit "IP geolocation by DB-IP" (https://db-ip.com) wherever locations are shown: the CC BY 4.0 license requires it.',
    );
  }
  out.log("The API loads the new files within 10 minutes, without a restart.");
  return run.locations === "failed" || run.dataCenters === "failed" ? 1 : 0;
}
