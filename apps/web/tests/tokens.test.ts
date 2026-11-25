import { readFileSync } from "node:fs";

import { describe, expect, test } from "vite-plus/test";

/*
 * Guard WCAG 2.x contrast ratios in both themes (docs/design-system.md).
 * Light tokens inherit omitted dark values; resolve var() within each theme.
 */

const css = readFileSync(new URL("../src/styles/globals.css", import.meta.url), "utf8");

function tokenBlock(selector: string): Map<string, string> {
  const start = css.indexOf(`\n${selector} {`);
  if (start === -1) throw new Error(`No ${selector} block in globals.css`);
  const block = css.slice(start, css.indexOf("\n}", start + 1));
  return new Map(
    Array.from(block.matchAll(/--([\w-]+):\s*([^;]+);/g), (match) => [
      match[1] ?? "",
      (match[2] ?? "").trim(),
    ]),
  );
}

const darkTokens = tokenBlock(":root");
const lightTokens = new Map([...darkTokens, ...tokenBlock(":root:not(.dark)")]);

type Theme = "dark" | "light";
const themes: Record<Theme, Map<string, string>> = { dark: darkTokens, light: lightTokens };

function resolver(tokens: Map<string, string>) {
  return (name: string): string => {
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
  };
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

test("parses both token blocks", () => {
  expect(darkTokens.size).toBeGreaterThan(40);
  expect(lightTokens.size).toBe(darkTokens.size);
  expect(tokenBlock(":root:not(.dark)").size).toBeGreaterThan(25);
});

test("the light theme sets a value of its own for every color the dark one writes as hex", () => {
  const light = tokenBlock(":root:not(.dark)");
  const hexTokens = [...darkTokens].filter(([, value]) => /^#[0-9a-f]{6}$/i.test(value));
  // White text on the brand, and the brand itself, are the same in both themes.
  const shared = new Set(["brand", "primary-foreground", "sidebar-primary-foreground"]);
  for (const [name] of hexTokens) {
    if (shared.has(name)) continue;
    expect(light.has(name), `--${name} has no light value`).toBe(true);
  }
});

describe.each(["dark", "light"] as const)("the %s theme's tokens", (theme: Theme) => {
  const resolveHex = resolver(themes[theme]);

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
      for (const surface of [...contentSurfaces, "canvas"]) {
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

  // StatusBadge (components/status-badge.tsx): the text color on a tint of the status mark.
  test.each([
    ["success", "status-good", 0.15],
    ["warning", "status-warning", 0.15],
    ["danger", "status-critical", 0.2],
  ])("%s text on a %s tint at %s meets 4.5:1", (text, status, alpha) => {
    for (const surface of contentSurfaces) {
      const fill = tint(resolveHex(surface), resolveHex(status), alpha);
      expect(contrast(resolveHex(text), fill)).toBeGreaterThanOrEqual(4.5);
    }
  });

  // Covers instance, project-switcher, and user-avatar initials.
  test("an initial's square stands apart from the sidebar, and its letter meets 4.5:1", () => {
    expect(contrast(resolveHex("hairline-strong"), resolveHex("sidebar"))).toBeGreaterThanOrEqual(
      1.3,
    );
    expect(contrast(resolveHex("ink"), resolveHex("hairline-strong"))).toBeGreaterThanOrEqual(4.5);
  });

  test("focus ring meets 3:1 against the surfaces it appears on", () => {
    for (const surface of [...contentSurfaces, "canvas", "sidebar"]) {
      expect(contrast(resolveHex("ring"), resolveHex(surface))).toBeGreaterThanOrEqual(3);
    }
  });

  // Unselected neighbors are transparent or muted on hover
  // (components/ui/toggle.tsx).
  describe("a toggle group's chosen item stands out (WCAG 1.4.11)", () => {
    for (const surface of [...contentSurfaces, "canvas", "muted"]) {
      test(`its fill meets 3:1 against ${surface}`, () => {
        expect(contrast(resolveHex("toggle-on"), resolveHex(surface))).toBeGreaterThanOrEqual(3);
      });
    }
    test("its text meets 4.5:1 on its fill", () => {
      expect(
        contrast(resolveHex("toggle-on-foreground"), resolveHex("toggle-on")),
      ).toBeGreaterThanOrEqual(4.5);
    });
  });

  // Dark fields use input-fill at 30% or 50% (components/ui/input.tsx, select.tsx).
  // Surface checks cover transparent light fields. WCAG exempts disabled fields (80%).
  const fieldStates = [
    ["at rest", 0.3],
    ["on hover", 0.5],
  ] as const;

  describe("field edges meet 3:1 (WCAG 1.4.11)", () => {
    for (const surface of contentSurfaces) {
      test(`against ${surface}`, () => {
        expect(contrast(resolveHex("input"), resolveHex(surface))).toBeGreaterThanOrEqual(3);
      });
      for (const [state, alpha] of fieldStates) {
        test(`against the field's own fill ${state}, on ${surface}`, () => {
          const fill = tint(resolveHex(surface), resolveHex("input-fill"), alpha);
          expect(contrast(resolveHex("input"), fill)).toBeGreaterThanOrEqual(3);
        });
      }
    }
  });

  test("the wash inside a field stays a quiet step off its surface, not a second edge", () => {
    for (const surface of contentSurfaces) {
      for (const [, alpha] of fieldStates) {
        const fill = tint(resolveHex(surface), resolveHex("input-fill"), alpha);
        // Visible as a fill, but far below the edge, so the edge carries the boundary.
        expect(contrast(fill, resolveHex(surface))).toBeGreaterThan(1.03);
        expect(contrast(fill, resolveHex(surface))).toBeLessThan(1.5);
      }
    }
  });

  test("a switch's unchecked track (input) and its thumb meet 3:1", () => {
    for (const surface of contentSurfaces) {
      expect(contrast(resolveHex("input"), resolveHex(surface))).toBeGreaterThanOrEqual(3);
    }
    // Match components/ui/switch.tsx's theme-dependent thumb.
    const thumb = theme === "dark" ? "foreground" : "background";
    expect(contrast(resolveHex(thumb), resolveHex("input"))).toBeGreaterThanOrEqual(3);
    expect(contrast(resolveHex("background"), resolveHex("primary"))).toBeGreaterThanOrEqual(3);
  });

  test("chart series and status marks meet 3:1 on cards and on the panel", () => {
    const marks = [
      ...Array.from({ length: 8 }, (_, index) => `chart-${index + 1}`),
      "chart-neutral",
      "ink-tertiary",
      "status-good",
      "status-warning",
      "status-serious",
      "status-critical",
    ];
    for (const mark of marks) {
      for (const surface of ["card", "background"]) {
        expect(
          contrast(resolveHex(mark), resolveHex(surface)),
          `${mark} on ${surface}`,
        ).toBeGreaterThanOrEqual(3);
      }
    }
  });

  test("a meter's fill (chart-1) meets 3:1 on its track (seq-1)", () => {
    expect(contrast(resolveHex("chart-1"), resolveHex("seq-1"))).toBeGreaterThanOrEqual(3);
  });

  test("each step's text color on the sequential scale meets 4.5:1, and a larger value stands out more", () => {
    const steps = Array.from({ length: 7 }, (_, index) => resolveHex(`seq-${index + 1}`));
    steps.forEach((step, index) => {
      expect(
        contrast(resolveHex(`on-seq-${index + 1}`), step),
        `on-seq-${index + 1}`,
      ).toBeGreaterThanOrEqual(4.5);
    });
    // Away from the surface: lighter on the dark theme, darker on the light one.
    const lightness = steps.map(luminance);
    const order =
      theme === "dark" ? (a: number, b: number) => a - b : (a: number, b: number) => b - a;
    expect(lightness).toEqual(lightness.toSorted(order));
    expect(new Set(lightness).size).toBe(steps.length);
    const card = luminance(resolveHex("card"));
    const distance = lightness.map((value) => Math.abs(value - card));
    expect(distance).toEqual(distance.toSorted((a, b) => a - b));
  });
});

test("the dark link color is not used as a fill behind white text", () => {
  // The dark link step is too light for white text, so it must stay a text color.
  expect(contrast("#ffffff", resolver(darkTokens)("link"))).toBeLessThan(4.5);
});

// AA contrast alone can leave selection hard to see; require a stronger
// difference from every surface and the hover fill.
test("the light theme's chosen toggle stands well apart (7:1 or more)", () => {
  const resolveHex = resolver(themes.light);
  for (const surface of ["background", "card", "popover", "canvas", "muted"]) {
    expect(contrast(resolveHex("toggle-on"), resolveHex(surface))).toBeGreaterThanOrEqual(7);
  }
});
