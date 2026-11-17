import { isIP } from "node:net";

import { canonicalTimeZone } from "./visitors/visitor-ids.ts";

const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

/** The local development database from compose.yaml (no password, 127.0.0.1 only). */
export const LOCAL_DATABASE_URL = "postgres://ottertrail@127.0.0.1:5433/ottertrail";

const GEO_SOURCES = ["database", "cloudflare", "none"] as const;

/**
 * Where visitor locations come from:
 * - database: a local geolocation file (see GEO_DATABASE_PATH).
 * - cloudflare: headers Cloudflare adds. Only when every request passes through Cloudflare.
 * - none: no location lookup.
 */
export type GeoSource = (typeof GEO_SOURCES)[number];

/** Relative to the API's working directory. `vp run geo:update` downloads it. */
export const DEFAULT_GEO_DATABASE_PATH = "data/geo/dbip-city-lite.mmdb";

/** The built browser script, relative to the API's working directory. `vp run -r build` makes it. */
export const DEFAULT_TRACKER_SCRIPT_PATH = "../../packages/tracker/dist/tracker.js";

/** The built dashboard, relative to the API's working directory. `vp run -r build` makes it. */
export const DEFAULT_DASHBOARD_PATH = "../web/dist";

/** Where the dashboard runs during local development (`vp run dev`). */
export const DEVELOPMENT_PUBLIC_URL = "http://localhost:5173";

/**
 * Signs dashboard session cookies during local development only. Production
 * refuses to start without AUTH_SECRET, so this value can never protect a
 * real instance.
 */
export const DEVELOPMENT_AUTH_SECRET = "ottertrail-local-development-only-not-a-secret";

/** Shortest AUTH_SECRET accepted: 32 characters, such as `openssl rand -base64 32` prints. */
const MIN_AUTH_SECRET_LENGTH = 32;

export interface Config {
  host: string;
  port: number;
  logLevel: LogLevel;
  databaseUrl: string;
  /**
   * Which proxies may report the client's IP address in X-Forwarded-For:
   * false (none), a number of proxy hops, or a list of proxy IPs or CIDRs.
   */
  trustProxy: false | number | string[];
  geoSource: GeoSource;
  geoDatabasePath: string;
  /**
   * IANA timezone of the instance, such as "Asia/Singapore". Visitor salts
   * change at midnight here, and reports will count days here.
   */
  timeZone: string;
  /** The instance's address, such as "https://analytics.example.com": an origin, no path. */
  publicUrl: string;
  /**
   * Origins the dashboard's sign-in accepts requests from: the public URL, and
   * in development any localhost port, since the dev server picks a free one.
   */
  trustedOrigins: string[];
  /** Signs dashboard session cookies. */
  authSecret: string;
  /** The built tracker that sites load from this instance (served at /t.js). */
  trackerScriptPath: string;
  /** The built dashboard's directory, served at the instance's root. */
  dashboardPath: string;
}

export class ConfigError extends Error {
  override name = "ConfigError";
}

function parsePort(raw: string): number {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new ConfigError(`PORT must be an integer between 1 and 65535, received "${raw}"`);
  }
  return port;
}

function parseLogLevel(raw: string): LogLevel {
  const level = LOG_LEVELS.find((candidate) => candidate === raw);
  if (level === undefined) {
    throw new ConfigError(`LOG_LEVEL must be one of ${LOG_LEVELS.join(", ")}, received "${raw}"`);
  }
  return level;
}

function parseDatabaseUrl(env: NodeJS.ProcessEnv): string {
  const raw = env.DATABASE_URL;
  if (raw === undefined || raw === "") {
    if (env.NODE_ENV === "production") {
      throw new ConfigError("DATABASE_URL is required in production");
    }
    return LOCAL_DATABASE_URL;
  }
  // Error messages never repeat the value: it may contain a password.
  let protocol: string;
  try {
    protocol = new URL(raw).protocol;
  } catch {
    throw new ConfigError("DATABASE_URL is not a valid URL");
  }
  if (protocol !== "postgres:" && protocol !== "postgresql:") {
    throw new ConfigError("DATABASE_URL must start with postgres:// or postgresql://");
  }
  return raw;
}

