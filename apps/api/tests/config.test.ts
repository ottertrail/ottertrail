import { describe, expect, test } from "vite-plus/test";

import {
  ConfigError,
  DEFAULT_DASHBOARD_PATH,
  DEFAULT_DATA_CENTERS_PATH,
  DEFAULT_GEO_DATABASE_PATH,
  DEFAULT_INSTANCE_EVENTS_PER_SECOND,
  DEFAULT_REPLAY_PLAYER_PATH,
  DEFAULT_REPLAY_STORAGE_BYTES,
  DEFAULT_TELEMETRY_RETENTION_DAYS,
  DEFAULT_SOURCE_MAP_STORAGE_BYTES,
  DEVELOPMENT_AUTH_SECRET,
  DEVELOPMENT_GARAGE_ADMIN_TOKEN,
  DEFAULT_TRACKER_SCRIPT_PATH,
  DEVELOPMENT_PUBLIC_URL,
  LOCAL_CLICKHOUSE,
  LOCAL_DATABASE_URL,
  LOCAL_OBJECT_STORE,
  loadBackupS3,
  loadConfig,
  parseBackupS3,
} from "../src/config.ts";

/** An SMTP server's URL with a password, built at run time so no secret scanner mistakes it for one. */
const SMTP_URL = `smtps://alerts:${"m".repeat(20)}@smtp.example.com:465`;

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
      instanceEventsPerSecond: DEFAULT_INSTANCE_EVENTS_PER_SECOND,
      publicUrl: DEVELOPMENT_PUBLIC_URL,
      trustedOrigins: [DEVELOPMENT_PUBLIC_URL, "http://localhost:*", "http://127.0.0.1:*"],
      authSecret: DEVELOPMENT_AUTH_SECRET,
      trackerScriptPath: DEFAULT_TRACKER_SCRIPT_PATH,
      dashboardPath: DEFAULT_DASHBOARD_PATH,
      replayPlayerPath: DEFAULT_REPLAY_PLAYER_PATH,
      objectStore: LOCAL_OBJECT_STORE,
      garage: { adminUrl: "http://127.0.0.1:3903", adminToken: DEVELOPMENT_GARAGE_ADMIN_TOKEN },
      sourceMapStorageBytes: DEFAULT_SOURCE_MAP_STORAGE_BYTES,
      replayStorageBytes: DEFAULT_REPLAY_STORAGE_BYTES,
      telemetryRetentionDays: DEFAULT_TELEMETRY_RETENTION_DAYS,
      uptimeAllowPrivateAddresses: false,
      uptimeDenyAddresses: [],
      email: null,
      clickhouseBackupPath: null,
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
        INSTANCE_EVENTS_PER_SECOND: "2000",
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
        SOURCE_MAP_STORAGE_BYTES: String(5 * 1024 ** 3),
        REPLAY_STORAGE_BYTES: String(10 * 1024 ** 3),
        TELEMETRY_RETENTION_DAYS: "90",
        UPTIME_ALLOW_PRIVATE_ADDRESSES: "true",
        UPTIME_DENY_ADDRESSES: " 203.0.113.10, 2001:db8::/32 ,",
        SMTP_URL: SMTP_URL,
        EMAIL_FROM: "Ottertrail <alerts@example.com>",
        CLICKHOUSE_BACKUP_PATH: "/app/data/backups",
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
      instanceEventsPerSecond: 2000,
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
      garage: null,
      sourceMapStorageBytes: 5 * 1024 ** 3,
      replayStorageBytes: 10 * 1024 ** 3,
      telemetryRetentionDays: 90,
      uptimeAllowPrivateAddresses: true,
      uptimeDenyAddresses: ["203.0.113.10", "2001:db8::/32"],
      email: { smtpUrl: SMTP_URL, from: "Ottertrail <alerts@example.com>" },
      clickhouseBackupPath: "/app/data/backups",
    });
  });

  test("reads email's settings: none without SMTP_URL, and EMAIL_FROM required with it", () => {
    expect(loadConfig({ EMAIL_FROM: "alerts@example.com" }).email).toBeNull();
    expect(
      loadConfig({ SMTP_URL: "smtp://relay.internal:25", EMAIL_FROM: "alerts@example.com" }).email,
    ).toEqual({ smtpUrl: "smtp://relay.internal:25", from: "alerts@example.com" });
    for (const from of [undefined, "", "not an address", "Ops <ops!alerts@example.com>", "a@b"]) {
      expect(() =>
        loadConfig({ SMTP_URL, ...(from === undefined ? {} : { EMAIL_FROM: from }) }),
      ).toThrow("EMAIL_FROM is required with SMTP_URL");
    }
  });

  test("refuses an SMTP_URL that is not one, without repeating it", () => {
    const password = "q".repeat(24);
    for (const [url, message] of [
      [
        `https://alerts:${password}@smtp.example.com`,
        "SMTP_URL must be an smtp:// or smtps:// URL",
      ],
      [`smtp://alerts:${password}@`, "SMTP_URL"],
      [`smtp://alerts@smtp.example.com`, "SMTP_URL needs both username and password, or neither"],
      [`smtps://alerts:${password}@smtp.example.com/mail`, "SMTP_URL must not have a path"],
      ...[
        "?requireTLS=false",
        "?logger=true&debug=true",
        "?tls.rejectUnauthorized=false",
        "?socketTimeout=600000",
        "?",
        "#section",
      ].map(
        (suffix) =>
          [
            `smtp://alerts:${password}@smtp.example.com:587${suffix}`,
            "No query string or fragment in SMTP_URL. Percent-encode ? and # in credentials.",
          ] as const,
      ),
      [
        `smtp://alerts:${password}#x@smtp.example.com:587`,
        "No query string or fragment in SMTP_URL",
      ],
    ] as const) {
      let error: unknown;
      try {
        loadConfig({ SMTP_URL: url, EMAIL_FROM: "alerts@example.com" });
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(ConfigError);
      expect(String(error)).toContain(message);
      expect(String(error)).not.toContain(password);
    }
  });

  test("refuses an uptime deny list entry that is not an address or CIDR range", () => {
    for (const entry of ["example.com", "10.0.0.0/33", "::1/129", "10.0.0.1/8/2", "10.0.0"]) {
      expect(() => loadConfig({ UPTIME_DENY_ADDRESSES: `203.0.113.10,${entry}` })).toThrow(
        `Invalid UPTIME_DENY_ADDRESSES entry: "${entry}". Use comma-separated IP addresses and CIDR ranges.`,
      );
    }
  });

  test("reads whether uptime checks may reach private addresses: off unless true", () => {
    expect(loadConfig({ UPTIME_ALLOW_PRIVATE_ADDRESSES: "" }).uptimeAllowPrivateAddresses).toBe(
      false,
    );
    expect(loadConfig({ UPTIME_ALLOW_PRIVATE_ADDRESSES: "1" }).uptimeAllowPrivateAddresses).toBe(
      true,
    );
    expect(
      loadConfig({ UPTIME_ALLOW_PRIVATE_ADDRESSES: "false" }).uptimeAllowPrivateAddresses,
    ).toBe(false);
    expect(() => loadConfig({ UPTIME_ALLOW_PRIVATE_ADDRESSES: "yes" })).toThrow(
      "UPTIME_ALLOW_PRIVATE_ADDRESSES must be true or false",
    );
  });

  test("refuses a telemetry retention outside 1 to 365 days, or not a whole number", () => {
    expect(DEFAULT_TELEMETRY_RETENTION_DAYS).toBe(30);
    expect(loadConfig({ TELEMETRY_RETENTION_DAYS: "1" }).telemetryRetentionDays).toBe(1);
    expect(loadConfig({ TELEMETRY_RETENTION_DAYS: "365" }).telemetryRetentionDays).toBe(365);
    for (const value of ["0", "366", "7.5", "-3", "a month"]) {
      expect(() => loadConfig({ TELEMETRY_RETENTION_DAYS: value })).toThrow(
        "TELEMETRY_RETENTION_DAYS must be 1 to 365 whole days",
      );
    }
  });

  test("refuses an instance event rate below one batch in ten seconds, or not a whole number", () => {
    for (const value of ["4", "2.5", "-1", "lots", "1000001"]) {
      expect(() => loadConfig({ INSTANCE_EVENTS_PER_SECOND: value })).toThrow(
        "INSTANCE_EVENTS_PER_SECOND must be an integer",
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
      ["http://user:secret@clickhouse:8123", /Keep credentials out of CLICKHOUSE_URL/],
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
      // As deploy/compose.yaml passes them when .env leaves one empty.
      for (const keys of [
        { OBJECT_STORE_ACCESS_KEY_ID: "", OBJECT_STORE_SECRET_ACCESS_KEY: "" },
        { OBJECT_STORE_ACCESS_KEY_ID: "GK1", OBJECT_STORE_SECRET_ACCESS_KEY: "" },
        { OBJECT_STORE_ACCESS_KEY_ID: " ", OBJECT_STORE_SECRET_ACCESS_KEY: "secret" },
      ]) {
        expect(() =>
          loadConfig({ ...PRODUCTION, OBJECT_STORE_URL: "http://garage:3900", ...keys }),
        ).toThrow(/OBJECT_STORE_ACCESS_KEY_ID and OBJECT_STORE_SECRET_ACCESS_KEY are required/);
      }
      expect(() => loadConfig({ OBJECT_STORE_URL: "http://id:hunter2@garage:3900" })).toThrow(
        expect.objectContaining({ message: expect.not.stringContaining("hunter2") }),
      );
    });

    test("the stack's Garage: its admin API beside it, and GARAGE_ADMIN_TOKEN when set", () => {
      const keys = {
        OBJECT_STORE_ACCESS_KEY_ID: "GK1",
        OBJECT_STORE_SECRET_ACCESS_KEY: "s".repeat(64),
      };
      const garage = { ...PRODUCTION, ...keys, OBJECT_STORE_URL: "http://garage:3900" };
      const token = "t".repeat(64);
      expect(loadConfig({ ...garage, GARAGE_ADMIN_TOKEN: token }).garage).toEqual({
        adminUrl: "http://garage:3903",
        adminToken: token,
      });
      // Unset or empty, as Compose passes it: no token, and nothing fails.
      expect(loadConfig(garage).garage).toEqual({
        adminUrl: "http://garage:3903",
        adminToken: null,
      });
      expect(loadConfig({ ...garage, GARAGE_ADMIN_TOKEN: "" }).garage?.adminToken).toBeNull();
      // Another store has no Garage to ask; the token is not used.
      expect(
        loadConfig({
          ...PRODUCTION,
          ...keys,
          OBJECT_STORE_URL: "https://account.r2.cloudflarestorage.com",
          GARAGE_ADMIN_TOKEN: token,
        }).garage,
      ).toBeNull();
      expect(loadConfig(PRODUCTION).garage).toBeNull();
      expect(loadConfig({ OBJECT_STORE_URL: "off" }).garage).toBeNull();
    });

    test("refuses a short or spaced GARAGE_ADMIN_TOKEN, and never repeats it", () => {
      for (const token of ["short-token", `${"t".repeat(40)} with spaces`]) {
        expect(() => loadConfig({ GARAGE_ADMIN_TOKEN: token })).toThrow(
          expect.objectContaining({
            message: expect.stringMatching(
              /^GARAGE_ADMIN_TOKEN must be 32 to 256 visible characters/,
            ),
          }),
        );
        expect(() => loadConfig({ GARAGE_ADMIN_TOKEN: token })).toThrow(
          expect.objectContaining({ message: expect.not.stringContaining(token) }),
        );
      }
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
        expect(() => loadConfig({ SOURCE_MAP_STORAGE_BYTES: value })).toThrow(
          "SOURCE_MAP_STORAGE_BYTES must be a byte count",
        );
      }
    });
  });
});

