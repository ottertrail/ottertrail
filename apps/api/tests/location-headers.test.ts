import { describe, expect, test } from "vite-plus/test";

import {
  locationFromHeaders,
  parseLocationHeaderName,
} from "../src/collection/location-headers.ts";

const NAMES = { country: "x-country", region: "x-region", city: "x-city" };
const TRUSTED = { "x-ottertrail-trusted-proxy": "true" };

/** The location a trusted request with these values gives. */
const locate = (values: { country?: string; region?: string; city?: string }) =>
  locationFromHeaders(
    {
      ...TRUSTED,
      ...(values.country === undefined ? {} : { "x-country": values.country }),
      ...(values.region === undefined ? {} : { "x-region": values.region }),
      ...(values.city === undefined ? {} : { "x-city": values.city }),
    },
    NAMES,
  );

describe("location header names", () => {
  test.each([
    "x-forwarded-for",
    "Forwarded",
    "x-real-ip",
    "x-client-ip",
    "CF-Connecting-IP",
    "true-client-ip",
    "fastly-client-ip",
  ])("refuses %s, which carries the visitor's address", (name) => {
    expect(parseLocationHeaderName(name)).toMatchObject({ ok: false });
  });

  test.each([
    "location",
    "from",
    "server",
    "etag",
    "age",
    "expires",
    "retry-after",
    "max-forwards",
    "if-modified-since",
    "if-unmodified-since",
    "last-modified",
  ])("refuses %s, of which Node keeps only the first", (name) => {
    expect(parseLocationHeaderName(name)).toMatchObject({ ok: false });
  });

  test("accepts a name of the owner's own, in lower case", () => {
    expect(parseLocationHeaderName(" X-Visitor-City ")).toEqual({
      ok: true,
      name: "x-visitor-city",
    });
  });
});

describe("location header values", () => {
  test("a cut never splits a character: 99 letters and an emoji keep the letters", () => {
    const city = locate({ country: "DE", city: `${"a".repeat(99)}%F0%9F%98%80` }).city;
    expect(city).toBe("a".repeat(99));
    expect(city?.isWellFormed()).toBe(true);
    // Raw UTF-8 bytes, as Node reads them (Latin-1), cut the same way.
    const raw = Buffer.from(`${"b".repeat(99)}😀`, "utf8").toString("latin1");
    expect(locate({ city: raw }).city).toBe("b".repeat(99));
  });

  test.each(["203.0.113.7", "2001:db8::1", "::ffff:203.0.113.7", " 198.51.100.2 "])(
    "drops an address as a region or city: %j",
    (address) => {
      expect(locate({ country: "DE", region: address, city: address })).toEqual({ country: "DE" });
    },
  );

  test.each([
    ["a right-to-left override", "Paris‮"],
    ["a zero-width space", "Pa​ris"],
    ["a zero-width joiner", "Pa‍ris"],
    ["a byte order mark", "﻿Paris"],
    ["a line separator", "Paris "],
    ["a paragraph separator", "Paris "],
    ["a percent-encoded bidi control", "Paris%E2%80%AE"],
    ["a control character", "Par\u0007is"],
  ])("drops a value with %s", (_, value) => {
    expect(locate({ city: value, region: value })).toEqual({});
  });

  test("keeps letters beyond ASCII", () => {
    expect(locate({ region: "Île-de-France", city: "São Paulo" })).toEqual({
      region: "Île-de-France",
      city: "São Paulo",
    });
  });

  test.each(["DE", "de", "Fr", "XK", "AQ", " us "])("keeps the country %j", (code) => {
    expect(locate({ country: code }).country).toBe(code.trim().toUpperCase());
  });

  test.each([
    ["Cloudflare's unknown", "XX"],
    ["Cloudflare's Tor", "T1"],
    ["user-assigned", "ZZ"],
    ["user-assigned", "AA"],
    ["the European Union", "EU"],
    ["the United Nations", "UN"],
    ["reserved", "UK"],
    ["withdrawn", "YU"],
    ["Latin-1 ß, which upper-cases to SS", "ß"],
    ["Latin-1 ß twice", "ßß"],
    ["dotless ı", "ıd"],
    ["three letters", "DEU"],
  ])("drops %s: %j", (_, code) => {
    expect(locate({ country: code })).toEqual({});
  });
});
