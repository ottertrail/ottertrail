import * as React from "react";

/**
 * Per-device theme (docs/design-system.md, "Color"). Keep the storage key and colors aligned
 * with public/theme.js, which applies the theme before first paint.
 */
export type ThemeChoice = "system" | "light" | "dark";
export type Theme = "light" | "dark";

export const THEME_CHOICES: readonly ThemeChoice[] = ["system", "light", "dark"];

/** The localStorage key, also read by public/theme.js. */
export const THEME_STORAGE_KEY = "ottertrail-theme";

/** The browser's own bars (`theme-color`): each theme's canvas, as in globals.css. */
export const THEME_COLORS: Record<Theme, string> = { dark: "#010101", light: "#f2eff2" };

const DARK_QUERY = "(prefers-color-scheme: dark)";

export const isThemeChoice = (value: unknown): value is ThemeChoice =>
  typeof value === "string" && (THEME_CHOICES as readonly string[]).includes(value);

/** The stored choice; System when none is stored, or storage cannot be read. */
export function readThemeChoice(): ThemeChoice {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isThemeChoice(stored) ? stored : "system";
  } catch {
    return "system";
  }
}

function systemTheme(): Theme {
  return window.matchMedia(DARK_QUERY).matches ? "dark" : "light";
}

export const resolveTheme = (choice: ThemeChoice): Theme =>
  choice === "system" ? systemTheme() : choice;

export function applyTheme(theme: Theme, doc: Document = document) {
  const root = doc.documentElement;
  root.classList.toggle("dark", theme === "dark");
  root.style.colorScheme = theme;
  doc.querySelector('meta[name="color-scheme"]')?.setAttribute("content", theme);
  doc.querySelector('meta[name="theme-color"]')?.setAttribute("content", THEME_COLORS[theme]);
}

interface ThemeState {
  choice: ThemeChoice;
  theme: Theme;
}

const listeners = new Set<() => void>();
let state: ThemeState | null = null;

function current(): ThemeState {
  if (state === null) {
    const choice = readThemeChoice();
    state = { choice, theme: resolveTheme(choice) };
  }
  return state;
}

function update(choice: ThemeChoice) {
  const theme = resolveTheme(choice);
  const previous = current();
  applyTheme(theme);
  if (previous.choice === choice && previous.theme === theme) return;
  state = { choice, theme };
  for (const listener of listeners) listener();
}

/** Chooses a theme: applied at once, and remembered on this device when storage allows. */
export function setThemeChoice(choice: ThemeChoice) {
  try {
    if (choice === "system") window.localStorage.removeItem(THEME_STORAGE_KEY);
    else window.localStorage.setItem(THEME_STORAGE_KEY, choice);
  } catch {
    // Private windows and full storage: the choice holds until the page closes.
  }
  update(choice);
}

let watching = false;

/** Watch system scheme changes and choices made in other tabs; apply the stored choice on startup. */
export function watchTheme() {
  if (watching) return;
  watching = true;
  update(current().choice);
  window.matchMedia(DARK_QUERY).addEventListener("change", () => {
    if (current().choice === "system") update("system");
  });
  window.addEventListener("storage", (event) => {
    if (event.key === THEME_STORAGE_KEY || event.key === null) update(readThemeChoice());
  });
}

function subscribe(listener: () => void) {
  watchTheme();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useTheme(): ThemeState {
  return React.useSyncExternalStore(subscribe, current);
}

/** Forgets the module's state, for tests that change storage or the media query between cases. */
export function resetThemeForTests() {
  state = null;
  update(readThemeChoice());
}
