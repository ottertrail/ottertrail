import type { IncomingHttpHeaders } from "node:http";
import { isIP } from "node:net";

import type { LocationSource } from "../db/schema.ts";
import type { Location } from "../enrichment/geo.ts";
import { hasHiddenCharacters, truncate } from "./normalize.ts";

/**
 * Locations from request headers (docs/web-analytics.md, "Locations"): a
 * project whose location source is "headers" reads the visitor's country,
 * region, and city from headers its proxy or CDN sets, such as a Cloudflare
 * request header rule with `ip.src.country`.
 *
 * Anyone can send any header, so they are read only when Caddy says the
 * connection came from one of OTTERTRAIL_TRUSTED_PROXIES: deploy/compose.yaml's
 * Caddyfile always sets TRUSTED_PROXY_HEADER from its own `trusted_proxy`
 * variable, replacing whatever the client sent. Without that header saying
 * "true", nothing is read; and nothing at all when the API is not behind a
 * proxy (TRUST_PROXY unset), since a client could then send the header itself.
 * Without Caddy, the proxy in front of the API must set the header itself,
 * replacing any a client sent (docs/web-analytics.md, "Locations").
 */
export const TRUSTED_PROXY_HEADER = "x-ottertrail-trusted-proxy";

export const MAX_HEADER_NAME_LENGTH = 64;

/** As the database path keeps them (enrichment/geo.ts). */
const MAX_NAME_LENGTH = 100;

export interface LocationHeaders {
  /** Required: without it, "headers" cannot be chosen. */
  country: string;
  region: string | null;
  city: string | null;
}

/** A project's location settings, as collection uses them. */
export type ProjectLocation =
  | { source: "database" }
  | { source: "off" }
  | { source: "headers"; headers: LocationHeaders };

export function projectLocationOf(row: {
  location_source: LocationSource;
  location_country_header: string | null;
  location_region_header: string | null;
  location_city_header: string | null;
}): ProjectLocation {
  if (row.location_source !== "headers") return { source: row.location_source };
  // The table's check makes the country header present in this mode.
  if (row.location_country_header === null) return { source: "off" };
  return {
    source: "headers",
    headers: {
      country: row.location_country_header,
      region: row.location_region_header,
      city: row.location_city_header,
    },
  };
}

/**
 * Refused as location headers:
 * - those Ottertrail sets or reads itself;
 * - those that carry the visitor's address, which must never be stored;
 * - hop-by-hop headers, which proxies drop;
 * - those Node keeps only the first of when repeated.
 */
const RESERVED = new Set([
  TRUSTED_PROXY_HEADER,
  "x-forwarded-for",
  "forwarded",
  "x-real-ip",
  "x-client-ip",
  "cf-connecting-ip",
  "true-client-ip",
  "fastly-client-ip",
  "x-forwarded-host",
  "x-forwarded-proto",
  "host",
  "origin",
  "referer",
  "user-agent",
  "cookie",
  "authorization",
  "content-type",
  "content-length",
  "content-encoding",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "location",
  "from",
  "server",
  "etag",
  "age",
  "expires",
  "retry-after",
  "max-forwards",
  "if-modified-since",
  "if-unmodified-since",
  "last-modified",
]);

const HEADER_NAME = new RegExp(`^[a-z0-9-]{1,${MAX_HEADER_NAME_LENGTH}}$`);

/** A header name the owner entered, in lower case, or why it is refused. */
export function parseLocationHeaderName(
  raw: string,
): { ok: true; name: string } | { ok: false; message: string } {
  const name = raw.trim().toLowerCase();
  const shown = raw.trim().slice(0, MAX_HEADER_NAME_LENGTH + 1);
  if (!HEADER_NAME.test(name)) {
    return {
      ok: false,
      message: `"${shown}" is not a header name. Use letters, digits, and hyphens, at most ${MAX_HEADER_NAME_LENGTH} characters, such as x-visitor-country.`,
    };
  }
  if (RESERVED.has(name)) {
    return {
      ok: false,
      message: `"${shown}" is a header Ottertrail or the connection uses. Pick a name of your own, such as x-visitor-country.`,
    };
  }
  return { ok: true, name };
}

