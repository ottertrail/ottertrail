import { describe, expect, test, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser/context";

import { installFakeApi, PROJECT } from "./fake-api.ts";
import { currentPath, renderApp } from "./render.tsx";

/*
 * Each page loads in a chunk of its own (docs/dashboard.md, "Code
 * splitting"). Here modules are replaced: the Speed page waits until the
 * test lets it load; the Members page's and the custom range
 * dialog's fail as a file an old tab asks for after a deploy does (the
 * browser's TypeError); the instance Settings page's throws while it runs,
 * as a bug would. Reloading is replaced too, to see that Reload asks for it.
 */

const FAILED_FETCH = "Failed to fetch dynamically imported module";

const reload = vi.hoisted(() => ({ calls: 0 }));

vi.mock("../../src/lib/reload.ts", () => ({
  reloadPage: () => {
    reload.calls += 1;
  },
}));

const speed = vi.hoisted(() => {
  const gate = { requested: false, release: (): void => undefined };
  const released = new Promise<void>((resolve) => {
    gate.release = resolve;
  });
  return Object.assign(gate, { released });
});

vi.mock("../../src/features/speed/speed-page.tsx", async (importOriginal) => {
  speed.requested = true;
  await speed.released;
  return await importOriginal();
});

vi.mock("../../src/features/settings/members-page.tsx", () => {
  throw new TypeError(`${FAILED_FETCH}: https://ottertrail.example/assets/members-page-old.js`);
});

vi.mock("../../src/features/analytics/custom-range-dialog.tsx", () => {
  throw new TypeError(`${FAILED_FETCH}: https://ottertrail.example/assets/custom-range-old.js`);
});

vi.mock("../../src/features/settings/settings-page.tsx", () => {
  throw new TypeError("Cannot read properties of undefined (reading 'timeZone')");
});

/** Collects what React reports of an error a route caught; anything else logged still fails the test. */
function captureErrors(): unknown[][] {
  const logged: unknown[][] = [];
  vi.mocked(console.error).mockImplementation((...args: unknown[]) => {
    logged.push(args);
  });
  return logged;
}

const workspaceMenu = () => page.getByRole("navigation", { name: "Instance" });
const projectMenu = () => page.getByRole("navigation", { name: "Project" });
const ANALYTICS = `/projects/${PROJECT.id}/web-analytics`;
const LCP = "Largest Contentful Paint (LCP), p75";

describe("a page in a chunk of its own", () => {
  test("loads on a link's hover, shows a skeleton in the shell while it downloads, then the page", async () => {
    installFakeApi();
    const router = renderApp(ANALYTICS);
    const link = projectMenu().getByRole("link", { name: "Speed" });
    await expect.element(link).toBeVisible();
    expect(speed.requested).toBe(false);

    await link.hover();
    await expect.poll(() => speed.requested).toBe(true);
    expect(currentPath(router)).toBe(ANALYTICS);

    await link.click();
    const pending = page.getByRole("status", { name: "Loading the page" });
    await expect.element(pending, { timeout: 3000 }).toBeVisible();
    // The shell stays while the page downloads: the menu, and the header's breadcrumb.
    await expect.element(projectMenu()).toBeVisible();
    await expect.element(page.getByRole("navigation", { name: "Breadcrumb" })).toBeVisible();
    await expect.element(page.getByText(LCP, { exact: true })).not.toBeInTheDocument();

    speed.release();

    await expect.element(page.getByText(LCP, { exact: true }), { timeout: 3000 }).toBeVisible();
    await expect.element(pending).not.toBeInTheDocument();
    expect(currentPath(router)).toBe(`/projects/${PROJECT.id}/speed`);
  });

  test("whose code fails to download says so in the shell, and Reload reloads", async () => {
    const logged = captureErrors();
    reload.calls = 0;
    installFakeApi();
    renderApp("/settings/members");

    const alert = page.getByRole("alert");
    await expect.element(alert.getByText("This page could not load")).toBeVisible();
    await expect.element(alert.getByText(/The page download failed/)).toBeVisible();
    // The browser's own reason, as it gave it.
    await expect.element(alert.getByText(/members-page-old\.js/)).toBeVisible();
    // Not a white screen: the shell is still there, so another page is a click away.
    await expect.element(workspaceMenu().getByRole("link", { name: "Projects" })).toBeVisible();

    await alert.getByRole("button", { name: "Reload" }).click();
    expect(reload.calls).toBe(1);
    expect(logged.length).toBeGreaterThan(0);
    for (const args of logged) {
      expect(args.map(String).join(" ")).toMatch(/PageLoadError|could not be downloaded/);
    }
  });

  test("whose code throws while it runs shows that error, not the deploy message", async () => {
    const logged = captureErrors();
    reload.calls = 0;
    installFakeApi();
    renderApp("/settings");

    const alert = page.getByRole("alert");
    await expect.element(alert.getByText("Something went wrong")).toBeVisible();
    await expect.element(page.getByText("This page could not load")).not.toBeInTheDocument();
    await expect.element(page.getByText(/may have been updated/)).not.toBeInTheDocument();
    await expect.element(workspaceMenu().getByRole("link", { name: "Projects" })).toBeVisible();

    await alert.getByRole("button", { name: "Reload" }).click();
    expect(reload.calls).toBe(1);
    expect(logged.length).toBeGreaterThan(0);
    // What React reported is the module's own error (inside Vitest's wrapper), not a PageLoadError.
    for (const args of logged) {
      const error = args.find((arg) => arg instanceof Error);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toHaveProperty("name", "PageLoadError");
      expect(String(error instanceof Error ? error.cause : undefined)).toMatch(
        /reading 'timeZone'/,
      );
    }
  });
});

describe("the custom range dialog", () => {
  test("whose code fails to download says so in a dialog, and the page stays", async () => {
    reload.calls = 0;
    installFakeApi();
    renderApp(`/projects/${PROJECT.id}/errors`);

    await page.getByRole("combobox", { name: "Period" }).click();
    await page.getByRole("option", { name: /^Custom range/ }).click();

    const dialog = page.getByRole("dialog", { name: "The calendar could not load" });
    await expect.element(dialog).toBeVisible();
    await expect.element(dialog.getByText(/The calendar download failed/)).toBeVisible();
    await dialog.getByRole("button", { name: "Reload" }).click();
    expect(reload.calls).toBe(1);

    await dialog.getByRole("button", { name: "Close" }).click();
    await expect.element(dialog).not.toBeInTheDocument();
    // The page is still there, with its period picker.
    await expect.element(page.getByRole("combobox", { name: "Period" })).toBeVisible();
  });
});
