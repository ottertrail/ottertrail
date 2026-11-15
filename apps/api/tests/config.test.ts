import { describe, expect, test } from "vite-plus/test";

import { ConfigError, loadConfig } from "../src/config.ts";

describe("loadConfig", () => {
  test("uses local development defaults when variables are unset", () => {
    expect(loadConfig({})).toEqual({ host: "127.0.0.1", port: 3000, logLevel: "info" });
  });

  test("reads values from the environment", () => {
    expect(loadConfig({ HOST: "0.0.0.0", PORT: "8080", LOG_LEVEL: "debug" })).toEqual({
      host: "0.0.0.0",
      port: 8080,
      logLevel: "debug",
    });
  });

  test.each(["0", "65536", "3000.5", "abc", ""])("rejects invalid PORT %j", (port) => {
    expect(() => loadConfig({ PORT: port })).toThrow(ConfigError);
  });

  test("rejects an unknown LOG_LEVEL", () => {
    expect(() => loadConfig({ LOG_LEVEL: "verbose" })).toThrow(ConfigError);
  });
});
