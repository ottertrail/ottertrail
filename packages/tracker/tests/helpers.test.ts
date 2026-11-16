import { describe, expect, test, vi } from "vite-plus/test";

import { watchNavigation } from "../src/navigation.ts";
import { randomId } from "../src/random-id.ts";
import { byteLength, sanitizeName, sanitizeProperties } from "../src/sanitize.ts";
import { outcomeForStatus, parseRetryAfter } from "../src/transport.ts";
import { cleanPageUrl, cleanReferrer } from "../src/url.ts";

describe("cleanPageUrl", () => {
  test("removes the query string and fragment before anything leaves the browser", () => {
    expect(cleanPageUrl("https://example.com/reset?token=s3cret&step=2#top")).toBe(
      "https://example.com/reset",
    );
  });

  test("keeps the five UTM tags", () => {
    expect(
      cleanPageUrl("https://example.com/?ref=x&utm_source=newsletter&utm_campaign=launch"),
    ).toBe("https://example.com/?utm_source=newsletter&utm_campaign=launch");
  });

  test("keeps the port and percent-encoded paths", () => {
    expect(cleanPageUrl("http://localhost:5173/caf%C3%A9?x=1")).toBe(
      "http://localhost:5173/caf%C3%A9",
    );
  });

  test("leaves out a UTM tag PostgreSQL cannot store", () => {
    expect(cleanPageUrl("https://example.com/?utm_source=a%00b&utm_medium=email")).toBe(
      "https://example.com/?utm_medium=email",
    );
  });

  test('returns "" for a path over 2,048 characters, as the API would reject it', () => {
    const path = `/${"a".repeat(2047)}`;
    expect(cleanPageUrl(`https://example.com${path}`)).toBe(`https://example.com${path}`);
    expect(cleanPageUrl(`https://example.com${path}a`)).toBe("");
    // Percent-encoding counts, as the API sees the encoded path.
    expect(cleanPageUrl(`https://example.com/${"é".repeat(683)}`)).toBe("");
  });

  test('returns "" for a cleaned URL over 8,192 characters', () => {
    const base = "https://example.com/?utm_source=";
    expect(cleanPageUrl(`${base}${"s".repeat(8192 - base.length)}&x=1`)).toHaveLength(8192);
    expect(cleanPageUrl(`${base}${"s".repeat(8193 - base.length)}`)).toBe("");
  });
});

describe("cleanReferrer", () => {
  test("keeps where the visitor came from, not what they searched for", () => {
    expect(cleanReferrer("https://www.google.com/search?q=private+question")).toBe(
      "https://www.google.com/search",
    );
  });

  test("keeps only the scheme and host of app referrers", () => {
    expect(cleanReferrer("android-app://com.google.android.gm/")).toBe(
      "android-app://com.google.android.gm",
    );
  });

  test("returns undefined for one over 8,192 characters", () => {
    const base = "https://other.example/";
    expect(cleanReferrer(`${base}${"r".repeat(8192 - base.length)}`)).toHaveLength(8192);
    expect(cleanReferrer(`${base}${"r".repeat(8193 - base.length)}`)).toBeUndefined();
  });

  test.each(["", "not a url"])("returns undefined for %j", (referrer) => {
    expect(cleanReferrer(referrer)).toBeUndefined();
  });
});

describe("sanitizeName", () => {
  test("removes control characters and caps at 200 characters", () => {
    expect(sanitizeName("sign\nup\u0007")).toBe("signup");
    expect(sanitizeName("x".repeat(300))).toHaveLength(200);
    expect(sanitizeName(42)).toBe("42");
  });

  test("removes NUL and unpaired surrogates, keeps whole emoji", () => {
    expect(sanitizeName("a\u0000b\uD800c\uDC00d\uD83D\uDE00")).toBe("abcd\uD83D\uDE00");
  });

  test("never cuts an emoji in half at the length cap", () => {
    expect(sanitizeName(`${"x".repeat(199)}\uD83D\uDE00`)).toBe("x".repeat(199));
  });
});

