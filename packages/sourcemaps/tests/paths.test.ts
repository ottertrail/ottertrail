import { join } from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { urlPathFor } from "../src/find.ts";
import { normalizeUrlPrefix } from "../src/options.ts";

describe("normalizeUrlPrefix", () => {
  test.each([
    ["/", "/"],
    ["", "/"],
    ["///", "/"],
    ["static", "/static/"],
    ["/static", "/static/"],
    ["static/", "/static/"],
    ["/static/", "/static/"],
    ["//static//", "/static/"],
    ["/a/b", "/a/b/"],
    ["https://cdn.example.com/assets/", "/assets/"],
    ["https://cdn.example.com", "/"],
  ])("%j becomes %j", (raw, expected) => {
    expect(normalizeUrlPrefix(raw)).toBe(expected);
  });

  test.each(["/static?v=1", "/static#top", "/my assets/", "https://cdn.example.com/a/?x=1"])(
    "%j is refused",
    (raw) => {
      expect(normalizeUrlPrefix(raw)).toBeNull();
    },
  );
});

describe("urlPathFor", () => {
  test("joins the prefix and the file with one slash", () => {
    expect(urlPathFor("/", "index-4f3a.js")).toBe("/index-4f3a.js");
    expect(urlPathFor("/static/", "index-4f3a.js")).toBe("/static/index-4f3a.js");
  });

  test("keeps nested directories, with forward slashes", () => {
    expect(urlPathFor("/", join("assets", "chunks", "vendor.mjs"))).toBe(
      "/assets/chunks/vendor.mjs",
    );
  });

  test("encodes special characters as a browser's URL does", () => {
    expect(urlPathFor("/", join("my assets", "app.js"))).toBe("/my%20assets/app.js");
    expect(urlPathFor("/", "café.js")).toBe("/caf%C3%A9.js");
    expect(urlPathFor("/", "a+b@c~d.js")).toBe("/a+b@c~d.js");
  });

  test("encodes characters that would otherwise read as URL syntax", () => {
    expect(urlPathFor("/", "100%.js")).toBe("/100%25.js");
    expect(urlPathFor("/", "what?.js")).toBe("/what%3F.js");
    expect(urlPathFor("/", "c#.js")).toBe("/c%23.js");
  });

  test("matches new URL(frameUrl).pathname for the file served there", () => {
    const frame = "https://example.com/static/my%20assets/caf%C3%A9.js?v=2";
    expect(urlPathFor("/static/", join("my assets", "café.js"))).toBe(new URL(frame).pathname);
  });
});
