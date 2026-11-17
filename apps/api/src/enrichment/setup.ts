import type { GeoSource } from "../config.ts";
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
