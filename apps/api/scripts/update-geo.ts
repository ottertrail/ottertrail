/**
 * Downloads what the API knows about IP addresses, run monthly:
 *
 * 1. The latest DB-IP City Lite database (free, CC BY 4.0, updated
 *    monthly) to GEO_DATABASE_PATH, when GEO_SOURCE is "database". It is
 *    checked: it must open and answer a known lookup.
 * 2. The address ranges of cloud and hosting providers, to
 *    DATA_CENTERS_PATH (src/enrichment/data-center-sources.ts). A source
 *    that fails keeps its previous ranges.
 *
 * Each file replaces the old one in one step; if anything fails, the old
 * file stays. Restart the API afterwards to load the new files.
 *
 *   vp run geo:update
 */
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";

import { loadConfig } from "../src/config.ts";
import { downloadDataCenters, yearMonth } from "../src/enrichment/data-center-sources.ts";
import {
  type DataCenterFile,
  DataCenters,
  isDataCenterFile,
} from "../src/enrichment/data-centers.ts";
import { GeoDatabase } from "../src/enrichment/geo.ts";

const TIMEOUT_MS = 120_000;

async function fetchOk(url: string): Promise<Response> {
  const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) throw new Error(`${response.status} from ${url}`);
  return response;
}

async function updateLocations(destination: string): Promise<boolean> {
  const partial = `${destination}.download`;
  await mkdir(dirname(destination), { recursive: true });

  let downloaded = false;
  // The new file is published on the 1st of each month; early on the 1st it
  // may not exist yet, so fall back to the previous month's.
  for (const offset of [0, 1]) {
    const url = `https://download.db-ip.com/free/dbip-city-lite-${yearMonth(offset, new Date())}.mmdb.gz`;
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
    console.error("No DB-IP City Lite file is available for this month or last month.");
    return false;
  }
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
    console.log(
      'Credit "IP geolocation by DB-IP" (https://db-ip.com) wherever locations are shown: the CC BY 4.0 license requires it.',
    );
    return true;
  } catch (error) {
    await rm(partial, { force: true });
    console.error("The download failed validation. The old database was retained.", error);
    return false;
  }
}

async function updateDataCenters(destination: string): Promise<boolean> {
  await mkdir(dirname(destination), { recursive: true });
  // The last file, if any: a source that fails now keeps its ranges from it.
  let previous: DataCenterFile | undefined;
  try {
    const parsed: unknown = JSON.parse(await readFile(destination, "utf8"));
    if (isDataCenterFile(parsed)) previous = parsed;
  } catch {
    previous = undefined;
  }

  console.log("Downloading the address ranges of cloud and hosting providers");
  const { file, failures } = await downloadDataCenters({
    fetchText: async (url) => (await fetchOk(url)).text(),
    fetchStream: async (url) => {
      const response = await fetchOk(url);
      if (response.body === null) throw new Error(`no body from ${url}`);
      return response.body;
    },
    previous,
  });
  const loaded = DataCenters.from(file);
  for (const provider of loaded.providers) {
    console.log(
      `  ${provider.name}: ${provider.ranges} ranges, ${provider.fetchedAt.toISOString().slice(0, 10)}`,
    );
  }
  for (const failure of failures) console.error(`  Failed: ${failure}`);
  if (loaded.providers.length === 0) {
    console.error("No source could be downloaded. Nothing was saved.");
    return false;
  }

  const partial = `${destination}.download`;
  await writeFile(partial, JSON.stringify(file));
  await rename(partial, destination);
  console.log(
    `Saved ${destination}: ${loaded.providers.length} providers${loaded.skipped > 0 ? `, ${loaded.skipped} malformed ranges left out` : ""}.`,
  );
  return failures.length === 0;
}

const config = loadConfig();
let ok = true;
if (config.geoSource === "database") {
  ok = (await updateLocations(resolve(config.geoDatabasePath))) && ok;
} else {
  console.log(`No location database needed: GEO_SOURCE is "${config.geoSource}".`);
}
ok = (await updateDataCenters(resolve(config.dataCentersPath))) && ok;
console.log("Restart the API to load the new files.");
if (!ok) process.exitCode = 1;
