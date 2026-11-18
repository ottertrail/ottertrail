import { isIP } from "node:net";

import { z } from "zod";

import { parseAddressRange } from "./outbound/addresses.ts";

const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

/** The local development database from compose.yaml (no password, 127.0.0.1 only). */
export const LOCAL_DATABASE_URL = "postgres://ottertrail@127.0.0.1:5433/ottertrail";

/** The local development ClickHouse from compose.yaml (127.0.0.1 only). */
export const LOCAL_CLICKHOUSE = {
  url: "http://127.0.0.1:8123",
  username: "ottertrail",
  password: "development",
  database: "ottertrail",
} as const;

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

/** Cloud and hosting providers' address ranges; `vp run geo:update` downloads them too. */
export const DEFAULT_DATA_CENTERS_PATH = "data/geo/data-centers.json";

/** The built browser script, relative to the API's working directory. `vp run -r build` makes it. */
export const DEFAULT_TRACKER_SCRIPT_PATH = "../../packages/tracker/dist/tracker.js";

/** The built dashboard, relative to the API's working directory. `vp run -r build` makes it. */
export const DEFAULT_DASHBOARD_PATH = "../web/dist";

/** The built session replay player, relative to the API's working directory. `vp run -r build` makes it. */
export const DEFAULT_REPLAY_PLAYER_PATH = "../../packages/replay-player/dist/player.js";

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
  /** ClickHouse, which holds analytics events (docs/storage-benchmark.md). */
  clickhouse: ClickHouseConfig;
  /**
   * Which proxies may report the client's IP address in X-Forwarded-For:
   * false (none), a number of proxy hops, or a list of proxy IPs or CIDRs.
   */
  trustProxy: false | number | string[];
  geoSource: GeoSource;
  geoDatabasePath: string;
  /** Address ranges of data centers, whose "browsers" are ignored (enrichment/data-centers.ts). */
  dataCentersPath: string;
  /**
   * Events the instance may store per second, all its projects together,
   * with bursts of ten seconds' worth (collection/rate-limiter.ts,
   * EventBudget), inside which each project has its own budget. It bounds
   * what the instance takes in, however many projects it has.
   */
  instanceEventsPerSecond: number;
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
  /** The built session replay player (served at /replay-player.js). */
  replayPlayerPath: string;
  /**
   * The S3-compatible object store that holds source maps (docs/errors.md,
   * "Source maps"); null when the install has none, and source maps are off.
   */
  objectStore: ObjectStoreConfig | null;
  /** Bytes of source maps, compressed, the instance may store, all its projects together. */
  sourceMapStorageBytes: number;
  /** Bytes of session replays, compressed, the instance may keep (docs/session-replay.md). */
  replayStorageBytes: number;
  /**
   * Days ClickHouse keeps traces, logs, and metrics (docs/telemetry.md):
   * older records are refused, and ClickHouse drops whole days past it.
   */
  telemetryRetentionDays: number;
  /**
   * Whether uptime checks may reach loopback, private, unique-local, and
   * shared (CGNAT) addresses (uptime/addresses.ts): off unless a
   * self-hosted install must check its own private network.
   */
  uptimeAllowPrivateAddresses: boolean;
  /**
   * Addresses and CIDR ranges uptime checks may never reach, whatever
   * else is allowed: the server's own public address, whose ports a cloud
   * firewall closes only to the outside.
   */
  uptimeDenyAddresses: string[];
  /**
   * Where alert email goes out (notifications/email.ts): the SMTP server
   * and the sender. Null when SMTP_URL is unset: email channels can be
   * made, and their deliveries fail saying email is not set up.
   */
  email: EmailConfig | null;
}

export interface EmailConfig {
  /** smtp:// or smtps://, with the user and password in it. Never logged. */
  smtpUrl: string;
  /** The sender: an address, or a name and an address ("Ottertrail <alerts@example.com>"). */
  from: string;
}

