import { describe, expect, test } from "vite-plus/test";

import { PLAYER_CSS } from "../src/styles.ts";

/*
 * The player's own colors keep the dashboard's contrast in both themes
 * (docs/design-system.md, "Accessibility"): text 4.5:1 on every surface it
 * sits on, the focus ring 3:1.
 */

function block(selector: string): Map<string, string> {
  const start = PLAYER_CSS.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`No ${selector} block`);
  const body = PLAYER_CSS.slice(start, PLAYER_CSS.indexOf("}", start));
  return new Map(
    Array.from(body.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6});/gi), (match) => [
      match[1] ?? "",
      match[2] ?? "",
    ]),
  );
}

const dark = block(":root");
const themes = {
  dark,
  // The light block sets every color the dark one does.
  light: new Map([...dark, ...block(':root[data-theme="light"]')]),
};

const luminance = (hex: string) => {
  const value = Number.parseInt(hex.slice(1), 16);
  const [r, g, b] = [(value >> 16) & 255, (value >> 8) & 255, value & 255].map((channel) => {
    const srgb = channel / 255;
    return srgb <= 0.040_45 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
};
const contrast = (a: string, b: string) => {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

describe.each(Object.entries(themes))("the %s player", (_name, tokens) => {
  const hex = (name: string) => {
    const value = tokens.get(name);
    if (value === undefined) throw new Error(`--${name} is not set`);
    return value;
  };
  // Where each text color is used: buttons (ink) rest on the raised surface, a hover
  // (hairline) or a pressed fill (hairline-strong); the time and labels (ink-muted)
  // on the bar, the loading message on the canvas; the note (ink-subtle) on the bar.
  const uses = {
    ink: ["canvas", "surface", "surface-raised", "hairline", "hairline-strong"],
    "ink-muted": ["canvas", "surface"],
    "ink-subtle": ["surface"],
  };

  test("sets the same colors as the dark theme", () => {
    expect([...tokens.keys()].toSorted()).toEqual([...dark.keys()].toSorted());
  });

  test.each(Object.entries(uses))("%s text meets 4.5:1 where it is used", (text, surfaces) => {
    for (const surface of surfaces) {
      expect(contrast(hex(text), hex(surface))).toBeGreaterThanOrEqual(4.5);
    }
  });

  test("the error message meets 4.5:1 on the canvas", () => {
    expect(contrast(hex("danger"), hex("canvas"))).toBeGreaterThanOrEqual(4.5);
  });

  test("the focus ring meets 3:1 on the canvas and the controls' surfaces", () => {
    for (const surface of ["canvas", "surface", "surface-raised"]) {
      expect(contrast(hex("brand"), hex(surface))).toBeGreaterThanOrEqual(3);
    }
  });
});