describe("the backup destination (BACKUP_S3_*)", () => {
  const SECRET = "b".repeat(40);
  const FULL = {
    BACKUP_S3_ENDPOINT: "https://account.r2.cloudflarestorage.com/",
    BACKUP_S3_REGION: "auto",
    BACKUP_S3_BUCKET: "acme-backups",
    BACKUP_S3_PREFIX: "/instance-1/",
    BACKUP_S3_ACCESS_KEY_ID: "AKIA1",
    BACKUP_S3_SECRET_ACCESS_KEY: SECRET,
  };

  test("is none when all are unset or empty, as compose.yaml passes them", () => {
    expect(parseBackupS3({}, null)).toBeNull();
    expect(
      parseBackupS3(
        Object.fromEntries(Object.keys(FULL).map((name) => [name, ""])),
        LOCAL_OBJECT_STORE,
      ),
    ).toBeNull();
  });

  test("reads all six, the endpoint as an origin and the folder without slashes", () => {
    expect(parseBackupS3(FULL, null)).toEqual({
      url: "https://account.r2.cloudflarestorage.com",
      region: "auto",
      bucket: "acme-backups",
      prefix: "instance-1",
      accessKeyId: "AKIA1",
      secretAccessKey: SECRET,
    });
    // The folder defaults to ottertrail-backups.
    expect(parseBackupS3({ ...FULL, BACKUP_S3_PREFIX: "" }, null)?.prefix).toBe(
      "ottertrail-backups",
    );
  });

  test("partly set names what is missing; the region has no default", () => {
    expect(() =>
      parseBackupS3({ ...FULL, BACKUP_S3_REGION: "", BACKUP_S3_SECRET_ACCESS_KEY: "" }, null),
    ).toThrow(
      "Set BACKUP_S3_REGION, BACKUP_S3_SECRET_ACCESS_KEY too: backups need the endpoint, region, bucket, access key ID, and secret access key.",
    );
    expect(() => parseBackupS3({ BACKUP_S3_PREFIX: "backups" }, null)).toThrow(ConfigError);
  });

  test("refuses invalid values, never repeating the endpoint or a key", () => {
    const refused: [Record<string, string>, RegExp][] = [
      [{ BACKUP_S3_ENDPOINT: "ftp://storage.example.com" }, /must be an http\(s\) URL/],
      [{ BACKUP_S3_ENDPOINT: "https://storage.example.com/bucket" }, /without a path/],
      [{ BACKUP_S3_ENDPOINT: "https://id:hunter2@storage.example.com" }, /Keep keys out/],
      [{ BACKUP_S3_REGION: "us east" }, /BACKUP_S3_REGION must be/],
      [{ BACKUP_S3_BUCKET: "Not_A_Bucket" }, /not a valid bucket name/],
      [{ BACKUP_S3_PREFIX: "a/../b" }, /BACKUP_S3_PREFIX must be a folder/],
      [{ BACKUP_S3_PREFIX: "x".repeat(201) }, /BACKUP_S3_PREFIX must be a folder/],
      [{ BACKUP_S3_ACCESS_KEY_ID: "has space" }, /BACKUP_S3_ACCESS_KEY_ID must be/],
      [{ BACKUP_S3_SECRET_ACCESS_KEY: "s".repeat(257) }, /up to 256 characters/],
    ];
    for (const [change, message] of refused) {
      let thrown: unknown;
      try {
        parseBackupS3({ ...FULL, ...change }, null);
      } catch (error) {
        thrown = error;
      }
      expect({ change, refused: thrown instanceof ConfigError }).toEqual({ change, refused: true });
      const text = (thrown as Error).message;
      expect(text).toMatch(message);
      expect(text).not.toContain("hunter2");
      expect(text).not.toContain(SECRET);
    }
  });

  test("in the object store's own bucket, the folder may not overlap its objects", () => {
    const shared = {
      ...FULL,
      BACKUP_S3_ENDPOINT: LOCAL_OBJECT_STORE.url,
      BACKUP_S3_BUCKET: LOCAL_OBJECT_STORE.bucket,
    };
    for (const prefix of ["replays", "replays/backups", "source-maps/x", "avatars"]) {
      expect(() =>
        parseBackupS3({ ...shared, BACKUP_S3_PREFIX: prefix }, LOCAL_OBJECT_STORE),
      ).toThrow(/overlaps session replays, source maps, or avatars/);
    }
    // A folder of its own, another bucket, or no object store, is fine.
    expect(
      parseBackupS3({ ...shared, BACKUP_S3_PREFIX: "replays-backups" }, LOCAL_OBJECT_STORE),
    ).not.toBeNull();
    expect(
      parseBackupS3(
        { ...shared, BACKUP_S3_BUCKET: "other-bucket", BACKUP_S3_PREFIX: "replays" },
        LOCAL_OBJECT_STORE,
      ),
    ).not.toBeNull();
    expect(parseBackupS3({ ...shared, BACKUP_S3_PREFIX: "replays" }, null)).not.toBeNull();
  });

  test("the worker's load turns a problem into words, and the API's config never reads them", () => {
    expect(loadBackupS3({ BACKUP_S3_BUCKET: "acme-backups" }, null)).toEqual({
      problem: expect.stringMatching(/^Set BACKUP_S3_ENDPOINT, BACKUP_S3_REGION, /),
    });
    expect(loadBackupS3(FULL, null)).toMatchObject({ bucket: "acme-backups" });
    expect(loadBackupS3({}, null)).toBeNull();
    // Invalid, they don't stop the API: loadConfig ignores them.
    expect(() => loadConfig({ BACKUP_S3_ENDPOINT: "ftp://x" })).not.toThrow();
    expect(JSON.stringify(loadConfig(FULL))).not.toContain(SECRET);
  });
});
