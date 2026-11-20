import { afterEach, describe, expect, test } from "vite-plus/test";
import { page } from "vite-plus/test/browser/context";

import { THEME_MESSAGE } from "../../src/lib/replay-messages.ts";
import { resetThemeForTests, THEME_STORAGE_KEY } from "../../src/lib/theme.ts";
import { emulateColorScheme } from "./color-scheme.ts";
import { fakeReplayId, installFakeApi, PROJECT } from "./fake-api.ts";
import { unmountAll } from "./mounted.ts";
import { renderApp } from "./render.tsx";

/*
 * The theme (docs/design-system.md, "Color"; docs/dashboard.md, "Account
 * settings"): System, Light or Dark, chosen on the Appearance tab or in the
 * sidebar's user menu, kept on this device, applied before the first paint
 * by public/theme.js, and followed by the charts and the replay player
 * without a reload. Every test starts on a dark device with nothing stored
 * (setup.ts).
 */

const isDark = () => document.documentElement.classList.contains("dark");
const stored = () => window.localStorage.getItem(THEME_STORAGE_KEY);
const radio = (name: string) => page.getByRole("radio", { name, exact: true });

/** The meta tags index.html has, which the test page lacks. */
function addMetaTags() {
  const tags = [
    ["color-scheme", "dark"],
    ["theme-color", "#010101"],
  ].map(([name, content]) => {
    const meta = document.createElement("meta");
    meta.name = name ?? "";
    meta.content = content ?? "";
    document.head.append(meta);
    return meta;
  });
  return () => {
    for (const tag of tags) tag.remove();
  };
}
let removeMetaTags: (() => void) | null = null;

afterEach(() => {
  removeMetaTags?.();
  removeMetaTags = null;
});

describe("the Appearance tab", () => {
  test("switches the theme at once, with no Save, and remembers it on this device", async () => {
    removeMetaTags = addMetaTags();
    installFakeApi();
    renderApp("/account?tab=appearance");

    await expect.element(page.getByRole("heading", { name: "Theme" })).toBeVisible();
    await expect.element(page.getByText(/^Saved on this device only/)).toBeVisible();
    // Nothing stored: System, which follows this (dark) device.
    await expect.element(radio("System")).toBeChecked();
    expect(isDark()).toBe(true);
    // No Save bar: the choice is not a form.
    expect(page.getByRole("button", { name: /^Save/ }).elements()).toHaveLength(0);

    await radio("Light").click();
    await expect.poll(isDark).toBe(false);
    expect(stored()).toBe("light");
    expect(document.documentElement.style.colorScheme).toBe("light");
    expect(document.querySelector('meta[name="color-scheme"]')?.getAttribute("content")).toBe(
      "light",
    );
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute("content")).toBe(
      "#f2eff2",
    );
    expect(getComputedStyle(document.body).backgroundColor).toBe("rgb(242, 239, 242)");

    // As after a reload: the stored choice comes back.
    unmountAll();
    resetThemeForTests();
    expect(isDark()).toBe(false);
    renderApp("/account?tab=appearance");
    await expect.element(radio("Light")).toBeChecked();

    await radio("Dark").click();
    await expect.poll(isDark).toBe(true);
    expect(stored()).toBe("dark");
    expect(getComputedStyle(document.body).backgroundColor).toBe("rgb(1, 1, 1)");

    // System forgets the choice, and follows the device again.
    await radio("System").click();
    await expect.poll(stored).toBeNull();
    expect(isDark()).toBe(true);
  });

  test("System follows the device's color scheme as it changes", async () => {
    installFakeApi();
    renderApp("/account?tab=appearance");
    await expect.element(radio("System")).toBeChecked();
    expect(isDark()).toBe(true);

    await emulateColorScheme("light");
    await expect.poll(isDark).toBe(false);
    await emulateColorScheme("dark");
    await expect.poll(isDark).toBe(true);

    // A choice of Light or Dark holds whatever the device says.
    await radio("Light").click();
    await expect.poll(isDark).toBe(false);
    await emulateColorScheme("dark");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(isDark()).toBe(false);
  });
});

const openMenu = async () => {
  await page.getByRole("button", { name: /Account menu$/ }).click();
  await expect.element(page.getByRole("menu")).toBeVisible();
};
const item = (name: string) => page.getByRole("menuitemradio", { name });

