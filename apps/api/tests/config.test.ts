import { describe, expect, test } from "vite-plus/test";

import {
  ConfigError,
  DEFAULT_DASHBOARD_PATH,
  DEFAULT_DATA_CENTERS_PATH,
  DEFAULT_GEO_DATABASE_PATH,
  DEFAULT_ORGANIZATION_EVENTS_PER_SECOND,
  DEFAULT_REPLAY_PLAYER_PATH,
  DEFAULT_REPLAY_BYTES_PER_ORGANIZATION,
  DEFAULT_SOURCE_MAP_BYTES_PER_ORGANIZATION,
  DEVELOPMENT_AUTH_SECRET,
  DEFAULT_TRACKER_SCRIPT_PATH,
  DEVELOPMENT_PUBLIC_URL,
  LOCAL_CLICKHOUSE,
  LOCAL_DATABASE_URL,
  LOCAL_OBJECT_STORE,
  loadConfig,
} from "../src/config.ts";

/** What production needs besides defaults. */
const PRODUCTION = {
  NODE_ENV: "production",
  DATABASE_URL: "postgresql://app@db.internal:5432/ottertrail",
  CLICKHOUSE_URL: "http://clickhouse:8123",
  CLICKHOUSE_PASSWORD: "c".repeat(40),
  PUBLIC_URL: "https://analytics.example.com",
  AUTH_SECRET: "x".repeat(32),
};

