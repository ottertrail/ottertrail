import { describe, expect, test } from "vite-plus/test";

import { isSignedUserId, signUserId } from "../src/collection/identity.ts";

const SECRET = "sk_00000000000000000000000000000001";

describe("user ID signatures", () => {
  test("are HMAC-SHA256 of the ID in UTF-8, in lower-case hex", () => {
    // Worked out with Python's hmac module, apart from this code.
    expect(signUserId(SECRET, "42")).toBe(
      "cd39dcecfe1dab56c3167aadc4175538cc535737786788fb11552b3028d9bbf4",
    );
    expect(signUserId(SECRET, "jürgen/ä")).toBe(
      "6c5ab5b581623c38235d706ae7f01bdbe68707ffb5625685afb0d7026a9a8e6f",
    );
  });

  test("pass only for the same ID and key", () => {
    const signature = signUserId(SECRET, "42");
    expect(isSignedUserId(SECRET, "42", signature)).toBe(true);
    expect(isSignedUserId(SECRET, "43", signature)).toBe(false);
    expect(isSignedUserId("sk_00000000000000000000000000000002", "42", signature)).toBe(false);
    expect(isSignedUserId(SECRET, "42", undefined)).toBe(false);
    expect(isSignedUserId(SECRET, "42", "abc")).toBe(false);
  });

  test("pass in upper-case hex too, which some libraries write", () => {
    expect(isSignedUserId(SECRET, "42", signUserId(SECRET, "42").toUpperCase())).toBe(true);
  });
});
