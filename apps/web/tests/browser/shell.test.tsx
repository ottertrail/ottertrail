import { afterEach, describe, expect, test } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser/context";

import { installFakeApi, OTHER_PROJECT, PROJECT } from "./fake-api.ts";
import { unmountAll } from "./mounted.ts";
import { currentPath, renderApp } from "./render.tsx";

/*
 * The dashboard's shell (app.tsx, page-header.tsx, app-sidebar.tsx) at a
 * desktop and a phone width: no top bar, the sidebar's toggle and the API's
 * health in its head, and each page's title row.
 */

const ANALYTICS = `/projects/${PROJECT.id}/web-analytics`;
const SIDEBAR_KEY = "ottertrail.sidebar";

const sidebar = () => document.querySelector("[data-slot=sidebar]");
const projectMenu = () => page.getByRole("navigation", { name: "Project" });
const title = () => page.getByRole("heading", { level: 1 });
const openTooltip = () => document.querySelector("[data-slot=tooltip-content][data-open]");
const box = (element: Element | null | undefined) =>
  element?.getBoundingClientRect() ?? new DOMRect();

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

    await page.getByRole("button", { name: "Expand sidebar" }).click();
    await expect.poll(() => sidebar()?.getAttribute("data-state")).toBe("expanded");
    expect(window.localStorage.getItem(SIDEBAR_KEY)).toBe("expanded");
  });

  test("has no bar above the page: the content panel starts with the page's title", async () => {
    await page.viewport(1440, 900);
    installFakeApi();
    renderApp(ANALYTICS);

    await expect.element(title()).toHaveTextContent("Web analytics");
    expect(document.querySelector("[data-slot=sidebar-inset] > header")).toBeNull();
    expect(document.querySelector("nav[aria-label=Breadcrumb]")).toBeNull();
    await expect.element(page.getByText("sidebar", { exact: true })).not.toBeInTheDocument();
    // The title row is the panel's first child, at its top, in the content's gutter.
    const panel = box(document.querySelector("[data-slot=sidebar-inset]"));
    const header = box(document.querySelector("[data-slot=page-header]"));
    expect(header.top).toBe(panel.top);
    expect(box(title().element()).left - panel.left).toBe(24);
    // The filter bar follows it.
    const bar = box(document.querySelector("[data-slot=filter-bar]"));
    expect(bar.top).toBe(header.bottom);
  });

  test("the toggle sits in the sidebar's head, with the shortcut in its tooltip", async () => {
    await page.viewport(1440, 900);
    installFakeApi();
    renderApp("/projects");

    const collapse = page.getByRole("button", { name: "Collapse sidebar" });
    await expect.element(collapse).toBeVisible();
    await expect.element(collapse).toHaveAttribute("aria-keyshortcuts", "Control+B Meta+B");
    // At the head's end, on the name's line.
    const head = box(document.querySelector("[data-slot=sidebar-head]"));
    const toggle = box(collapse.element());
    expect(head.right - toggle.right).toBeLessThanOrEqual(1);
    const mark = box(document.querySelector("[data-slot=sidebar-head] svg"));
    expect(Math.abs(toggle.top + toggle.height / 2 - (mark.top + mark.height / 2))).toBeLessThan(1);
    await collapse.hover();
    await expect.poll(() => openTooltip()?.textContent).toMatch(/^Collapse sidebar(⌘|Ctrl)B$/);

    await collapse.click();
    await expect.poll(() => sidebar()?.getAttribute("data-state")).toBe("collapsed");
    // Collapsed, it is under the mark, as Expand sidebar.
    const expand = page.getByRole("button", { name: "Expand sidebar" });
    await expect.element(expand).toBeVisible();
    const collapsedMark = box(document.querySelector("[data-slot=sidebar-head] svg"));
    expect(box(expand.element()).top).toBeGreaterThan(collapsedMark.bottom);
    await expand.hover();
    await expect.poll(() => openTooltip()?.textContent).toMatch(/^Expand sidebar(⌘|Ctrl)B$/);

    await userEvent.keyboard("{Control>}b{/Control}");
    await expect.poll(() => sidebar()?.getAttribute("data-state")).toBe("expanded");
  });

  test("a page's actions sit at the end of its title row", async () => {
    await page.viewport(1440, 900);
    installFakeApi({ projects: [PROJECT, OTHER_PROJECT] });
    renderApp("/projects");

    const newProject = page.getByRole("button", { name: "New project" });
    await expect.element(newProject).toBeVisible();
    const header = document.querySelector("[data-slot=page-header]");
    expect(header?.contains(newProject.element())).toBe(true);
    await expect.element(title()).toHaveTextContent("Projects");
    const action = box(newProject.element());
    expect(box(header).right - action.right).toBe(24);
    const heading = box(title().element());
    expect(
      Math.abs(action.top + action.height / 2 - (heading.top + heading.height / 2)),
    ).toBeLessThan(2);

    unmountAll();
    renderApp("/settings/members");
    const invite = page.getByRole("button", { name: "Invite" });
    await expect.element(invite).toBeVisible();
    expect(document.querySelector("[data-slot=page-header]")?.contains(invite.element())).toBe(
      true,
    );
    // The tabs follow the title row, without the action.
    const tabs = document.querySelector("[role=tablist]");
    expect(tabs?.contains(invite.element())).toBe(false);
  });

  test("a detail page is titled by its item", async () => {
    await page.viewport(1440, 900);
    installFakeApi();
    renderApp(`/projects/${PROJECT.id}/uptime`);
    await expect.element(title()).toHaveTextContent("Uptime");

    unmountAll();
    renderApp(`/projects/${PROJECT.id}/hosts/db-1`);
    await expect.element(title()).toHaveTextContent("db-1");
    // Once: the page does not name it again under the header.
    expect(page.getByRole("heading", { name: "db-1" }).elements()).toHaveLength(1);
  });
});

