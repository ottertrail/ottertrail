import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser/context";

import { resetThemeForTests } from "../../src/lib/theme.ts";
import { emulateColorScheme } from "./color-scheme.ts";
import { installFakeApi, PROJECT } from "./fake-api.ts";
import { currentPath, renderApp } from "./render.tsx";

/*
 * The states that replace a page (docs/dashboard.md, "Not found and
 * errors"): the 404 for an address no route has and for a project that
 * cannot be opened, and the errors by their kind, in the shell when it is
 * there and alone in the sign-in panel before it. The page's code that
 * fails to download (Ottertrail was updated) is in lazy-routes.test.tsx,
 * which replaces modules.
 */

const reload = vi.hoisted(() => ({ calls: 0 }));

vi.mock("../../src/lib/reload.ts", () => ({
  reloadPage: () => {
    reload.calls += 1;
  },
}));

const workspaceMenu = () => page.getByRole("navigation", { name: "Instance" });
const heading = (name: string, level: 1 | 2) => page.getByRole("heading", { name, level });
const focusedText = () => document.activeElement?.textContent;

/** Collects what React and the router report of an error a route caught. */
function captureErrors(): unknown[][] {
  const logged: unknown[][] = [];
  vi.mocked(console.error).mockImplementation((...args: unknown[]) => {
    logged.push(args);
  });
  return logged;
}

