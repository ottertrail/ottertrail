import { describe, expect, test } from "vite-plus/test";

import { hostnamesFromText, installSnippet, timeAgo } from "../src/features/projects/format.ts";

describe("installSnippet", () => {
  test("loads the tracker from the instance and sends events back to it", () => {
    expect(installSnippet("https://analytics.example.com", "pk_0123")).toBe(
      '<script defer src="https://analytics.example.com/t.js" data-key="pk_0123" data-host="https://analytics.example.com"></script>',
    );
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
