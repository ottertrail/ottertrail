import { describe, expect, test } from "vite-plus/test";

import {
  type BuiltChunk,
  chunkBudget,
  initialChunks,
  measure,
  overBudget,
} from "../../../scripts/chunk-budget.ts";

const chunk = (
  fileName: string,
  imports: string[],
  code = "x",
  isEntry = false,
  name = fileName.replace(/\.js$/u, ""),
): BuiltChunk => ({
  type: "chunk",
  fileName,
  name,
  isEntry,
  imports,
  code,
});

describe("initialChunks", () => {
  test("is the entry and what it imports statically, each once, never a lazy page", () => {
    const bundle = {
      "index.js": chunk("index.js", ["react.js", "ui.js"], "x", true),
      "react.js": chunk("react.js", []),
      "ui.js": chunk("ui.js", ["react.js"]),
      // Imported only dynamically: not in any static `imports`.
      "overview-page.js": chunk("overview-page.js", ["ui.js", "charts.js"]),
      "charts.js": chunk("charts.js", []),
      "index.css": { type: "asset" as const, fileName: "index.css" },
    };
    expect(
      initialChunks(bundle)
        .map((item) => item.fileName)
        .toSorted(),
    ).toEqual(["index.js", "react.js", "ui.js"]);
  });

  test("measures one entry alone: a shared link's page never counts the dashboard's", () => {
    const bundle = {
      "index.js": chunk("index.js", ["react.js", "router.js"], "x", true),
      "share.js": chunk("share.js", ["react.js"], "x", true),
      "react.js": chunk("react.js", []),
      "router.js": chunk("router.js", []),
    };
    const names = (entry: string) =>
      initialChunks(bundle, entry)
        .map((item) => item.fileName)
        .toSorted();
    expect(names("index")).toEqual(["index.js", "react.js", "router.js"]);
    expect(names("share")).toEqual(["react.js", "share.js"]);
  });
});

describe("overBudget", () => {
  test("passes a size within both limits", () => {
    expect(overBudget({ raw: 700, gzip: 230 }, { raw: 780, gzip: 255 })).toBeNull();
  });

  test.each([[{ raw: 781, gzip: 230 }], [{ raw: 700, gzip: 256 }]])(
    "fails %o, naming the sizes and where the budget is",
    (size) => {
      expect(overBudget(size, { raw: 780, gzip: 255 })).toMatch(
        /over its budget of 780\.0 kB \(255\.0 kB gzipped\).*apps\/web\/vite\.config\.ts/,
      );
    },
  );
});

describe("chunkBudget", () => {
  test("fails the build when the first visit's JavaScript grows past it", () => {
    // 5,001 bytes; repeated text gzips to far under 100 kB.
    const code = "a".repeat(5001);
    const bundle = { "index.js": chunk("index.js", [], code, true) };
    expect(measure(Object.values(bundle)).raw).toBe(5.001);
    const plugin = chunkBudget({ index: { raw: 5, gzip: 100 } });
    expect(() => plugin.generateBundle.handler({}, bundle)).toThrow(
      /first visit to index\.html .*over its budget/,
    );
    expect(() =>
      chunkBudget({ index: { raw: 6, gzip: 100 } }).generateBundle.handler({}, bundle),
    ).not.toThrow();
    // A budget for an entry the build lacks is a mistake, not a pass.
    expect(() =>
      chunkBudget({ share: { raw: 6, gzip: 100 } }).generateBundle.handler({}, bundle),
    ).toThrow(/no entry named share/);
  });
});
