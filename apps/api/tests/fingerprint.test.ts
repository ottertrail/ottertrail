import { describe, expect, test } from "vite-plus/test";

import {
  fingerprint,
  FINGERPRINT_PATTERN,
  normalizeFile,
  normalizeMessage,
  parseStack,
} from "../src/errors/fingerprint.ts";

const CHROME = `TypeError: Cannot read properties of undefined (reading 'total')
    at renderCart (https://shop.example/assets/index-BfK3x9A2.js:1:2345)
    at async loadCart (https://shop.example/assets/index-BfK3x9A2.js:1:999)
    at new Widget (https://shop.example/assets/widget.js?v=3:10:5)
    at https://shop.example/assets/index-BfK3x9A2.js:2:1
    at Array.forEach (<anonymous>)`;

const FIREFOX = `renderCart@https://shop.example/assets/index-BfK3x9A2.js:1:2345
loadCart@https://shop.example/assets/index-BfK3x9A2.js:1:999
@https://shop.example/assets/index-BfK3x9A2.js:2:1`;

const SAFARI = `renderCart@https://shop.example/assets/index-BfK3x9A2.js:1:2345
global code@https://shop.example/:12:3`;

describe("parseStack", () => {
  test("reads V8's frames, named, anonymous, async, and constructors", () => {
    expect(parseStack(CHROME)).toEqual([
      {
        function: "renderCart",
        file: "https://shop.example/assets/index-BfK3x9A2.js",
        line: 1,
        column: 2345,
      },
      {
        function: "loadCart",
        file: "https://shop.example/assets/index-BfK3x9A2.js",
        line: 1,
        column: 999,
      },
      {
        function: "Widget",
        file: "https://shop.example/assets/widget.js?v=3",
        line: 10,
        column: 5,
      },
      { function: "", file: "https://shop.example/assets/index-BfK3x9A2.js", line: 2, column: 1 },
      { function: "Array.forEach", file: "<anonymous>", line: null, column: null },
    ]);
  });

  test("reads Firefox's and Safari's frames", () => {
    expect(parseStack(FIREFOX).map((frame) => frame.function)).toEqual([
      "renderCart",
      "loadCart",
      "",
    ]);
    expect(parseStack(SAFARI)[1]).toEqual({
      function: "global code",
      file: "https://shop.example/",
      line: 12,
      column: 3,
    });
  });

  test("never takes V8's first line for a frame, even with an @ in the message", () => {
    const stack = `Error: No account for alice@example.com
    at signIn (https://shop.example/assets/index-BfK3x9A2.js:1:10)`;
    expect(parseStack(stack)).toMatchObject([{ function: "signIn", line: 1, column: 10 }]);
    const other = stack.replace("alice@example.com", "bob@example.org");
    expect(fingerprint({ type: "Error", message: "No account for alice@example.com", stack })).toBe(
      fingerprint({ type: "Error", message: "No account for alice@example.com", stack: other }),
    );
  });

  test.each([
    ["at " + " (".repeat(7990) + "\u2028x", "V8 frames that never close"],
    ["@".repeat(15_990) + "\u2028x", "a line of @"],
    ["at https://a.example/" + "_1".repeat(7980), "a file name like a content hash"],
    ["at https://a.example/x" + ":1".repeat(7990), "endless line numbers"],
    [("at f (https://a.example/" + "a".repeat(990) + ")\n").repeat(16), "long frames"],
  ])("reads a hostile 16,000-character stack quickly: %#, %s", (stack, _label) => {
    const started = performance.now();
    fingerprint({ type: "Error", message: "x", stack });
    expect(performance.now() - started).toBeLessThan(20);
  });

  test("finds no frames in text that has none", () => {
    expect(parseStack("")).toEqual([]);
    expect(parseStack("Error: something\nno frames here")).toEqual([]);
  });
});

describe("normalizeFile", () => {
  test.each([
    ["https://shop.example/assets/index-BfK3x9A2.js", "/assets/index.js", "Vite"],
    ["https://cdn.example/static/js/main.3f2a1c9d.js", "/static/js/main.js", "webpack"],
    [
      "https://shop.example/_next/static/chunks/page-1a2b3c4d5e6f.js",
      "/_next/static/chunks/page.js",
      "Next.js",
    ],
    ["https://shop.example/assets/widget.js?v=3#x", "/assets/widget.js", "query and fragment"],
    [
      "https://shop.example/assets/index-component.js",
      "/assets/index-component.js",
      "a name without digits",
    ],
    ["https://shop.example/app-v2.js", "/app-v2.js", "a short suffix"],
    ["<anonymous>", "<anonymous>", "not a URL"],
  ])("%s → %s (%s)", (file, expected) => {
    expect(normalizeFile(file)).toBe(expected);
  });
});

describe("normalizeMessage", () => {
  test.each([
    ["Order 8f2a7c1e-0d3b-4b8e-9a51-2c6d7e8f9a0b not found", "Order <id> not found"],
    ["Request to https://api.example/v1/orders/123?x=1 failed", "Request to <url> failed"],
    ["Item 48213 is out of stock", "Item <n> is out of stock"],
    ["Token deadbeef42 expired", "Token <id> expired"],
    ["Request failed with status code 404", "Request failed with status code 404"],
    ["  Two\n  lines  ", "Two lines"],
  ])("%j → %j", (message, expected) => {
    expect(normalizeMessage(message)).toBe(expected);
  });
});

describe("fingerprint", () => {
  const base = {
    type: "TypeError",
    message: "Cannot read properties of undefined (reading 'total')",
    stack: CHROME,
  };

  test("is versioned, and matches what the routes accept", () => {
    expect(fingerprint(base)).toMatch(new RegExp(FINGERPRINT_PATTERN));
    expect(fingerprint(base).startsWith("1-")).toBe(true);
  });

  test("stays the same across deploys: new bundle hashes, lines, and function names", () => {
    const redeployed = CHROME.replaceAll("index-BfK3x9A2.js", "index-Zq81LmP0.js")
      .replace("1:2345", "1:8812")
      .replace("renderCart", "a");
    expect(fingerprint({ ...base, stack: redeployed })).toBe(fingerprint(base));
  });

  test("stays the same when only IDs in the message differ", () => {
    const one = { type: "Error", message: "Order 48213 not found", stack: CHROME };
    const other = { type: "Error", message: "Order 99120 not found", stack: CHROME };
    expect(fingerprint(one)).toBe(fingerprint(other));
  });

  test("tells apart another type, another message, or another file", () => {
    const seen = new Set([
      fingerprint(base),
      fingerprint({ ...base, type: "ReferenceError" }),
      fingerprint({ ...base, message: "Cannot read properties of undefined (reading 'items')" }),
      fingerprint({
        ...base,
        stack: CHROME.replace("index-BfK3x9A2.js:1:2345", "checkout.js:1:1"),
      }),
      fingerprint({ ...base, stack: "" }),
    ]);
    expect(seen.size).toBe(5);
  });

  test("is the same for a stack from Firefox as from Safari at the same place", () => {
    const firefox = { type: "TypeError", message: "x is undefined", stack: FIREFOX };
    expect(fingerprint(firefox)).toBe(fingerprint({ ...firefox, stack: SAFARI }));
  });
});
