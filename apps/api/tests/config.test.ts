import { describe, expect, test } from "vite-plus/test";

import {
  ConfigError,
  DEFAULT_GEO_DATABASE_PATH,
  LOCAL_DATABASE_URL,
  loadConfig,
} from "../src/config.ts";

describe("loadConfig", () => {
  test("uses local development defaults when variables are unset", () => {
    expect(loadConfig({})).toEqual({
      host: "127.0.0.1",
      port: 3000,
      logLevel: "info",
      databaseUrl: LOCAL_DATABASE_URL,
      trustProxy: false,
      geoSource: "database",
      geoDatabasePath: DEFAULT_GEO_DATABASE_PATH,
      timeZone: "UTC",
    });
  });

  test("reads values from the environment", () => {
    expect(
      loadConfig({
        HOST: "0.0.0.0",
        PORT: "8080",
        LOG_LEVEL: "debug",
        DATABASE_URL: "postgresql://app@db.internal:5432/ottertrail",
        TRUST_PROXY: "1",
        GEO_SOURCE: "cloudflare",
        GEO_DATABASE_PATH: "/var/lib/ottertrail/geo.mmdb",
        TIMEZONE: "Asia/Singapore",
      }),
    ).toEqual({
      host: "0.0.0.0",
      port: 8080,
      logLevel: "debug",
      databaseUrl: "postgresql://app@db.internal:5432/ottertrail",
      trustProxy: 1,
      geoSource: "cloudflare",
      geoDatabasePath: "/var/lib/ottertrail/geo.mmdb",
      timeZone: "Asia/Singapore",
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

  test("reads TRUST_PROXY as a list of proxy addresses", () => {
    expect(loadConfig({ TRUST_PROXY: "10.0.0.0/8, 172.16.0.1, ::1" }).trustProxy).toEqual([
      "10.0.0.0/8",
      "172.16.0.1",
      "::1",
    ]);
  });

  test.each(["0", "11", "proxy.internal", "10.0.0.0/33", "10.0.0.1/8/1"])(
    "rejects TRUST_PROXY %j",
    (value) => {
      expect(() => loadConfig({ TRUST_PROXY: value })).toThrow(ConfigError);
    },
  );

  test("stores the official name for a timezone alias", () => {
    expect(loadConfig({ TIMEZONE: "singapore" }).timeZone).toBe("Asia/Singapore");
  });

  test.each(["Mars/Olympus_Mons", "GMT+25", "singapore time", "+08:00"])(
    "rejects TIMEZONE %j",
    (timeZone) => {
      expect(() => loadConfig({ TIMEZONE: timeZone })).toThrow(ConfigError);
    },
  );

  test("rejects an unknown GEO_SOURCE", () => {
    expect(() => loadConfig({ GEO_SOURCE: "maxmind" })).toThrow(ConfigError);
  });

  test("never repeats DATABASE_URL in errors, because it may contain a password", () => {
    const url = "mysql://app:s3cret-value@db/ottertrail";
    expect(() => loadConfig({ DATABASE_URL: url })).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining("s3cret-value") }),
    );
  });
});
