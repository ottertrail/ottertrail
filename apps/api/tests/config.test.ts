import { describe, expect, test } from "vite-plus/test";

import { ConfigError, LOCAL_DATABASE_URL, loadConfig } from "../src/config.ts";

describe("loadConfig", () => {
  test("uses local development defaults when variables are unset", () => {
    expect(loadConfig({})).toEqual({
      host: "127.0.0.1",
      port: 3000,
      logLevel: "info",
      databaseUrl: LOCAL_DATABASE_URL,
    });
  });

  test("reads values from the environment", () => {
    expect(
      loadConfig({
        HOST: "0.0.0.0",
        PORT: "8080",
        LOG_LEVEL: "debug",
        DATABASE_URL: "postgresql://app@db.internal:5432/ottertrail",
      }),
    ).toEqual({
      host: "0.0.0.0",
      port: 8080,
      logLevel: "debug",
      databaseUrl: "postgresql://app@db.internal:5432/ottertrail",
    });
  });

  test.each(["0", "65536", "3000.5", "abc", ""])("rejects invalid PORT %j", (port) => {
    expect(() => loadConfig({ PORT: port })).toThrow(ConfigError);
  });

  test("rejects an unknown LOG_LEVEL", () => {
    expect(() => loadConfig({ LOG_LEVEL: "verbose" })).toThrow(ConfigError);
  });

  test("requires DATABASE_URL in production instead of using the local database", () => {
    expect(() => loadConfig({ NODE_ENV: "production" })).toThrow(/DATABASE_URL is required/);
  });

  test.each(["not a url", "mysql://app@db/ottertrail"])("rejects DATABASE_URL %j", (url) => {
    expect(() => loadConfig({ DATABASE_URL: url })).toThrow(ConfigError);
  });

  test("never repeats DATABASE_URL in errors, because it may contain a password", () => {
    const url = "mysql://app:s3cret-value@db/ottertrail";
    expect(() => loadConfig({ DATABASE_URL: url })).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining("s3cret-value") }),
    );
  });
});
