/**
 * Downloads the latest DB-IP City Lite database (free, CC BY 4.0, updated
 * monthly) to GEO_DATABASE_PATH, checks that it opens and answers a known
 * lookup, then replaces the old file in one step. If anything fails, the
 * old file stays. Restart the API afterwards to load the new file.
 *
 *   vp run geo:update
 */
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";

import { loadConfig } from "../src/config.ts";
import { GeoDatabase } from "../src/enrichment/geo.ts";

/** "2026-11" for offset 0, the previous month for offset 1. */
function yearMonth(offset: number, now = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - offset, 1))
    .toISOString()
    .slice(0, 7);
}

const destination = resolve(loadConfig().geoDatabasePath);
const partial = `${destination}.download`;
await mkdir(dirname(destination), { recursive: true });

let downloaded = false;
// The new file is published on the 1st of each month; early on the 1st it
// may not exist yet, so fall back to the previous month's.
for (const offset of [0, 1]) {
  const url = `https://download.db-ip.com/free/dbip-city-lite-${yearMonth(offset)}.mmdb.gz`;
  const response = await fetch(url);
  if (!response.ok || response.body === null) {
    console.log(`Not available (${response.status}): ${url}`);
    continue;
  }
  console.log(`Downloading ${url}`);
  await pipeline(Readable.fromWeb(response.body), createGunzip(), createWriteStream(partial));
  downloaded = true;
  break;
}

if (!downloaded) {
  console.error("No DB-IP City Lite file was found for this month or last month.");
  process.exitCode = 1;
} else {
  try {
    const geo = await GeoDatabase.open(partial);
    const check = geo.lookup("8.8.8.8");
    if (!geo.type.includes("City") || check.country !== "US") {
      throw new Error(`unexpected database ${geo.type}: 8.8.8.8 gave ${JSON.stringify(check)}`);
    }
    await rename(partial, destination);
    const { size } = await stat(destination);
    console.log(
      `Saved ${destination}: ${geo.type}, built ${geo.builtAt.toISOString().slice(0, 10)}, ${Math.round(size / 1_000_000)} MB.`,
    );
    console.log("Restart the API to load it.");
    console.log(
      'Credit "IP geolocation by DB-IP" (https://db-ip.com) wherever locations are shown: the CC BY 4.0 license requires it.',
    );
  } catch (error) {
    await rm(partial, { force: true });
    console.error("The download failed its check, so the old database was kept.", error);
    process.exitCode = 1;
  }
}
