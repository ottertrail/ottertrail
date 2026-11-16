import { isIP } from "node:net";

const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

/** The local development database from compose.yaml (no password, 127.0.0.1 only). */
export const LOCAL_DATABASE_URL = "postgres://ottertrail@127.0.0.1:5433/ottertrail";

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
  };
}
