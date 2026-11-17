import { readFileSync } from "node:fs";

import { describe, expect, test } from "vite-plus/test";

/*
 * Guards the contrast guarantees documented in docs/design-system.md.
 * Reads the :root token block in globals.css, resolves var() references,
 * and checks WCAG 2.x contrast ratios.
 */

const css = readFileSync(new URL("../src/styles/globals.css", import.meta.url), "utf8");
const rootStart = css.indexOf(":root {");
const rootBlock = css.slice(rootStart, css.indexOf("\n}", rootStart));
const tokens = new Map(
  Array.from(rootBlock.matchAll(/--([\w-]+):\s*([^;]+);/g), (match) => [
    match[1] ?? "",
    (match[2] ?? "").trim(),
  ]),
);

function resolveHex(name: string): string {
  let value = tokens.get(name);
  for (let depth = 0; value?.startsWith("var(") && depth < 10; depth += 1) {
    const reference = /^var\(--([\w-]+)\)$/.exec(value)?.[1];
    value = reference === undefined ? undefined : tokens.get(reference);
  }
  if (value === undefined || !/^#[0-9a-f]{6}$/i.test(value)) {
    throw new Error(
      `Token --${name} does not resolve to a 6-digit hex color (got ${String(value)})`,
    );
  }
  return value;
}

function channels(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function linearChannel(channel: number): number {
  const srgb = channel / 255;
  return srgb <= 0.040_45 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const [r, g, b] = channels(hex);
  return 0.2126 * linearChannel(r) + 0.7152 * linearChannel(g) + 0.0722 * linearChannel(b);
}

function contrast(foreground: string, background: string): number {
  const a = luminance(foreground);
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** Composites `color` at `alpha` over `background`, like bg-danger/20 over a card. */
function tint(background: string, color: string, alpha: number): string {
  const [br, bg, bb] = channels(background);
  const [cr, cg, cb] = channels(color);
  const mix = (base: number, top: number) => Math.round(base * (1 - alpha) + top * alpha);
  return `#${[mix(br, cr), mix(bg, cg), mix(bb, cb)]
    .map((channel) => channel.toString(16).padStart(2, "0"))
    .join("")}`;
}

const contentSurfaces = ["background", "card", "popover"];

describe("design tokens", () => {
  test("parses the token block", () => {
    expect(tokens.size).toBeGreaterThan(40);
  });

  describe("body text meets WCAG AA (4.5:1) on every content surface", () => {
    const textTokens = [
      "foreground",
      "ink-muted",
      "muted-foreground",
      "link",
      "destructive",
      "success",
      "warning",
    ];
    for (const text of textTokens) {
      for (const surface of contentSurfaces) {
        test(`${text} on ${surface}`, () => {
          expect(contrast(resolveHex(text), resolveHex(surface))).toBeGreaterThanOrEqual(4.5);
        });
      }
    }
  });

  test.each([
    ["primary-foreground", "primary"],
    ["secondary-foreground", "secondary"],
    ["muted-foreground", "muted"],
    ["sidebar-foreground", "sidebar"],
    ["sidebar-accent-foreground", "sidebar-accent"],
  ])("%s on %s meets 4.5:1", (text, surface) => {
    expect(contrast(resolveHex(text), resolveHex(surface))).toBeGreaterThanOrEqual(4.5);
  });

  test.each([
    ["status-good", 0.15],
    ["status-warning", 0.15],
    ["status-critical", 0.2],
  ])("%s text on its own %s tint meets 4.5:1", (status, alpha) => {
    for (const surface of contentSurfaces) {
      const color = resolveHex(status);
      expect(contrast(color, tint(resolveHex(surface), color, alpha))).toBeGreaterThanOrEqual(4.5);
    }
  });

  test("focus ring meets 3:1 against the surfaces it appears on", () => {
    for (const surface of [...contentSurfaces, "sidebar"]) {
      expect(contrast(resolveHex("ring"), resolveHex(surface))).toBeGreaterThanOrEqual(3);
    }
  });

  test("chart series and status marks meet 3:1 on cards", () => {
    const marks = [
      ...Array.from({ length: 8 }, (_, index) => `chart-${index + 1}`),
      "status-good",
      "status-warning",
      "status-serious",
      "status-critical",
    ];
    for (const mark of marks) {
      expect(contrast(resolveHex(mark), resolveHex("card"))).toBeGreaterThanOrEqual(3);
    }
  });

  test("text on every step of the sequential scale meets 4.5:1, and the steps rise", () => {
    const steps = Array.from({ length: 5 }, (_, index) => resolveHex(`seq-${index + 1}`));
    for (const step of steps) {
      expect(contrast(resolveHex("foreground"), step)).toBeGreaterThanOrEqual(4.5);
    }
    const lightness = steps.map(luminance);
    expect(lightness).toEqual(lightness.toSorted((a, b) => a - b));
    expect(new Set(lightness).size).toBe(steps.length);
  });

  test("link color is not used as a fill behind white text", () => {
    // The link step is too light for white text, so it must stay a text color.
    expect(contrast("#ffffff", resolveHex("link"))).toBeLessThan(4.5);
  });
});
