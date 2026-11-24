import { describe, expect, test } from "vite-plus/test";

import {
  hostnamesFromText,
  installSnippet,
  setupPrompt,
  timeAgo,
} from "../src/features/projects/format.ts";

describe("installSnippet", () => {
  test("loads the tracker from the instance and sends events back to it", () => {
    expect(installSnippet("https://ottertrail.example.com", "pk_0123")).toBe(
      '<script defer src="https://ottertrail.example.com/t.js" data-key="pk_0123" data-host="https://ottertrail.example.com"></script>',
    );
  });

  test("asks the tracker for heatmaps when the project has them on", () => {
    expect(installSnippet("https://ottertrail.example.com", "pk_0123", { heatmaps: true })).toBe(
      '<script defer src="https://ottertrail.example.com/t.js" data-key="pk_0123" data-host="https://ottertrail.example.com" data-heatmaps="on"></script>',
    );
    expect(installSnippet("https://ottertrail.example.com", "pk_0123", { heatmaps: false })).toBe(
      '<script defer src="https://ottertrail.example.com/t.js" data-key="pk_0123" data-host="https://ottertrail.example.com"></script>',
    );
  });
});

describe("setupPrompt", () => {
  test("asks for heatmaps and readable element names only when the project has them on", () => {
    const off = setupPrompt("https://ottertrail.example.com", "pk_0123");
    expect(off).not.toContain("data-heatmaps");
    expect(off).not.toContain("data-ottertrail-name");
    const on = setupPrompt("https://ottertrail.example.com", "pk_0123", { heatmaps: true });
    expect(on.startsWith(off)).toBe(true);
    expect(on).toContain('add data-heatmaps="on" to the tracker\'s script tag');
    expect(on).toContain("data-ottertrail-name");
    expect(on).toContain("never put personal data in a name");
  });
});

describe("hostnamesFromText", () => {
  test("reads one hostname per line or comma-separated, and keeps only the hostname of an address", () => {
    expect(
      hostnamesFromText(" example.com\n\nhttps://www.example.com/pricing?x=1, docs.example.com "),
    ).toEqual(["example.com", "www.example.com", "docs.example.com"]);
  });

  test("leaves other entries for the API to check", () => {
    expect(hostnamesFromText("example.com/pricing")).toEqual(["example.com/pricing"]);
  });
});

describe("timeAgo", () => {
  const now = new Date("2026-11-16T12:00:00Z");
  test.each([
    ["2026-11-16T11:59:30Z", "just now"],
    ["2026-11-16T11:55:00Z", "5 minutes ago"],
    ["2026-11-16T09:00:00Z", "3 hours ago"],
    ["2026-11-15T11:00:00Z", "yesterday"],
    ["2026-11-10T12:00:00Z", "6 days ago"],
  ])("%s is %j", (iso, expected) => {
    expect(timeAgo(new Date(iso), now)).toBe(expected);
  });
});
