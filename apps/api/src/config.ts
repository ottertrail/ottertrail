const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

export interface Config {
  host: string;
  port: number;
  logLevel: LogLevel;
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
  };
}