function parseTrustProxy(raw: string | undefined): false | number | string[] {
  if (raw === undefined || raw.trim() === "" || raw.trim() === "false") {
    return false;
  }
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) {
    const hops = Number(trimmed);
    if (hops < 1 || hops > 10) {
      throw new ConfigError(`TRUST_PROXY hops must be between 1 and 10, received "${raw}"`);
    }
    return hops;
  }
  const entries = trimmed.split(",").map((entry) => entry.trim());
  for (const entry of entries) {
    const [address = "", prefix, extra] = entry.split("/");
    const version = isIP(address);
    const validPrefix =
      prefix === undefined ||
      (/^\d+$/.test(prefix) && Number(prefix) <= (version === 6 ? 128 : 32));
    if (version === 0 || !validPrefix || extra !== undefined) {
      throw new ConfigError(
        `TRUST_PROXY must be false, a number of hops, or a comma-separated list of IPs or CIDRs; "${entry}" is not valid`,
      );
    }
  }
  return entries;
}

function parseGeoSource(raw: string): GeoSource {
  const source = GEO_SOURCES.find((candidate) => candidate === raw.trim());
  if (source === undefined) {
    throw new ConfigError(`GEO_SOURCE must be one of ${GEO_SOURCES.join(", ")}, received "${raw}"`);
  }
  return source;
}

function parseTimeZone(raw: string): string {
  const timeZone = canonicalTimeZone(raw);
  if (timeZone === undefined) {
    throw new ConfigError(
      `TIMEZONE must be an IANA timezone name such as "Europe/Berlin", not a fixed offset such as "+08:00", received "${raw}"`,
    );
  }
  return timeZone;
}

function parsePublicUrl(env: NodeJS.ProcessEnv): string {
  const raw = env.PUBLIC_URL?.trim();
  if (raw === undefined || raw === "") {
    if (env.NODE_ENV === "production") {
      throw new ConfigError(
        "PUBLIC_URL is required in production, such as https://analytics.example.com",
      );
    }
    return DEVELOPMENT_PUBLIC_URL;
  }
  const url = URL.parse(raw);
  if (url === null || (url.protocol !== "https:" && url.protocol !== "http:")) {
    throw new ConfigError(`PUBLIC_URL must be an http(s) URL, received "${raw}"`);
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "" || url.username !== "") {
    throw new ConfigError(
      `PUBLIC_URL must be an origin without a path, such as https://analytics.example.com, received "${raw}"`,
    );
  }
  // Session cookies are marked Secure, which browsers only keep over HTTPS.
  if (env.NODE_ENV === "production" && url.protocol !== "https:") {
    throw new ConfigError(`PUBLIC_URL must use https in production, received "${raw}"`);
  }
  return url.origin;
}

function parseAuthSecret(env: NodeJS.ProcessEnv): string {
  const raw = env.AUTH_SECRET;
  if (raw === undefined || raw === "") {
    if (env.NODE_ENV === "production") {
      throw new ConfigError(
        "AUTH_SECRET is required in production; generate one with `openssl rand -base64 32`",
      );
    }
    return DEVELOPMENT_AUTH_SECRET;
  }
  // Error messages never repeat the value.
  if (raw.length < MIN_AUTH_SECRET_LENGTH) {
    throw new ConfigError(`AUTH_SECRET must be at least ${MIN_AUTH_SECRET_LENGTH} characters long`);
  }
  return raw;
}

/**
 * Reads instance configuration from environment variables.
 * Every instance is configured independently; there are no shared defaults
 * beyond local development values.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    host: env.HOST ?? "127.0.0.1",
    port: parsePort(env.PORT ?? "3000"),
    logLevel: parseLogLevel(env.LOG_LEVEL ?? "info"),
    databaseUrl: parseDatabaseUrl(env),
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    geoSource: parseGeoSource(env.GEO_SOURCE ?? "database"),
    geoDatabasePath: env.GEO_DATABASE_PATH?.trim() || DEFAULT_GEO_DATABASE_PATH,
    timeZone: parseTimeZone(env.TIMEZONE?.trim() || "UTC"),
    ...publicUrlAndOrigins(env),
    authSecret: parseAuthSecret(env),
    trackerScriptPath: env.TRACKER_SCRIPT_PATH?.trim() || DEFAULT_TRACKER_SCRIPT_PATH,
    dashboardPath: env.DASHBOARD_PATH?.trim() || DEFAULT_DASHBOARD_PATH,
  };
}

function publicUrlAndOrigins(env: NodeJS.ProcessEnv): Pick<Config, "publicUrl" | "trustedOrigins"> {
  const publicUrl = parsePublicUrl(env);
  const development = env.NODE_ENV !== "production";
  return {
    publicUrl,
    trustedOrigins: development
      ? [...new Set([publicUrl, "http://localhost:*", "http://127.0.0.1:*"])]
      : [publicUrl],
  };
}
