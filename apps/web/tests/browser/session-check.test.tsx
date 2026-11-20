import { describe, expect, test, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser/context";

import { type FakeApi, installFakeApi } from "./fake-api.ts";
import { currentPath, renderApp } from "./render.tsx";

/*
 * The session check before every signed-in page (router.tsx, the app
 * route). Better Auth rate-limits GET /api/auth/get-session, so hovering
 * links (which preloads their routes) must not ask, and a refusal other
 * than a 401 must not sign anyone out.
 */

const sessionChecks = (api: FakeApi) =>
  api.requests.filter((request) => request.startsWith("/api/auth/get-session")).length;

const workspaceMenu = () => page.getByRole("navigation", { name: "Instance" });

describe("the session check", () => {
  test("is not asked again by hovering links, nor by a click soon after", async () => {
    const api = installFakeApi();
    const router = renderApp("/projects");
    await expect.element(page.getByRole("link", { name: "Main site", exact: true })).toBeVisible();
    const before = sessionChecks(api);

    for (let round = 0; round < 5; round++) {
      for (const name of ["Members", "Settings", "Projects"]) {
        await workspaceMenu().getByRole("link", { name }).hover();
        // Past the router's 50ms preload delay.
        await new Promise((resolve) => setTimeout(resolve, 80));
      }
    }
    await page.getByRole("link", { name: "Main site", exact: true }).hover();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(sessionChecks(api)).toBe(before);

    // A navigation within the cache's 30 seconds uses the answer it has.
    await workspaceMenu().getByRole("link", { name: "Members" }).click();
    await expect.poll(() => currentPath(router)).toBe("/settings/members");
    await expect.element(page.getByRole("tab", { name: /^Members/ })).toBeVisible();
    expect(sessionChecks(api)).toBe(before);
  });

  test("refused for too many requests (429) shows the error with Reload, not sign-in", async () => {
    // React reports the error the route caught; anything else logged still fails the test.
    const logged: unknown[][] = [];
    vi.mocked(console.error).mockImplementation((...args: unknown[]) => {
      logged.push(args);
    });
    installFakeApi({ sessionRefusal: 429 });
    const router = renderApp("/projects");

    const alert = page.getByRole("alert");
    await expect.element(alert.getByText("Something went wrong")).toBeVisible();
    await expect.element(alert.getByText(/Too many requests to check your session/)).toBeVisible();
    await expect.element(alert.getByRole("button", { name: "Reload" })).toBeVisible();
    expect(currentPath(router)).toBe("/projects");
    await expect.element(page.getByRole("heading", { name: "Sign in" })).not.toBeInTheDocument();
    for (const args of logged) {
      expect(args.map(String).join(" ")).toMatch(/Too many requests to check your session/);
    }
  });

  test("answered 401 still sends the visitor to sign-in", async () => {
    installFakeApi({ sessionRefusal: 401 });
    const router = renderApp("/projects");

    await expect.poll(() => currentPath(router)).toBe("/sign-in");
    await expect.element(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  });

  test("refused on the sign-in page shows the form", async () => {
    installFakeApi({ sessionRefusal: 429 });
    const router = renderApp("/sign-in");

    await expect.element(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    await expect.element(page.getByRole("textbox", { name: "Email" })).toBeVisible();
    expect(currentPath(router)).toBe("/sign-in");
  });
});
