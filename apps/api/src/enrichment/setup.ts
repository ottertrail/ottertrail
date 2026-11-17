import type { GeoSource } from "../config.ts";
import { DataCenters, type IsDataCenter, noDataCenters } from "./data-centers.ts";
import { cloudflareLocation, GeoDatabase, type Locate, noLocation } from "./geo.ts";

/** A geolocation database older than this gives noticeably more wrong answers. */
export const STALE_AFTER_DAYS = 60;

export interface LocationSetup {
  locate: Locate;
  /** False when locations will be missing or stale: log it as a warning. */
  ok: boolean;
  message: string;
}

/** Picks the location source the instance is configured for. Never throws. */
export async function setUpLocation(
  source: GeoSource,
  databasePath: string,
  now: Date = new Date(),
): Promise<LocationSetup> {
  if (source === "none") {
    return { locate: noLocation, ok: true, message: "Location lookup is off (GEO_SOURCE=none)" };
  }
  if (source === "cloudflare") {
    return {
      locate: (request) => cloudflareLocation(request.headers),
      ok: true,
      message: "Locations come from Cloudflare's headers (GEO_SOURCE=cloudflare)",
    };
  }
  let geo: GeoDatabase;
  try {
    geo = await GeoDatabase.open(databasePath);
  } catch {
    return {
      locate: noLocation,
      ok: false,
      message: `No geolocation database at ${databasePath}: events are stored without a location. Run "vp run geo:update" (in the Docker image: "node dist/update-geo.mjs"), then restart.`,
    };
  }
  const built = geo.builtAt.toISOString().slice(0, 10);
  const ageDays = (now.getTime() - geo.builtAt.getTime()) / 86_400_000;
  const stale = ageDays > STALE_AFTER_DAYS;
  return {
    locate: (request) => geo.lookup(request.ip),
    ok: !stale,
    message: stale
      ? `The geolocation database (${geo.type}) was built on ${built}, over ${STALE_AFTER_DAYS} days ago: locations get less accurate. Run "vp run geo:update" (in the Docker image: "node dist/update-geo.mjs"), then restart.`
      : `Locations come from ${geo.type}, built on ${built}`,
  };
}

/** Providers add ranges every week: after this, new servers go unnoticed. */
export const DATA_CENTERS_STALE_AFTER_DAYS = 45;

export interface DataCenterSetup {
  isDataCenter: IsDataCenter;
  /** False when the ranges are missing or stale: log it as a warning. */
  ok: boolean;
  message: string;
}

/** Loads the data-center ranges. Never throws: without them, nothing counts as a data center. */
export async function setUpDataCenters(
  path: string,
  now: Date = new Date(),
): Promise<DataCenterSetup> {
  let ranges: DataCenters;
  try {
    ranges = await DataCenters.open(path);
  } catch {
    return {
      isDataCenter: noDataCenters,
      ok: false,
      message: `No data-center ranges at ${path}: events from cloud servers are not recognized. Run "vp run geo:update" (in the Docker image: "node dist/update-geo.mjs"), then restart.`,
    };
  }
  const oldest = Math.min(...ranges.providers.map((provider) => provider.fetchedAt.getTime()));
  const ageDays = (now.getTime() - oldest) / 86_400_000;
  const stale = ranges.providers.length === 0 || ageDays > DATA_CENTERS_STALE_AFTER_DAYS;
  const since = Number.isFinite(oldest) ? new Date(oldest).toISOString().slice(0, 10) : "never";
  return {
    isDataCenter: (ip) => ranges.has(ip),
    ok: !stale,
    message: stale
      ? `The data-center ranges at ${path} date from ${since}, over ${DATA_CENTERS_STALE_AFTER_DAYS} days ago: newer cloud servers are not recognized. Run "vp run geo:update" (in the Docker image: "node dist/update-geo.mjs"), then restart.`
      : `Data-center ranges from ${ranges.providers.length} providers, downloaded ${since}`,
  };
}