describe("the user menu", () => {
  test("switches the theme, and shows the choice", async () => {
    installFakeApi();
    renderApp(`/projects/${PROJECT.id}/web-analytics`);

    await openMenu();
    await expect.element(item("System")).toHaveAttribute("aria-checked", "true");
    await item("Light").click();
    await expect.poll(isDark).toBe(false);
    expect(stored()).toBe("light");
    await expect.element(item("Light")).toHaveAttribute("aria-checked", "true");
    await expect.element(item("System")).toHaveAttribute("aria-checked", "false");

    await item("Dark").click();
    await expect.poll(isDark).toBe(true);
    expect(stored()).toBe("dark");
  });
});

/**
 * A page like index.html's head, in a frame on this origin: public/theme.js,
 * then an inline script that notes the class and color-scheme as the parser
 * reaches it, before any body, stylesheet or module, so before React.
 */
async function loadHead(): Promise<{ className: string; scheme: string; meta: string }> {
  const frame = document.createElement("iframe");
  frame.srcdoc = `<!doctype html><html class="dark"><head>
    <meta name="color-scheme" content="dark" />
    <meta name="theme-color" content="#010101" />
    <script src="/theme.js"></script>
    <script>
      window.seen = {
        className: document.documentElement.className,
        scheme: document.documentElement.style.colorScheme,
        meta: document.querySelector('meta[name="theme-color"]').content,
      };
    </script></head><body></body></html>`;
  const loaded = new Promise((resolve) => frame.addEventListener("load", resolve));
  document.body.append(frame);
  await loaded;
  const seen = (
    frame.contentWindow as unknown as {
      seen: { className: string; scheme: string; meta: string };
    }
  ).seen;
  frame.remove();
  return seen;
}

describe("before the first paint", () => {
  test("public/theme.js sets the stored theme, or the device's, before the body", async () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "light");
    expect(await loadHead()).toEqual({ className: "", scheme: "light", meta: "#f2eff2" });

    window.localStorage.setItem(THEME_STORAGE_KEY, "dark");
    await emulateColorScheme("light");
    expect(await loadHead()).toEqual({ className: "dark", scheme: "dark", meta: "#010101" });

    // System: the device's.
    window.localStorage.removeItem(THEME_STORAGE_KEY);
    expect((await loadHead()).className).toBe("");
    await emulateColorScheme("dark");
    expect((await loadHead()).className).toBe("dark");

    // Anything else stored is System.
    window.localStorage.setItem(THEME_STORAGE_KEY, "sepia");
    expect((await loadHead()).className).toBe("dark");
  });
});

describe("charts", () => {
  test("re-color when the theme changes, without a reload", async () => {
    installFakeApi();
    renderApp(`/projects/${PROJECT.id}/web-analytics`);
    await expect
      .poll(() => document.querySelector('svg path[stroke="var(--chart-1)"]'))
      .not.toBeNull();
    const line = document.querySelector('svg path[stroke="var(--chart-1)"]');
    if (line === null) throw new Error("no line");
    // chart-1's dark step.
    expect(getComputedStyle(line).stroke).toBe("rgb(57, 135, 229)");

    await page.getByRole("button", { name: /Account menu$/ }).click();
    await page.getByRole("menuitemradio", { name: "Light" }).click();
    await expect.poll(isDark).toBe(false);
    // The same element, now chart-1's light step.
    expect(line.isConnected).toBe(true);
    expect(getComputedStyle(line).stroke).toBe("rgb(42, 120, 214)");
  });
});

describe("the replay player", () => {
  test("opens in the dashboard's theme, and hears when it changes without loading again", async () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "light");
    resetThemeForTests();
    installFakeApi();
    renderApp(`/projects/${PROJECT.id}/replays/${fakeReplayId(0)}`);
    await expect
      .poll(() => document.querySelector("iframe")?.getAttribute("src"))
      .toMatch(/&theme=light$/);
    const frame = document.querySelector("iframe");
    const src = frame?.getAttribute("src");
    // Once the frame's page has loaded (in tests, the API's 404), hear what it is sent.
    await expect
      .poll(
        () =>
          frame?.contentDocument?.URL.includes("/player") === true &&
          frame.contentDocument.readyState === "complete",
      )
      .toBe(true);
    const sent: unknown[] = [];
    frame?.contentWindow?.addEventListener("message", (event) => sent.push(event.data));

    await page.getByRole("button", { name: /Account menu$/ }).click();
    await page.getByRole("menuitemradio", { name: "Dark" }).click();
    await expect.poll(() => sent).toContainEqual({ type: THEME_MESSAGE, theme: "dark" });
    expect(frame?.getAttribute("src")).toBe(src);
  });
});
