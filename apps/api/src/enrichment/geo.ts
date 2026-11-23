import { readFile } from "node:fs/promises";

import { type CityResponse, Reader } from "mmdb-lib";

/** Where a visitor is, as precisely as the source knows. Every field may be missing. */
export interface Location {
  /** ISO 3166-1 alpha-2 code, such as "DE". */
  country?: string;
  /** First-level region by English name, such as "Bavaria" or "California". */
  region?: string;
  /** English name. */
  city?: string;
}

/** Finds the location for one request. The IP address is used here and never stored. */
export type Locate = (request: { ip: string; headers: Record<string, unknown> }) => Location;

/**
 * DB-IP City Lite follows the MaxMind GeoIP2/GeoLite2 layout, but regions have
 * English names only, without ISO codes.
 */
export type CityRecord = Pick<CityResponse, "country" | "subdivisions" | "city">;

const COUNTRY_CODE = /^[A-Z]{2}$/;

function cleanName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed.slice(0, 100);
}

function location(country: unknown, region: unknown, city: unknown): Location {
  const result: Location = {};
  if (typeof country === "string" && COUNTRY_CODE.test(country)) result.country = country;
  const regionName = cleanName(region);
  if (regionName !== undefined) result.region = regionName;
  const cityName = cleanName(city);
  if (cityName !== undefined) result.city = cityName;
  return result;
}

export function locationFromRecord(record: CityRecord | null): Location {
  if (record === null) return {};
  return location(
    record.country?.iso_code,
    record.subdivisions?.[0]?.names?.en,
    record.city?.names?.en,
  );
}

/** Loaded once for local lookups. DB-IP City Lite needs about 130 MB of memory. */
export class GeoDatabase {
  readonly #reader: Reader<CityResponse>;

  private constructor(reader: Reader<CityResponse>) {
    this.#reader = reader;
  }

  static async open(path: string): Promise<GeoDatabase> {
    return new GeoDatabase(new Reader<CityResponse>(await readFile(path)));
  }

  /** When the provider built this file. Locations go stale as IP ranges change hands. */
  get builtAt(): Date {
    return this.#reader.metadata.buildEpoch;
  }

  get type(): string {
    return this.#reader.metadata.databaseType;
  }

  /** Private and local addresses (127.0.0.1, 192.168.x.x) have no location. */
  lookup(ip: string): Location {
    try {
      return locationFromRecord(this.#reader.get(ip));
    } catch {
      return {}; // Not a valid IP address.
    }
  }
}

function header(headers: Record<string, unknown>, name: string): string | undefined {
  const value = headers[name];
  if (typeof value !== "string") return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Trust only when every request passes through Cloudflare; clients can forge
 * these headers otherwise. CF-IPCountry is always supplied. Region and city
 * require the "Add visitor location headers" managed transform.
 */
export function cloudflareLocation(headers: Record<string, unknown>): Location {
  const country = header(headers, "cf-ipcountry")?.toUpperCase();
  // "XX" means unknown and "T1" means Tor: neither is a country.
  const known = country === "XX" || country === "T1" ? undefined : country;
  return location(known, header(headers, "cf-region"), header(headers, "cf-ipcity"));
}

export const noLocation: Locate = () => ({});