export interface ObjectStoreConfig {
  /** Its S3 endpoint, such as "http://garage:3900" or "https://<account>.r2.cloudflarestorage.com". */
  url: string;
  /** The region requests are signed for: "garage" for Garage, "auto" for R2. */
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/** The local development Garage from compose.yaml (127.0.0.1 only). */
export const LOCAL_OBJECT_STORE: ObjectStoreConfig = {
  url: "http://127.0.0.1:3900",
  region: "garage",
  bucket: "ottertrail",
  accessKeyId: "GK0000000000000000000000de",
  secretAccessKey: "0000000000000000000000000000000000000000000000000000000000000de0",
};

export interface ClickHouseConfig {
  /** Its HTTP interface, such as "http://clickhouse:8123". */
  url: string;
  username: string;
  password: string;
  database: string;
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

/** The default: three projects at their full 200 events a second. */
export const DEFAULT_INSTANCE_EVENTS_PER_SECOND = 600;

function parseInstanceEventsPerSecond(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_INSTANCE_EVENTS_PER_SECOND;
  const rate = Number(raw);
  // At least one full batch of 50 events, as bursts are ten seconds' worth.
  if (!Number.isInteger(rate) || rate < 5 || rate > 1_000_000) {
    throw new ConfigError(
      `INSTANCE_EVENTS_PER_SECOND must be an integer between 5 and 1000000, received "${raw}"`,
    );
  }
  return rate;
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

function parseClickHouse(env: NodeJS.ProcessEnv): ClickHouseConfig {
  const production = env.NODE_ENV === "production";
  const raw = env.CLICKHOUSE_URL?.trim();
  if ((raw === undefined || raw === "") && production) {
    throw new ConfigError(
      "CLICKHOUSE_URL is required in production, such as http://clickhouse:8123",
    );
  }
  const url = raw === undefined || raw === "" ? LOCAL_CLICKHOUSE.url : raw;
  const parsed = URL.parse(url);
  if (parsed === null || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
    throw new ConfigError("CLICKHOUSE_URL must be an http(s) URL");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    // Error messages never repeat the URL: it would show the password.
    throw new ConfigError(
      "CLICKHOUSE_URL must not hold a user or password; use CLICKHOUSE_USER and CLICKHOUSE_PASSWORD",
    );
  }
  const password = env.CLICKHOUSE_PASSWORD;
  if ((password === undefined || password === "") && production) {
    throw new ConfigError("CLICKHOUSE_PASSWORD is required in production");
  }
  const database = env.CLICKHOUSE_DATABASE?.trim() || LOCAL_CLICKHOUSE.database;
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(database)) {
    throw new ConfigError(
      `CLICKHOUSE_DATABASE must be letters, digits, and underscores, received "${database}"`,
    );
  }
  return {
    url: parsed.origin,
    username: env.CLICKHOUSE_USER?.trim() || LOCAL_CLICKHOUSE.username,
    password: password === undefined || password === "" ? LOCAL_CLICKHOUSE.password : password,
    database,
  };
}

/**
 * The object store: in development, the local Garage unless OBJECT_STORE_URL
 * says otherwise ("off" for none); in production, none unless
 * OBJECT_STORE_URL is set, and then its keys are required.
 */
function parseObjectStore(env: NodeJS.ProcessEnv): ObjectStoreConfig | null {
  const production = env.NODE_ENV === "production";
  const raw = env.OBJECT_STORE_URL?.trim() ?? "";
  if (raw === "off" || (raw === "" && production)) return null;
  if (raw === "") return LOCAL_OBJECT_STORE;
  const parsed = URL.parse(raw);
  if (parsed === null || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
    throw new ConfigError("OBJECT_STORE_URL must be an http(s) URL, or off");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    // Error messages never repeat the URL: it would show the secret.
    throw new ConfigError(
      "OBJECT_STORE_URL must not hold keys; use OBJECT_STORE_ACCESS_KEY_ID and OBJECT_STORE_SECRET_ACCESS_KEY",
    );
  }
  const accessKeyId = env.OBJECT_STORE_ACCESS_KEY_ID?.trim() ?? "";
  const secretAccessKey = env.OBJECT_STORE_SECRET_ACCESS_KEY ?? "";
  if (accessKeyId === "" || secretAccessKey === "") {
    throw new ConfigError(
      "OBJECT_STORE_ACCESS_KEY_ID and OBJECT_STORE_SECRET_ACCESS_KEY are required with OBJECT_STORE_URL",
    );
  }
  const bucket = env.OBJECT_STORE_BUCKET?.trim() || LOCAL_OBJECT_STORE.bucket;
  // S3's bucket names: 3 to 63 lowercase letters, digits, dots, and hyphens.
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) {
    throw new ConfigError(`OBJECT_STORE_BUCKET is not a valid bucket name, received "${bucket}"`);
  }
  return {
    url: parsed.origin,
    region: env.OBJECT_STORE_REGION?.trim() || LOCAL_OBJECT_STORE.region,
    bucket,
    accessKeyId,
    secretAccessKey,
  };
}

/** The default: 1 GiB of compressed source maps. */
export const DEFAULT_SOURCE_MAP_STORAGE_BYTES = 1024 ** 3;

/** The default: 2 GiB of compressed replays, until measured on real sites. */
export const DEFAULT_REPLAY_STORAGE_BYTES = 2 * 1024 ** 3;

/** A number of bytes from 1 MiB to 1 TiB, named `name`; `fallback` when unset. */
function parseBytes(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const bytes = Number(raw);
  if (!Number.isSafeInteger(bytes) || bytes < 1024 ** 2 || bytes > 1024 ** 4) {
    throw new ConfigError(
      `${name} must be a number of bytes from 1 MiB to 1 TiB, received "${raw}"`,
    );
  }
  return bytes;
}

/** The default: 30 days of traces, logs, and metrics, as long as session replays. */
export const DEFAULT_TELEMETRY_RETENTION_DAYS = 30;

function parseTelemetryRetentionDays(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_TELEMETRY_RETENTION_DAYS;
  const days = Number(raw);
  if (!Number.isInteger(days) || days < 1 || days > 365) {
    throw new ConfigError(
      `TELEMETRY_RETENTION_DAYS must be a whole number of days from 1 to 365, received "${raw}"`,
    );
  }
  return days;
}

function parseBoolean(name: string, raw: string | undefined): boolean {
  const value = raw?.trim().toLowerCase() ?? "";
  if (value === "" || value === "false" || value === "0") return false;
  if (value === "true" || value === "1") return true;
  throw new ConfigError(`${name} must be true or false, received "${raw}"`);
}

function parseDenyAddresses(raw: string | undefined): string[] {
  const entries = (raw ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  for (const entry of entries) {
    if (parseAddressRange(entry) === null) {
      throw new ConfigError(
        `UPTIME_DENY_ADDRESSES must be a comma-separated list of IP addresses and CIDR ranges; "${entry}" is not valid`,
      );
    }
  }
  return entries;
}

const emailAddress = z.email();

/** An address, or a name and an address in angle brackets, as EMAIL_FROM takes it; null when it is neither. */
export function parseSender(raw: string): string | null {
  const text = raw.trim();
  // eslint-disable-next-line no-control-regex -- control characters are what it refuses
  if (text === "" || text.length > 320 || /[\u0000-\u001F\u007F]/u.test(text)) return null;
  const named = /^([^<>"]*?)\s*<([^<>\s]+)>$/.exec(text);
  const address = named === null ? text : (named[2] ?? "");
  return emailAddress.safeParse(address).success ? text : null;
}

function parseEmail(env: NodeJS.ProcessEnv): EmailConfig | null {
  const raw = env.SMTP_URL?.trim() ?? "";
  if (raw === "") return null;
  // Error messages never repeat the URL: it holds the password.
  // Nodemailer would read options from a query string over the ones the
  // code sets (requireTLS, logging, certificate checks): none is taken.
  if (raw.includes("?") || raw.includes("#")) {
    throw new ConfigError(
      "SMTP_URL must not have a query string or fragment; percent-encode ? and # in the user name or password",
    );
  }
  const url = URL.parse(raw);
  if (url === null || (url.protocol !== "smtp:" && url.protocol !== "smtps:")) {
    throw new ConfigError("SMTP_URL must be an smtp:// or smtps:// URL");
  }
  if (url.hostname === "") {
    throw new ConfigError("SMTP_URL has no host");
  }
  if (url.port !== "" && Number(url.port) < 1) {
    throw new ConfigError("SMTP_URL has an invalid port");
  }
  if ((url.username === "") !== (url.password === "")) {
    throw new ConfigError("SMTP_URL must hold both a user name and a password, or neither");
  }
  if (url.pathname !== "" && url.pathname !== "/") {
    throw new ConfigError("SMTP_URL must not have a path");
  }

  const from = parseSender(env.EMAIL_FROM ?? "");
  if (from === null) {
    throw new ConfigError(
      'EMAIL_FROM is required with SMTP_URL: an address, or a name and an address such as "Ottertrail <alerts@example.com>"',
    );
  }
  return { smtpUrl: raw, from };
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
    clickhouse: parseClickHouse(env),
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    geoSource: parseGeoSource(env.GEO_SOURCE ?? "database"),
    geoDatabasePath: env.GEO_DATABASE_PATH?.trim() || DEFAULT_GEO_DATABASE_PATH,
    dataCentersPath: env.DATA_CENTERS_PATH?.trim() || DEFAULT_DATA_CENTERS_PATH,
    instanceEventsPerSecond: parseInstanceEventsPerSecond(env.INSTANCE_EVENTS_PER_SECOND),
    ...publicUrlAndOrigins(env),
    authSecret: parseAuthSecret(env),
    trackerScriptPath: env.TRACKER_SCRIPT_PATH?.trim() || DEFAULT_TRACKER_SCRIPT_PATH,
    dashboardPath: env.DASHBOARD_PATH?.trim() || DEFAULT_DASHBOARD_PATH,
    replayPlayerPath: env.REPLAY_PLAYER_PATH?.trim() || DEFAULT_REPLAY_PLAYER_PATH,
    objectStore: parseObjectStore(env),
    sourceMapStorageBytes: parseBytes(
      "SOURCE_MAP_STORAGE_BYTES",
      env.SOURCE_MAP_STORAGE_BYTES,
      DEFAULT_SOURCE_MAP_STORAGE_BYTES,
    ),
    replayStorageBytes: parseBytes(
      "REPLAY_STORAGE_BYTES",
      env.REPLAY_STORAGE_BYTES,
      DEFAULT_REPLAY_STORAGE_BYTES,
    ),
    telemetryRetentionDays: parseTelemetryRetentionDays(env.TELEMETRY_RETENTION_DAYS),
    uptimeAllowPrivateAddresses: parseBoolean(
      "UPTIME_ALLOW_PRIVATE_ADDRESSES",
      env.UPTIME_ALLOW_PRIVATE_ADDRESSES,
    ),
    uptimeDenyAddresses: parseDenyAddresses(env.UPTIME_DENY_ADDRESSES),
    email: parseEmail(env),
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