/** An sRGB channel (0 to 255) in linear light. */
function linear(channel: number): number {
  const c = channel / 255;
  return c <= 0.040_45 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** Relative luminance of a computed `rgb()` color, 0 (black) to 1 (white). */
function luminance(color: string): number {
  const [r = 0, g = 0, b = 0] = (color.match(/[\d.]+/g) ?? []).map(Number);
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

beforeEach(async () => {
  reload.calls = 0;
  await page.viewport(1280, 900);
});

describe("an address no route has", () => {
  test("signed in, shows the 404 in the shell, with the address and the way on", async () => {
    installFakeApi();
    const router = renderApp("/no-such-page?from=email");

    await expect.element(heading("Page not found", 2)).toBeVisible();
    // The shell stays: the menu, and the header's h1.
    await expect.element(workspaceMenu().getByRole("link", { name: "Projects" })).toBeVisible();
    await expect.element(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect.element(page.getByText("/no-such-page?from=email")).toBeVisible();
    await expect.poll(() => document.title).toBe(`Page not found – Ottertrail`);
    // The address stays as it was asked for.
    expect(currentPath(router)).toBe("/no-such-page?from=email");
    // On the page's first load nothing is announced and focus stays put; nothing to go back to.
    expect(focusedText()).not.toBe("Page not found");
    await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "Go back" })).not.toBeInTheDocument();

    await page.getByRole("link", { name: "Go to projects" }).click();
    await expect.poll(() => currentPath(router)).toBe("/projects");
    await expect.element(page.getByRole("link", { name: "Main site", exact: true })).toBeVisible();
    // The tab's title is the page's again.
    await expect.poll(() => document.title).toBe(`Projects – Ottertrail`);
  });

  test("reached by a link, takes focus to its heading, and Go back returns", async () => {
    installFakeApi();
    const router = renderApp("/projects");
    await expect.element(page.getByRole("link", { name: "Main site", exact: true })).toBeVisible();

    router.history.push("/nothing-here");
    await expect.element(heading("Page not found", 2)).toBeVisible();
    await expect.poll(focusedText).toBe("Page not found");

    // The actions are next by keyboard, in order.
    await userEvent.keyboard("{Tab}");
    expect(focusedText()).toBe("Go to projects");
    await userEvent.keyboard("{Tab}");
    expect(focusedText()).toBe("Go back");
    await userEvent.keyboard("{Enter}");
    await expect.poll(() => currentPath(router)).toBe("/projects");
    await expect.element(heading("Page not found", 2)).not.toBeInTheDocument();
  });

  test("inside a project, shows the 404 in the shell under the project", async () => {
    installFakeApi();
    renderApp(`/projects/${PROJECT.id}/not-a-page`);

    await expect.element(heading("Page not found", 2)).toBeVisible();
    await expect.element(page.getByRole("navigation", { name: "Project" })).toBeVisible();
    await expect.element(page.getByText(`/projects/${PROJECT.id}/not-a-page`)).toBeVisible();
  });

  test("signed out, shows the 404 alone in the panel, not sign-in", async () => {
    installFakeApi({ signedIn: false });
    const router = renderApp("/no-such-page");

    await expect.element(heading("Page not found", 1)).toBeVisible();
    await expect.element(page.getByText("/no-such-page")).toBeVisible();
    await expect.element(page.getByText("Ottertrail", { exact: true })).toBeVisible();
    await expect.element(workspaceMenu()).not.toBeInTheDocument();
    expect(currentPath(router)).toBe("/no-such-page");

    // Projects needs signing in.
    await page.getByRole("link", { name: "Go to projects" }).click();
    await expect.poll(() => currentPath(router)).toBe("/sign-in");
    await expect.element(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  });

  test("fits a phone, the long address cut off with an ellipsis", async () => {
    await page.viewport(390, 844);
    installFakeApi();
    const long = `/reports/${"quarterly-revenue-by-region-".repeat(6)}final`;
    renderApp(long);

    await expect.element(heading("Page not found", 2)).toBeVisible();
    await expect.element(page.getByRole("link", { name: "Go to projects" })).toBeVisible();
    const address = page.getByText(long).element();
    expect(address.scrollWidth).toBeGreaterThan(address.clientWidth);
    expect(address.getBoundingClientRect().right).toBeLessThanOrEqual(390);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
  });

  test("reads in both themes", async () => {
    installFakeApi();
    renderApp("/no-such-page");
    const title = heading("Page not found", 2);
    await expect.element(title).toBeVisible();
    const color = () => getComputedStyle(title.element()).color;

    // Every test starts on a dark device: light text on the dark panel.
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(luminance(color())).toBeGreaterThan(0.5);

    await emulateColorScheme("light");
    resetThemeForTests();
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    await expect.poll(() => luminance(color())).toBeLessThan(0.2);
  });
});

describe("a project that cannot be opened", () => {
  test("shows the 404 with its own title and why, in the shell", async () => {
    installFakeApi();
    const router = renderApp("/projects/33333333-3333-4333-8333-333333333333/settings");

    await expect.element(heading("Project not found", 2)).toBeVisible();
    await expect
      .element(page.getByText("It may have been deleted, or you may not have access."))
      .toBeVisible();
    await expect.element(page.getByText("404", { exact: true })).toBeVisible();
    await expect.poll(() => document.title).toBe(`Project not found – Ottertrail`);

    await page.getByRole("main").getByRole("link", { name: "Go to projects" }).click();
    await expect.poll(() => currentPath(router)).toBe("/projects");
  });
});

describe("the session check failing", () => {
  test("with no answer at all: Can't reach the server, and Try again checks again", async () => {
    const logged = captureErrors();
    const api = installFakeApi({ sessionRefusal: "network" });
    const router = renderApp("/projects");

    // Before the shell: alone in the panel.
    await expect.element(heading("Can't reach the server", 1)).toBeVisible();
    await expect.element(workspaceMenu()).not.toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "Reload" })).toBeVisible();
    expect(document.title).toBe("Can't reach the server – Ottertrail");
    // On the first load the page is the error: no alert to interrupt with.
    await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
    // The detail waits, collapsed, under Details.
    const detail = page.getByText("Could not reach the API to check your session.");
    await expect.element(detail).not.toBeVisible();
    await page.getByText("Details").click();
    await expect.element(detail).toBeVisible();

    // The API is back: Try again runs the check in place, with no reload.
    api.sessionRefusal = null;
    await page.getByRole("button", { name: "Try again" }).click();
    await expect.element(page.getByRole("link", { name: "Main site", exact: true })).toBeVisible();
    await expect.element(heading("Can't reach the server", 1)).not.toBeInTheDocument();
    expect(reload.calls).toBe(0);
    expect(currentPath(router)).toBe("/projects");
    expect(logged.length).toBeGreaterThan(0);
  });

  test("answered 502 by the proxy: Can't reach the server, with the status under Details", async () => {
    captureErrors();
    installFakeApi({ sessionRefusal: 502 });
    renderApp("/projects");

    await expect.element(heading("Can't reach the server", 1)).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Try again" })).toBeVisible();
    await page.getByText("Details").click();
    await expect.element(page.getByText(/^HTTP 502:/)).toBeVisible();

    await page.getByRole("button", { name: "Reload" }).click();
    expect(reload.calls).toBe(1);
  });

  test("Try again that fails again keeps the error, and announces it", async () => {
    captureErrors();
    installFakeApi({ sessionRefusal: 503 });
    renderApp("/projects");

    await expect.element(heading("Can't reach the server", 1)).toBeVisible();
    await page.getByRole("button", { name: "Try again" }).click();
    await expect.element(page.getByRole("alert")).toBeVisible();
    await expect.element(heading("Can't reach the server", 1)).toBeVisible();
  });

  test("after a navigation, announces the error and takes focus to its heading", async () => {
    captureErrors();
    const api = installFakeApi();
    const router = renderApp("/projects");
    await expect.element(page.getByRole("link", { name: "Main site", exact: true })).toBeVisible();

    // The kept answer has run out, and the API went down.
    router.options.context.queryClient.removeQueries({ queryKey: ["session"] });
    api.sessionRefusal = 504;
    await workspaceMenu().getByRole("link", { name: "Members" }).click();

    const alert = page.getByRole("alert");
    await expect
      .element(alert.getByRole("heading", { name: "Can't reach the server" }))
      .toBeVisible();
    await expect.poll(focusedText).toBe("Can't reach the server");
  });

  test("for any other reason: Something went wrong, with Reload only", async () => {
    captureErrors();
    installFakeApi({ sessionRefusal: 500 });
    renderApp("/projects");

    await expect.element(heading("Something went wrong", 1)).toBeVisible();
    await expect.element(page.getByText("Reload the page to try again.")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Try again" })).not.toBeInTheDocument();
    await page.getByText("Details").click();
    await expect.element(page.getByText(/^HTTP 500:/)).toBeVisible();

    await page.getByRole("button", { name: "Reload" }).click();
    expect(reload.calls).toBe(1);
  });

  test("fits a phone, in the light theme too", async () => {
    captureErrors();
    await page.viewport(390, 844);
    await emulateColorScheme("light");
    resetThemeForTests();
    installFakeApi({ sessionRefusal: 502 });
    renderApp("/projects");

    await expect.element(heading("Can't reach the server", 1)).toBeVisible();
    await page.getByText("Details").click();
    await expect.element(page.getByRole("button", { name: "Reload" })).toBeVisible();
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
  });
});