describe("sanitizeProperties", () => {
  test("keeps flat values and drops everything else", () => {
    expect(
      sanitizeProperties({
        plan: "free",
        lesson: 3,
        beta: true,
        coupon: null,
        nested: { a: 1 },
        list: [1],
        missing: undefined,
        infinite: Number.POSITIVE_INFINITY,
        [""]: "empty key",
        ["k".repeat(101)]: "long key",
      }),
    ).toEqual({ plan: "free", lesson: 3, beta: true, coupon: null });
  });

  test("drops keys and strings PostgreSQL cannot store", () => {
    expect(
      sanitizeProperties({
        ok: "fine \uD83D\uDE00",
        nul: "a\u0000b",
        high: "a\uD800",
        low: "\uDC00a",
        reversed: "\uDE00\uD83D",
        ["k\u0000"]: "nul in key",
        ["k\uD800"]: "surrogate in key",
      }),
    ).toEqual({ ok: "fine \uD83D\uDE00" });
  });

  test("never cuts an emoji in half at the 500-character cap", () => {
    expect(sanitizeProperties({ text: `${"x".repeat(499)}\uD83D\uDE00` })?.text).toBe(
      "x".repeat(499),
    );
  });

  test("caps strings at 500 characters and keys at 30", () => {
    const many = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`p${i}`, i]));
    expect(Object.keys(sanitizeProperties(many) ?? {})).toHaveLength(30);
    expect(sanitizeProperties({ text: "x".repeat(600) })?.text).toHaveLength(500);
  });

  test("drops the last keys until the properties fit in 8 KB", () => {
    const large = Object.fromEntries(
      Array.from({ length: 30 }, (_, i) => [`p${i}`, "x".repeat(500)]),
    );
    const kept = sanitizeProperties(large) ?? {};
    expect(byteLength(JSON.stringify(kept))).toBeLessThanOrEqual(8 * 1024);
    expect(Object.keys(kept)[0]).toBe("p0");
  });

  test.each([null, undefined, "text", 5, [1, 2], {}])("returns undefined for %j", (input) => {
    expect(sanitizeProperties(input)).toBeUndefined();
  });
});

describe("outcomeForStatus", () => {
  test.each([
    [202, { type: "sent" }],
    [400, { type: "drop" }],
    [403, { type: "drop" }],
    [413, { type: "drop" }],
    [429, { type: "retry", retryAfterMs: 5000 }],
    [503, { type: "retry", retryAfterMs: 5000 }],
  ])("status %i means %j", (status, outcome) => {
    expect(outcomeForStatus(status, "5")).toEqual(outcome);
  });

  test("retries without a delay hint when Retry-After is missing or a date", () => {
    expect(outcomeForStatus(503, null)).toEqual({ type: "retry" });
    expect(parseRetryAfter("Wed, 21 Oct 2026 07:28:00 GMT")).toBeUndefined();
  });
});

describe("randomId", () => {
  const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  test("returns a version 4 UUID", () => {
    expect(randomId()).toMatch(UUID_V4);
  });

  test("builds one from random bytes where crypto.randomUUID is missing (plain HTTP pages)", () => {
    // Hide randomUUID behind an own property, then remove it to restore the original.
    const own = Object.getOwnPropertyDescriptor(crypto, "randomUUID");
    Object.defineProperty(crypto, "randomUUID", { value: undefined, configurable: true });
    try {
      const ids = new Set(Array.from({ length: 100 }, () => randomId()));
      expect(ids.size).toBe(100);
      for (const id of ids) expect(id).toMatch(UUID_V4);
    } finally {
      if (own === undefined) {
        Reflect.deleteProperty(crypto, "randomUUID");
      } else {
        Object.defineProperty(crypto, "randomUUID", own);
      }
    }
  });
});

/** A window with just enough location and history for watchNavigation. */
function fakeWindow(pathname = "/") {
  const listeners: (() => void)[] = [];
  const location = { pathname };
  const navigate: History["pushState"] = (_data, _unused, url) => {
    if (url) location.pathname = new URL(String(url), "https://example.com").pathname;
  };
  const original = {
    pushState: vi.fn<History["pushState"]>(navigate),
    replaceState: vi.fn<History["replaceState"]>(navigate),
  };
  const win = {
    location,
    history: { pushState: original.pushState, replaceState: original.replaceState },
    addEventListener: (_type: "popstate", listener: () => void) => listeners.push(listener),
  };
  return { win, original, listeners };
}

describe("watchNavigation", () => {
  test("reports a pageview when pushState or replaceState changes the path", () => {
    const { win, original } = fakeWindow();
    const onNewPath = vi.fn<() => void>();
    watchNavigation(win, onNewPath);

    win.history.pushState({}, "", "/pricing");
    win.history.replaceState({}, "", "/docs");

    expect(onNewPath).toHaveBeenCalledTimes(2);
    // The app's own navigation still happens.
    expect(original.pushState).toHaveBeenCalledWith({}, "", "/pricing");
    expect(original.replaceState).toHaveBeenCalledWith({}, "", "/docs");
  });

  test("ignores changes to only the query string or fragment", () => {
    const { win } = fakeWindow("/pricing");
    const onNewPath = vi.fn<() => void>();
    watchNavigation(win, onNewPath);

    win.history.pushState({}, "", "/pricing?plan=team");
    win.history.replaceState({}, "", "/pricing#faq");

    expect(onNewPath).not.toHaveBeenCalled();
  });

  test("reports back and forward buttons (popstate)", () => {
    const { win, listeners } = fakeWindow("/pricing");
    const onNewPath = vi.fn<() => void>();
    watchNavigation(win, onNewPath);

    win.location.pathname = "/";
    for (const listener of listeners) listener();

    expect(onNewPath).toHaveBeenCalledOnce();
  });

  test("never breaks the app's navigation if tracking fails", () => {
    const { win, original } = fakeWindow();
    watchNavigation(win, () => {
      throw new Error("tracking failed");
    });

    expect(() => win.history.pushState({}, "", "/pricing")).not.toThrow();
    expect(original.pushState).toHaveBeenCalled();
  });
});
