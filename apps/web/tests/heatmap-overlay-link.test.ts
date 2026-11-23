import { describe, expect, test } from "vite-plus/test";

import {
  isPort,
  overlayUrl,
  popupFeatures,
  siteOrigin,
} from "../src/features/heatmaps/overlay-link.ts";

describe("the overlay's address", () => {
  test("https for a site, http for local names, with a port only there", () => {
    expect(siteOrigin("www.example.com")).toBe("https://www.example.com");
    expect(siteOrigin("www.example.com", "8080")).toBe("https://www.example.com");
    expect(siteOrigin("localhost")).toBe("http://localhost");
    expect(siteOrigin("localhost", "3000")).toBe("http://localhost:3000");
    expect(siteOrigin("127.0.0.1", "8080")).toBe("http://127.0.0.1:8080");
    expect(siteOrigin("shop.localhost", "5173")).toBe("http://shop.localhost:5173");
    // Not a local name: only names that end in ".localhost" are.
    expect(siteOrigin("localhost.example.com")).toBe("https://localhost.example.com");
  });

  test("the token goes in the fragment, which the browser never sends to the site", () => {
    const url = overlayUrl("https://example.com", "/pricing", "tok_en-1");
    expect(url).toBe("https://example.com/pricing#ottertrail-heatmap=tok_en-1");
    // A stored path, which any page can send, never takes the link to another site.
    for (const path of ["//evil.example/x", "/\\evil.example/x", "https://evil.example/"]) {
      const opened = new URL(overlayUrl("https://example.com", path, "t"));
      expect({ path, origin: opened.origin }).toEqual({ path, origin: "https://example.com" });
      expect(opened.hash).toBe("#ottertrail-heatmap=t");
    }
  });

  test("ports from 1 to 65535, or none", () => {
    expect(["", "1", "3000", "65535"].every(isPort)).toBe(true);
    expect(["0", "65536", "30a", " 80", "-1"].some(isPort)).toBe(false);
  });

  test("the window's size fits the screen", () => {
    expect(
      popupFeatures({ width: 1280, height: 900 }, { availWidth: 1024, availHeight: 700 }),
    ).toBe("popup=yes,width=1024,height=700");
  });
});
