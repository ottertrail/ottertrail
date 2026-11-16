import { existsSync } from "node:fs";

import { describe, expect, test } from "vite-plus/test";

import { DEFAULT_GEO_DATABASE_PATH } from "../src/config.ts";
import {
  type CityRecord,
  cloudflareLocation,
  GeoDatabase,
  locationFromRecord,
} from "../src/enrichment/geo.ts";
import { setUpLocation, STALE_AFTER_DAYS } from "../src/enrichment/setup.ts";
import { isBot, parseUserAgent } from "../src/enrichment/user-agent.ts";

describe("parseUserAgent", () => {
  test.each([
    [
      "Chrome on a Mac",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
      { browser: "Chrome", browserVersion: "142", os: "macOS", deviceType: "desktop" },
    ],
    [
      "Edge on Windows",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0",
      { browser: "Microsoft Edge", browserVersion: "142", os: "Windows", deviceType: "desktop" },
    ],
    [
      "Safari on an iPhone",
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1",
      { browser: "Safari", browserVersion: "18", os: "iOS", deviceType: "mobile" },
    ],
    [
      "Firefox on an Android phone",
      "Mozilla/5.0 (Android 15; Mobile; rv:144.0) Gecko/144.0 Firefox/144.0",
      { browser: "Firefox", browserVersion: "144", os: "Android", deviceType: "mobile" },
    ],
    [
      "Samsung Internet on an Android tablet",
      "Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 Chrome/130.0.0.0 Safari/537.36",
      {
        browser: "Samsung Internet for Android",
        browserVersion: "28",
        os: "Android",
        deviceType: "tablet",
      },
    ],
  ])("reads %s", (_label, userAgent, client) => {
    expect(parseUserAgent(userAgent)).toEqual(client);
  });

  test("keeps no OS version: browsers freeze it (every Mac reports 10.15.7)", () => {
    expect(
      Object.keys(
        parseUserAgent(
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
        ),
      ),
    ).not.toContain("osVersion");
  });

  test("returns nothing it cannot recognize", () => {
    expect(parseUserAgent("")).toEqual({});
    expect(parseUserAgent("something/1.0")).toEqual({});
  });
});

describe("isBot", () => {
  test.each([
    "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
    "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/142.0.0.0 Safari/537.36",
    "curl/8.7.1",
    "python-requests/2.32.3",
    "",
    "   ",
    undefined,
  ])("treats %j as a bot", (userAgent) => {
    expect(isBot(userAgent)).toBe(true);
  });

  test("lets real browsers through", () => {
    expect(
      isBot(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1",
      ),
    ).toBe(false);
  });
});

describe("locationFromRecord", () => {
  test("reads country code, first region, and city in English", () => {
    const record = {
      country: { iso_code: "US" },
      subdivisions: [{ names: { en: "California" } }],
      city: { names: { en: "Mountain View" } },
    } as CityRecord;
    expect(locationFromRecord(record)).toEqual({
      country: "US",
      region: "California",
      city: "Mountain View",
    });
  });

  test("keeps what is known and drops malformed values", () => {
    expect(locationFromRecord({ country: { iso_code: "de" } } as CityRecord)).toEqual({});
    expect(
      locationFromRecord({
        country: { iso_code: "FR" },
        city: { names: { en: "  " } },
      } as CityRecord),
    ).toEqual({ country: "FR" });
    expect(locationFromRecord(null)).toEqual({});
  });
});

describe("cloudflareLocation", () => {
  test("reads Cloudflare's visitor location headers, decoding city names", () => {
    expect(
      cloudflareLocation({
        "cf-ipcountry": "DE",
        "cf-region": "Bavaria",
        "cf-ipcity": "M%C3%BCnchen",
      }),
    ).toEqual({ country: "DE", region: "Bavaria", city: "München" });
  });

  test.each(["XX", "T1"])("treats country %j (unknown, Tor) as no country", (code) => {
    expect(cloudflareLocation({ "cf-ipcountry": code })).toEqual({});
  });

  test("returns nothing without the headers", () => {
    expect(cloudflareLocation({})).toEqual({});
  });
});

describe("setUpLocation", () => {
  test("reports a missing database instead of failing to start", async () => {
    const setup = await setUpLocation("database", "/nowhere/geo.mmdb");
    expect(setup.ok).toBe(false);
    expect(setup.message).toMatch(/vp run geo:update/);
    expect(setup.locate({ ip: "8.8.8.8", headers: {} })).toEqual({});
  });

  test("reads Cloudflare's headers when configured", async () => {
    const setup = await setUpLocation("cloudflare", "unused");
    expect(setup.locate({ ip: "8.8.8.8", headers: { "cf-ipcountry": "NL" } })).toEqual({
      country: "NL",
    });
  });

  test("does no lookup when turned off", async () => {
    const setup = await setUpLocation("none", "unused");
    expect(setup.locate({ ip: "8.8.8.8", headers: { "cf-ipcountry": "NL" } })).toEqual({});
  });
});

// The real database is downloaded by `vp run geo:update` and not kept in git,
// so these run only where it exists.
const databasePath = DEFAULT_GEO_DATABASE_PATH;
describe.skipIf(!existsSync(databasePath))("GeoDatabase with the downloaded file", () => {
  test("finds public addresses and nothing for private ones", async () => {
    const geo = await GeoDatabase.open(databasePath);
    expect(geo.type).toContain("City");
    expect(geo.lookup("8.8.8.8").country).toBe("US");
    expect(geo.lookup("2a01:4f8::1").country).toBe("DE");
    expect(geo.lookup("127.0.0.1")).toEqual({});
    expect(geo.lookup("192.168.0.101")).toEqual({});
    expect(geo.lookup("not an ip")).toEqual({});
  });

  test(`warns when the file is older than ${STALE_AFTER_DAYS} days`, async () => {
    const geo = await GeoDatabase.open(databasePath);
    const later = new Date(geo.builtAt.getTime() + (STALE_AFTER_DAYS + 1) * 86_400_000);
    const setup = await setUpLocation("database", databasePath, later);
    expect(setup.ok).toBe(false);
    expect(setup.message).toMatch(/less accurate/);
  });
});