describe("loadConfig", () => {
  test("uses local development defaults when variables are unset", () => {
    expect(loadConfig({})).toEqual({
      host: "127.0.0.1",
      port: 3000,
      logLevel: "info",
      databaseUrl: LOCAL_DATABASE_URL,
      clickhouse: LOCAL_CLICKHOUSE,
      trustProxy: false,
      geoSource: "database",
      geoDatabasePath: DEFAULT_GEO_DATABASE_PATH,
      dataCentersPath: DEFAULT_DATA_CENTERS_PATH,
      organizationEventsPerSecond: DEFAULT_ORGANIZATION_EVENTS_PER_SECOND,
      defaultTimeZone: "UTC",
      publicUrl: DEVELOPMENT_PUBLIC_URL,
      trustedOrigins: [DEVELOPMENT_PUBLIC_URL, "http://localhost:*", "http://127.0.0.1:*"],
      authSecret: DEVELOPMENT_AUTH_SECRET,
      trackerScriptPath: DEFAULT_TRACKER_SCRIPT_PATH,
      dashboardPath: DEFAULT_DASHBOARD_PATH,
      replayPlayerPath: DEFAULT_REPLAY_PLAYER_PATH,
      objectStore: LOCAL_OBJECT_STORE,
      sourceMapBytesPerOrganization: DEFAULT_SOURCE_MAP_BYTES_PER_ORGANIZATION,
      replayBytesPerOrganization: DEFAULT_REPLAY_BYTES_PER_ORGANIZATION,
    });
  });

  test("reads values from the environment", () => {
    expect(
      loadConfig({
        HOST: "0.0.0.0",
        PORT: "8080",
        LOG_LEVEL: "debug",
        DATABASE_URL: "postgresql://app@db.internal:5432/ottertrail",
        CLICKHOUSE_URL: "http://clickhouse:8123/",
        CLICKHOUSE_USER: "app",
        CLICKHOUSE_PASSWORD: "p".repeat(40),
        CLICKHOUSE_DATABASE: "analytics",
        TRUST_PROXY: "1",
        GEO_SOURCE: "cloudflare",
        GEO_DATABASE_PATH: "/var/lib/ottertrail/geo.mmdb",
        DATA_CENTERS_PATH: "/var/lib/ottertrail/data-centers.json",
        ORGANIZATION_EVENTS_PER_SECOND: "2000",
        TIMEZONE: "Asia/Singapore",
        PUBLIC_URL: "https://analytics.example.com/",
        AUTH_SECRET: "s".repeat(44),
        TRACKER_SCRIPT_PATH: "/srv/ottertrail/tracker.js",
        DASHBOARD_PATH: "/srv/ottertrail/dashboard",
        REPLAY_PLAYER_PATH: "/srv/ottertrail/replay-player.js",
        OBJECT_STORE_URL: "https://account.r2.cloudflarestorage.com/",
        OBJECT_STORE_REGION: "auto",
        OBJECT_STORE_BUCKET: "ottertrail-files",
        OBJECT_STORE_ACCESS_KEY_ID: "id-123",
        OBJECT_STORE_SECRET_ACCESS_KEY: "o".repeat(40),
        SOURCE_MAP_BYTES_PER_ORGANIZATION: String(5 * 1024 ** 3),
        REPLAY_BYTES_PER_ORGANIZATION: String(10 * 1024 ** 3),
      }),
    ).toEqual({
      host: "0.0.0.0",
      port: 8080,
      logLevel: "debug",
      databaseUrl: "postgresql://app@db.internal:5432/ottertrail",
      clickhouse: {
        url: "http://clickhouse:8123",
        username: "app",
        password: "p".repeat(40),
        database: "analytics",
      },
      trustProxy: 1,
      geoSource: "cloudflare",
      geoDatabasePath: "/var/lib/ottertrail/geo.mmdb",
      dataCentersPath: "/var/lib/ottertrail/data-centers.json",
      organizationEventsPerSecond: 2000,
      defaultTimeZone: "Asia/Singapore",
      publicUrl: "https://analytics.example.com",
      trustedOrigins: ["https://analytics.example.com", "http://localhost:*", "http://127.0.0.1:*"],
      authSecret: "s".repeat(44),
      trackerScriptPath: "/srv/ottertrail/tracker.js",
      dashboardPath: "/srv/ottertrail/dashboard",
      replayPlayerPath: "/srv/ottertrail/replay-player.js",
      objectStore: {
        url: "https://account.r2.cloudflarestorage.com",
        region: "auto",
        bucket: "ottertrail-files",
        accessKeyId: "id-123",
        secretAccessKey: "o".repeat(40),
      },
      sourceMapBytesPerOrganization: 5 * 1024 ** 3,
      replayBytesPerOrganization: 10 * 1024 ** 3,
    });
  });

  test("refuses an organization event rate below one batch in ten seconds, or not a whole number", () => {
    for (const value of ["4", "2.5", "-1", "lots", "1000001"]) {
      expect(() => loadConfig({ ORGANIZATION_EVENTS_PER_SECOND: value })).toThrow(
        "ORGANIZATION_EVENTS_PER_SECOND must be an integer",
      );
    }
  });

  test("trusts only the public URL in production", () => {
    const config = loadConfig(PRODUCTION);
    expect(config.trustedOrigins).toEqual(["https://analytics.example.com"]);
    expect(config.authSecret).toBe("x".repeat(32));
  });

  test.each(["PUBLIC_URL", "AUTH_SECRET", "CLICKHOUSE_URL", "CLICKHOUSE_PASSWORD"])(
    "requires %s in production",
    (name) => {
      expect(() => loadConfig({ ...PRODUCTION, [name]: undefined })).toThrow(
        new RegExp(`${name} is required in production`),
      );
    },
  );

  test("requires https for PUBLIC_URL in production", () => {
    expect(() => loadConfig({ ...PRODUCTION, PUBLIC_URL: "http://analytics.example.com" })).toThrow(
      /must use https/,
    );
  });

  test.each([
    "analytics.example.com",
    "ftp://example.com",
    "https://example.com/dashboard",
    "https://example.com/?a=1",
  ])("rejects PUBLIC_URL %j", (value) => {
    expect(() => loadConfig({ PUBLIC_URL: value })).toThrow(ConfigError);
  });

  test("rejects an AUTH_SECRET shorter than 32 characters, without repeating it", () => {
    expect(() => loadConfig({ AUTH_SECRET: "short-secret" })).toThrow(/at least 32 characters/);
    expect(() => loadConfig({ AUTH_SECRET: "short-secret" })).not.toThrow(/short-secret/);
  });

  test.each(["0", "65536", "3000.5", "abc", ""])("rejects invalid PORT %j", (port) => {
    expect(() => loadConfig({ PORT: port })).toThrow(ConfigError);
  });

  test("rejects an unknown LOG_LEVEL", () => {
    expect(() => loadConfig({ LOG_LEVEL: "verbose" })).toThrow(ConfigError);
  });

  test("requires DATABASE_URL in production instead of using the local database", () => {
    expect(() => loadConfig({ ...PRODUCTION, DATABASE_URL: undefined })).toThrow(
      /DATABASE_URL is required/,
    );
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
    expect(loadConfig({ TIMEZONE: "singapore" }).defaultTimeZone).toBe("Asia/Singapore");
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

  describe("ClickHouse", () => {
    test.each([
      ["ftp://clickhouse:8123", /must be an http\(s\) URL/],
      ["http://user:secret@clickhouse:8123", /must not hold a user or password/],
    ])("refuses CLICKHOUSE_URL %s", (url, message) => {
      expect(() => loadConfig({ CLICKHOUSE_URL: url })).toThrow(message);
    });

    test("never repeats the password in an error", () => {
      expect(() => loadConfig({ CLICKHOUSE_URL: "http://user:hunter2@clickhouse:8123" })).toThrow(
        expect.objectContaining({ message: expect.not.stringContaining("hunter2") }),
      );
    });

    test("refuses a database name that is not a plain identifier", () => {
      expect(() => loadConfig({ CLICKHOUSE_DATABASE: "events; DROP" })).toThrow(
        /letters, digits, and underscores/,
      );
    });
  });

  describe("object store", () => {
    test("is off in production unless OBJECT_STORE_URL is set, and in development with off", () => {
      expect(loadConfig(PRODUCTION).objectStore).toBeNull();
      expect(loadConfig({ OBJECT_STORE_URL: "off" }).objectStore).toBeNull();
    });

    test("needs both keys with OBJECT_STORE_URL, and never repeats a secret in an error", () => {
      expect(() => loadConfig({ OBJECT_STORE_URL: "http://garage:3900" })).toThrow(
        /OBJECT_STORE_ACCESS_KEY_ID and OBJECT_STORE_SECRET_ACCESS_KEY are required/,
      );
      expect(() => loadConfig({ OBJECT_STORE_URL: "http://id:hunter2@garage:3900" })).toThrow(
        expect.objectContaining({ message: expect.not.stringContaining("hunter2") }),
      );
    });

    test.each([
      ["ftp://garage:3900", /must be an http\(s\) URL/],
      ["garage:3900", /must be an http\(s\) URL/],
    ])("refuses OBJECT_STORE_URL %s", (url, message) => {
      expect(() => loadConfig({ OBJECT_STORE_URL: url })).toThrow(message);
    });

    test("refuses a bucket name S3 would not take", () => {
      expect(() =>
        loadConfig({
          OBJECT_STORE_URL: "http://garage:3900",
          OBJECT_STORE_ACCESS_KEY_ID: "id",
          OBJECT_STORE_SECRET_ACCESS_KEY: "secret",
          OBJECT_STORE_BUCKET: "Has_Capitals",
        }),
      ).toThrow(/OBJECT_STORE_BUCKET is not a valid bucket name/);
    });

    test("refuses a source map limit below 1 MiB, above 1 TiB, or not a whole number", () => {
      for (const value of ["1000", String(1024 ** 4 + 1), "2097152.5", "lots"]) {
        expect(() => loadConfig({ SOURCE_MAP_BYTES_PER_ORGANIZATION: value })).toThrow(
          "SOURCE_MAP_BYTES_PER_ORGANIZATION must be a number of bytes",
        );
      }
    });
  });
});
