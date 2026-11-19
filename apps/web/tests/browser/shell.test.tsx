import { afterEach, describe, expect, test } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser/context";

import { installFakeApi, PROJECT } from "./fake-api.ts";
import { unmountAll } from "./mounted.ts";
import { currentPath, renderApp } from "./render.tsx";

/* The dashboard's shell (app.tsx, app-header.tsx, app-sidebar.tsx) at a desktop and a phone width. */

const ANALYTICS = `/projects/${PROJECT.id}/web-analytics`;
const SIDEBAR_KEY = "ottertrail.sidebar";

const sidebar = () => document.querySelector("[data-slot=sidebar]");
const projectMenu = () => page.getByRole("navigation", { name: "Project" });

afterEach(async () => {
  await page.viewport(1280, 900);
});

describe("at 1440 wide", () => {
  test("shows the expanded sidebar, which Ctrl B collapses, and the browser remembers it", async () => {
    await page.viewport(1440, 900);
    installFakeApi();
    renderApp(ANALYTICS);

    await expect.element(projectMenu().getByRole("link", { name: "Web analytics" })).toBeVisible();
    expect(sidebar()?.getAttribute("data-state")).toBe("expanded");
    await expect.element(page.getByRole("button", { name: "Open menu" })).not.toBeInTheDocument();

    await userEvent.keyboard("{Control>}b{/Control}");

    await expect.poll(() => sidebar()?.getAttribute("data-state")).toBe("collapsed");
    expect(window.localStorage.getItem(SIDEBAR_KEY)).toBe("collapsed");

    // A new visit in this browser starts collapsed.
    unmountAll();
    renderApp(ANALYTICS);
    await expect.element(projectMenu()).toBeInTheDocument();
    expect(sidebar()?.getAttribute("data-state")).toBe("collapsed");

    await page.getByRole("button", { name: "Toggle sidebar" }).click();
    await expect.poll(() => sidebar()?.getAttribute("data-state")).toBe("expanded");
    expect(window.localStorage.getItem(SIDEBAR_KEY)).toBe("expanded");
  });
});

describe("at 390 wide", () => {
  test("hides the sidebar behind a menu button, and a link chosen there closes it", async () => {
    await page.viewport(390, 844);
    installFakeApi();
    const router = renderApp(ANALYTICS);

    await expect.element(page.getByRole("heading", { name: "Visitors per day" })).toBeVisible();
    await expect.element(projectMenu()).not.toBeInTheDocument();

    const menu = page.getByRole("button", { name: "Open menu" });
    await expect.element(menu).toHaveAttribute("aria-expanded", "false");
    await menu.click();

    const sheet = page.getByRole("dialog", { name: "Menu" });
    await expect.element(sheet).toBeVisible();
    await sheet.getByRole("link", { name: "Speed" }).click();

    await expect.poll(() => currentPath(router)).toBe(`/projects/${PROJECT.id}/speed`);
    await expect.element(sheet).not.toBeInTheDocument();
  });

  test("keeps the content inside the screen, with phone gutters", async () => {
    await page.viewport(390, 844);
    installFakeApi();
    renderApp("/design-system");

    await expect.element(page.getByRole("heading", { name: "Screen patterns" })).toBeVisible();
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
    const content = document.querySelector<HTMLElement>("[data-slot=app-content]");
    expect(content?.scrollWidth).toBeLessThanOrEqual(content?.clientWidth ?? 0);
    const header = document.querySelector("header");
    expect(header?.getBoundingClientRect().width).toBe(390);
    // 16px gutters under 40rem.
    const bar = document.querySelector<HTMLElement>("[data-slot=filter-bar]");
    expect(bar === null ? "" : getComputedStyle(bar).paddingLeft).toBe("16px");
  });
});