describe("the API's health in the sidebar's head", () => {
  test("is a green dot while the API is online, named for screen readers", async () => {
    await page.viewport(1440, 900);
    installFakeApi();
    renderApp("/projects");

    const status = page.getByRole("status", { name: "API status" });
    await expect.element(status).toHaveTextContent("API online");
    const dot = document.querySelector<HTMLElement>(
      "[data-slot=sidebar-head] [data-slot=api-status-dot]",
    );
    expect(dot?.getAttribute("data-state")).toBe("ok");
    // A dot, no badge: the words are for screen readers and the tooltip.
    expect(box(dot).width).toBe(12);
    expect(box(page.getByText("API online", { exact: true }).element()).width).toBeLessThanOrEqual(
      1,
    );
    await userEvent.hover(dot ?? document.body);
    await expect.poll(() => openTooltip()?.textContent).toBe("API online");
  });

  test("shows the full badge with Retry when the API cannot be reached, keeping the name whole", async () => {
    await page.viewport(1440, 900);
    installFakeApi({ healthStatus: 503 });
    renderApp("/projects");

    await expect.element(page.getByText("API unreachable", { exact: true })).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Retry API health check" }))
      .toBeVisible();
    const name = page.getByText("Ottertrail", { exact: true }).element();
    expect(name.scrollWidth).toBeLessThanOrEqual(name.clientWidth);
    // On a line of its own, under the name.
    expect(box(page.getByText("API unreachable", { exact: true }).element()).top).toBeGreaterThan(
      box(name).bottom,
    );
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

  test("puts the menu button before the title, and the actions at its end", async () => {
    await page.viewport(390, 844);
    installFakeApi();
    renderApp("/projects");

    const menu = page.getByRole("button", { name: "Open menu" });
    await expect.element(menu).toBeVisible();
    await expect.element(title()).toHaveTextContent("Projects");
    const button = box(menu.element());
    const heading = box(title().element());
    expect(button.right).toBeLessThanOrEqual(heading.left);
    expect(button.top).toBeLessThan(heading.bottom);
    expect(button.bottom).toBeGreaterThan(heading.top);
    // The page's action arrives after the header: wait for it before measuring.
    const newProject = page.getByRole("button", { name: "New project" });
    await expect.element(newProject).toBeVisible();
    const action = box(newProject.element());
    expect(action.left).toBeGreaterThan(heading.right);
    expect(action.right).toBeLessThanOrEqual(390);
  });

  test("keeps the content inside the screen, with phone gutters", async () => {
    await page.viewport(390, 844);
    installFakeApi();
    renderApp(ANALYTICS);

    await expect.element(page.getByRole("heading", { name: "Visitors per day" })).toBeVisible();
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
    const content = document.querySelector<HTMLElement>("[data-slot=app-content]");
    expect(content?.scrollWidth).toBeLessThanOrEqual(content?.clientWidth ?? 0);
    const header = document.querySelector("[data-slot=page-header]");
    expect(header?.getBoundingClientRect().width).toBe(390);
    // 16px gutters under 40rem.
    const bar = document.querySelector<HTMLElement>("[data-slot=filter-bar]");
    expect(bar === null ? "" : getComputedStyle(bar).paddingLeft).toBe("16px");
  });
});