/** C0 and C1 control characters, and DEL. */
// oxlint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * A header value as text. Node reads header bytes as Latin-1, so UTF-8 text
 * sent raw arrives as one character per byte: it is decoded as UTF-8 when it
 * is valid UTF-8, and kept as Latin-1 otherwise. Percent-encoded UTF-8
 * (Z%C3%BCrich) is decoded too.
 */
export function decodeHeaderValue(raw: string): string | undefined {
  let value = raw;
  const codes = Array.from(value, (char) => char.codePointAt(0) ?? 0);
  // Beyond Latin-1, the value did not come from bytes on the wire: keep it.
  if (codes.some((code) => code >= 0x80) && codes.every((code) => code <= 0xff)) {
    try {
      value = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(value, "latin1"));
    } catch {
      // Not UTF-8: Latin-1, as read.
    }
  }
  if (/%[0-9a-fA-F]{2}/.test(value)) {
    try {
      value = decodeURIComponent(value);
    } catch {
      return undefined;
    }
  }
  return value;
}

function nameFrom(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const decoded = decodeHeaderValue(raw);
  if (decoded === undefined || CONTROL.test(decoded) || hasHiddenCharacters(decoded)) {
    return undefined;
  }
  // Unpaired surrogates cannot be stored (collection/normalize.ts, isStorableText).
  if (!decoded.isWellFormed()) return undefined;
  // Cut without splitting a character, then trim what the cut left at the end.
  const value = truncate(decoded.trim(), MAX_NAME_LENGTH).trim();
  // An address is never stored, even when a proxy puts one in a location header.
  if (value === "" || isIP(value) !== 0) return undefined;
  return value;
}

/**
 * Codes ICU names that ISO 3166-1 has not assigned: reserved, withdrawn, and
 * user-assigned ones (EU, UN, UK, ZZ, ...). Kosovo's XK stays: the location
 * database uses it too.
 */
const NOT_ASSIGNED = new Set(
  "AC AN BU CP CQ CS DD DG DY EA EU EZ FX HV IC NH QO RH SU TA TP UK UN VD XA XB YD YU ZR ZZ".split(
    " ",
  ),
);

const regionNames = new Intl.DisplayNames(["en"], { type: "region", fallback: "none" });

/** The assigned ISO 3166-1 alpha-2 codes, and XK. */
const COUNTRY_CODES: ReadonlySet<string> = new Set(
  Array.from({ length: 26 * 26 }, (_, index) =>
    String.fromCodePoint(65 + Math.floor(index / 26), 65 + (index % 26)),
  ).filter((code) => regionNames.of(code) !== undefined && !NOT_ASSIGNED.has(code)),
);

function countryFrom(raw: string | undefined): string | undefined {
  const text = raw?.trim();
  // The shape before upper case, which would turn "ß" into "SS".
  if (text === undefined || !/^[A-Za-z]{2}$/.test(text)) return undefined;
  const code = text.toUpperCase();
  // Cloudflare's XX (unknown) and T1 (Tor) are not countries.
  return COUNTRY_CODES.has(code) ? code : undefined;
}

/** A header's value; Node joins a repeated one with ", ", which then fails the checks or reads as text. */
function single(headers: IncomingHttpHeaders, name: string | null): string | undefined {
  if (name === null) return undefined;
  const value = headers[name];
  return typeof value === "string" ? value : undefined;
}

/** Whether Caddy said the connection came from a trusted proxy. */
export function fromTrustedProxy(headers: IncomingHttpHeaders): boolean {
  return headers[TRUSTED_PROXY_HEADER] === "true";
}

/**
 * The location the project's headers give, or nothing when the request did
 * not come through a trusted proxy. A missing or invalid header leaves its
 * field empty; there is no fallback to the database.
 */
export function locationFromHeaders(
  headers: IncomingHttpHeaders,
  names: LocationHeaders,
): Location {
  if (!fromTrustedProxy(headers)) return {};
  const result: Location = {};
  const country = countryFrom(single(headers, names.country));
  if (country !== undefined) result.country = country;
  const region = nameFrom(single(headers, names.region));
  if (region !== undefined) result.region = region;
  const city = nameFrom(single(headers, names.city));
  if (city !== undefined) result.city = city;
  return result;
}
