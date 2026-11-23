import { readFileSync } from "node:fs";

import { expect, test } from "vite-plus/test";

import { THEME_COLORS, THEME_STORAGE_KEY } from "../src/lib/theme.ts";

/*
 * Guard pre-paint theme loading under the Content Security Policy and keep
 * public/theme.js consistent with src/lib/theme.ts and globals.css
 * (docs/design-system.md, "Color").
 */

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const html = read("../index.html");
const script = read("../public/theme.js");
const css = read("../src/styles/globals.css");

test("index.html runs public/theme.js in its head, before the app, without waiting", () => {
  const head = html.slice(html.indexOf("<head>"), html.indexOf("</head>"));
  const tag = '<script src="/theme.js"></script>';
  expect(head).toContain(tag);
  expect(head.indexOf(tag)).toBeGreaterThan(head.indexOf('name="theme-color"'));
  expect(head.indexOf(tag)).toBeGreaterThan(head.indexOf('name="color-scheme"'));
  expect(html.indexOf(tag)).toBeLessThan(html.indexOf('type="module"'));
});

test("index.html has no inline script, which the Content Security Policy (script-src 'self') would block", () => {
  for (const match of html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)) {
    expect(match[1]).toMatch(/\ssrc="/);
    expect(match[2]?.trim()).toBe("");
  }
});

test("public/theme.js reads the same key and writes the same colors as src/lib/theme.ts", () => {
  expect(script).toContain(`"${THEME_STORAGE_KEY}"`);
  expect(script).toContain(`"${THEME_COLORS.dark}"`);
  expect(script).toContain(`"${THEME_COLORS.light}"`);
  expect(script).toContain('"(prefers-color-scheme: dark)"');
});

const canvas = (selector: string) => {
  const start = css.indexOf(`\n${selector} {`);
  return /--canvas:\s*(#[0-9a-f]{6})/.exec(css.slice(start))?.[1];
};

test("the browser's bar (theme-color) is each theme's canvas", () => {
  expect(canvas(":root")).toBe(THEME_COLORS.dark);
  expect(canvas(":root:not(.dark)")).toBe(THEME_COLORS.light);
  expect(html).toContain(`<meta name="theme-color" content="${THEME_COLORS.dark}" />`);
});
