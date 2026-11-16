import { describe, expect, test } from "vite-plus/test";

import {
  cleanReferrer,
  correctClock,
  isAllowedHostname,
  MAX_EVENT_AGE_MS,
  originHostname,
  parsePageUrl,
} from "../src/collection/normalize.ts";

describe("parsePageUrl", () => {
  test("keeps the hostname and path, and drops the query string and fragment", () => {
    expect(parsePageUrl("https://Example.com/reset?token=s3cret#step-2")).toEqual({
      hostname: "example.com",
      path: "/reset",
      utm: {},
    });
  });

  test("keeps only the five UTM campaign tags from the query string", () => {
    const page = parsePageUrl(
      "https://example.com/?utm_source=newsletter&utm_medium=email&utm_campaign=launch&utm_term=js&utm_content=header&ref=friend",
    );
    expect(page?.utm).toEqual({
      source: "newsletter",
      medium: "email",
      campaign: "launch",
      term: "js",
      content: "header",
    });
  });

  test("trims UTM values, ignores empty ones, and caps them at 200 characters", () => {
    const long = "x".repeat(300);
    const page = parsePageUrl(
      `https://example.com/?utm_source=%20news%20&utm_medium=&utm_campaign=${long}`,
    );
    expect(page?.utm).toEqual({ source: "news", campaign: "x".repeat(200) });
  });

  test("shortens a campaign tag without cutting an emoji in half", () => {
    const page = parsePageUrl(
      `https://example.com/?utm_campaign=${"x".repeat(199)}${encodeURIComponent("🚀")}`,
    );
    expect(page?.utm.campaign).toBe("x".repeat(199));
  });

  test("keeps percent-encoding in the path as sent", () => {
    expect(parsePageUrl("https://example.com/caf%C3%A9")?.path).toBe("/caf%C3%A9");
  });

  test.each(["not a url", "javascript:alert(1)", "ftp://example.com/file", "file:///etc/passwd"])(
    "rejects %j",
    (url) => {
      expect(parsePageUrl(url)).toBeNull();
    },
  );

  test("rejects paths longer than 2,048 characters", () => {
    expect(parsePageUrl(`https://example.com/${"a".repeat(2048)}`)).toBeNull();
  });
});

describe("cleanReferrer", () => {
  test("drops the query string and fragment", () => {
    expect(cleanReferrer("https://news.ycombinator.com/item?id=1#top")).toBe(
      "https://news.ycombinator.com/item",
    );
  });

  test("keeps the scheme and host of app referrers", () => {
    expect(cleanReferrer("android-app://com.google.android.gm/")).toBe(
      "android-app://com.google.android.gm",
    );
  });

  test.each([undefined, "", "   ", "not a url"])("returns undefined for %j", (referrer) => {
    expect(cleanReferrer(referrer)).toBeUndefined();
  });

  test("returns undefined instead of storing an overly long referrer", () => {
    expect(cleanReferrer(`https://example.com/${"a".repeat(2048)}`)).toBeUndefined();
  });
});

describe("correctClock", () => {
  const receivedAt = Date.parse("2026-11-16T10:00:00.000Z");

  test("uses only the difference between the sender's two timestamps", () => {
    // The sender's clock is two hours slow. The event happened 3 seconds
    // before the batch was sent, so it happened 3 seconds before arrival.
    const sentAt = receivedAt - 2 * 60 * 60 * 1000;
    expect(correctClock(sentAt - 3000, sentAt, receivedAt)).toEqual(new Date(receivedAt - 3000));
  });

  test("works the same when the sender's clock is ahead", () => {
    const sentAt = receivedAt + 3 * 24 * 60 * 60 * 1000;
    expect(correctClock(sentAt - 500, sentAt, receivedAt)).toEqual(new Date(receivedAt - 500));
  });

  test("treats an event 'after' its send time as happening at send time", () => {
    expect(correctClock(receivedAt + 10_000, receivedAt, receivedAt)).toEqual(new Date(receivedAt));
  });

  test("keeps an event exactly 24 hours old and rejects anything older", () => {
    expect(correctClock(receivedAt - MAX_EVENT_AGE_MS, receivedAt, receivedAt)).toEqual(
      new Date(receivedAt - MAX_EVENT_AGE_MS),
    );
    expect(correctClock(receivedAt - MAX_EVENT_AGE_MS - 1, receivedAt, receivedAt)).toBeNull();
  });
});

describe("isAllowedHostname", () => {
  test("matches exactly, ignoring case", () => {
    expect(isAllowedHostname("Example.com", ["example.com"])).toBe(true);
  });

  test("does not treat subdomains as allowed", () => {
    expect(isAllowedHostname("www.example.com", ["example.com"])).toBe(false);
    expect(isAllowedHostname("example.com.evil.test", ["example.com"])).toBe(false);
  });

  test("allows nothing when the list is empty", () => {
    expect(isAllowedHostname("example.com", [])).toBe(false);
  });
});

describe("originHostname", () => {
  test("returns the hostname of an http(s) origin", () => {
    expect(originHostname("https://Example.com")).toBe("example.com");
    expect(originHostname("http://localhost:5173")).toBe("localhost");
  });

  test.each(["null", "file://", "chrome-extension://abc", "garbage"])("rejects %j", (origin) => {
    expect(originHostname(origin)).toBeNull();
  });
});
