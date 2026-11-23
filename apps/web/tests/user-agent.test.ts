import { describe, expect, test } from "vite-plus/test";

import { deviceName, parseUserAgent } from "../src/lib/account-api.ts";

describe("parseUserAgent", () => {
  test("names the common browsers and systems", () => {
    expect(
      deviceName(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15",
      ),
    ).toBe("Safari 18 on macOS");
    expect(
      deviceName(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1",
      ),
    ).toBe("Safari 18 on iOS");
    expect(
      deviceName(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0",
      ),
    ).toBe("Edge 142 on Windows");
    expect(
      deviceName("Mozilla/5.0 (X11; Linux x86_64; rv:145.0) Gecko/20100101 Firefox/145.0"),
    ).toBe("Firefox 145 on Linux");
    expect(deviceName(null)).toBe("Unknown browser");
    expect(deviceName("curl/8.7.1")).toBe("Unknown browser");
  });

  test("reads a long hostile User-Agent in linear time", () => {
    const digits = "1".repeat(16_000);
    const hostile = [
      `Version/${digits}`,
      `Version/${"1.".repeat(8_000)}x`,
      `Version/1 Mobile/${"a".repeat(16_000)}`,
      `Version/1 ${"Version/1 ".repeat(1_600)}`,
      `Mozilla/5.0 (${"Macintosh ".repeat(1_600)}) Firefox/${digits}`,
      `${"Edg/".repeat(4_000)}${digits}`,
    ];
    for (const userAgent of hostile) {
      // Use the fastest of five because concurrent API tests can pause a run.
      let fastest = Infinity;
      for (let run = 0; run < 5; run += 1) {
        const start = performance.now();
        parseUserAgent(userAgent);
        fastest = Math.min(fastest, performance.now() - start);
      }
      // Guard against quadratic parsing without failing on scheduling delays.
      expect(fastest).toBeLessThan(20);
    }
  });
});
