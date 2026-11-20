import { afterEach, describe, expect, test } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser/context";

import type { Project } from "../../src/lib/projects-api.ts";
import { installFakeApi, memberAccess, OTHER_PROJECT, PROJECT, requestUrl } from "./fake-api.ts";
import { currentPath, renderApp } from "./render.tsx";

/*
 * Starred projects (docs/dashboard.md, "Starred projects"): the star on
 * the Projects page's rows and in the project switcher, and the workspace
 * sidebar's group of starred projects, or the first few without stars.
 */

const sidebar = () => document.querySelector("[data-slot=sidebar]");
const table = () => page.getByRole("table", { name: "Projects" });
/** The sidebar's group of projects, by its label ("Starred" or "Projects"). */
const group = (name: "Starred" | "Projects") => page.getByRole("navigation", { name, exact: true });
/** The names its links show, in order, without "All projects". */
const groupNames = (name: "Starred" | "Projects") =>
  group(name)
    .getByRole("link")
    .elements()
    .map((link) => link.querySelector("[data-truncated-text]")?.textContent ?? link.textContent)
    .filter((text) => text !== "All projects");
/** The open tooltip's text (Base UI's tooltip has no role), or null with none open. */
const tooltip = () =>
  document.querySelector("[data-slot=tooltip-content][data-open]")?.textContent ?? null;

const HOUR = 3_600_000;
const project = (id: number, name: string, lastEventAt: string | null): Project => ({
  ...PROJECT,
  id: `00000000-0000-4000-8000-${String(id).padStart(12, "0")}`,
  name,
  lastEventAt,
});

/** Seven projects, made in this order: the fallback lists the first five by name. */
const SEVEN = [
  project(1, "Zebra app", null),
  project(2, "Analytics", null),
  project(3, "docs", null),
  project(4, "Blog", null),
  project(5, "Mobile", null),
  project(6, "Checkout", null),
  project(7, "Admin", null),
];

afterEach(async () => {
  await page.viewport(1280, 900);
});

describe("the workspace sidebar's projects", () => {
  test("with nothing starred, the first five projects by name, then All projects", async () => {
    installFakeApi({ projects: SEVEN });
    const router = renderApp("/projects");

    await expect.element(group("Projects")).toBeVisible();
    expect(groupNames("Projects")).toEqual(["Admin", "Analytics", "Blog", "Checkout", "docs"]);
    expect(group("Starred").elements()).toEqual([]);

    await group("Projects").getByRole("link", { name: "All projects" }).click();
    await expect.poll(() => currentPath(router)).toBe("/projects");
  });

  test("starred projects alone, by name, under Starred", async () => {
    installFakeApi({ projects: SEVEN, starred: [SEVEN[0]?.id ?? "", SEVEN[3]?.id ?? ""] });
    renderApp("/settings");
    await expect.element(group("Starred")).toBeVisible();
    expect(groupNames("Starred")).toEqual(["Blog", "Zebra app"]);
    expect(group("Projects").elements()).toEqual([]);
  });

  test("a click opens the project; inside it the group gives way to the switcher", async () => {
    installFakeApi({ projects: [PROJECT, OTHER_PROJECT] });
    const router = renderApp("/projects");
    await group("Projects").getByRole("link", { name: /^Docs/ }).click();
    await expect.poll(() => currentPath(router)).toBe(`/projects/${OTHER_PROJECT.id}/overview`);
    await expect
      .element(page.getByRole("button", { name: "Project: Docs. Switch project" }))
      .toBeVisible();
    expect(group("Projects").elements()).toEqual([]);
  });

  test("each project's dot says in its name and tooltip whether events arrive", async () => {
    await page.viewport(1440, 900);
    installFakeApi({
      projects: [
        project(1, "Live", new Date(Date.now() - HOUR).toISOString()),
        project(2, "Quiet", new Date(Date.now() - 3 * 24 * HOUR).toISOString()),
        project(3, "New", null),
      ],
    });
    renderApp("/projects");
    const links = group("Projects").getByRole("link");
    await expect.element(group("Projects")).toBeVisible();
    expect(
      links.elements().map((link) => link.getAttribute("aria-label") ?? link.textContent),
    ).toEqual([
      "Live, receiving events",
      "New, no events yet",
      "Quiet, last event 3 days ago",
      "All projects",
    ]);
    // The tile is decoration: the accessible name is the name and the status.
    await expect
      .element(group("Projects").getByRole("link", { name: "Live, receiving events", exact: true }))
      .toBeVisible();
    const dots = [...document.querySelectorAll("[data-slot=event-dot]")];
    expect(dots.map((dot) => dot.getAttribute("data-state"))).toEqual([
      "receiving",
      "none",
      "quiet",
    ]);
    expect(dots.every((dot) => dot.getAttribute("aria-hidden") === "true")).toBe(true);

    await group("Projects").getByRole("link", { name: /^New/ }).hover();
    await expect.poll(tooltip).toBe("NewNo events yet");
  });

  test("collapsed to icons, the tiles stay, each with its tooltip", async () => {
    await page.viewport(1440, 900);
    installFakeApi({ projects: [PROJECT, OTHER_PROJECT], starred: [PROJECT.id] });
    renderApp("/projects");
    await expect.element(group("Starred")).toBeVisible();

    await userEvent.keyboard("{Control>}b{/Control}");
    await expect.poll(() => sidebar()?.getAttribute("data-state")).toBe("collapsed");

    const link = group("Starred").getByRole("link", { name: /^Main site/ });
    const box = link.element().getBoundingClientRect();
    expect(box.width).toBeLessThanOrEqual(32);
    const tile = link.element().querySelector("[data-slot=project-tile]");
    expect(tile?.textContent).toBe("M");
    expect(tile?.getBoundingClientRect().width).toBeGreaterThan(0);
    // The tile sits whole inside the collapsed button.
    const tileBox = tile?.getBoundingClientRect();
    expect(tileBox !== undefined && tileBox.right <= box.right && tileBox.left >= box.left).toBe(
      true,
    );
    // "All projects" waits for the expanded sidebar.
    const all = [...(group("Starred").element().querySelectorAll("a") ?? [])].find(
      (anchor) => anchor.textContent === "All projects",
    );
    expect(all === undefined ? "" : getComputedStyle(all.closest("li") ?? all).display).toBe(
      "none",
    );

    await link.hover();
    await expect.poll(tooltip).toMatch(/^Main siteLast event /);
  });

  test("at 390 wide, the group is in the menu's sheet, and a project chosen there closes it", async () => {
    await page.viewport(390, 844);
    installFakeApi({ projects: [PROJECT, OTHER_PROJECT], starred: [OTHER_PROJECT.id] });
    const router = renderApp("/projects");
    await page.getByRole("button", { name: "Open menu" }).click();
    const sheet = page.getByRole("dialog", { name: "Menu" });
    await expect.element(sheet.getByRole("navigation", { name: "Starred" })).toBeVisible();
    const link = sheet.getByRole("link", { name: /^Docs/ });
    expect(link.element().getBoundingClientRect().height).toBeGreaterThanOrEqual(32);
    await link.click();
    await expect.poll(() => currentPath(router)).toBe(`/projects/${OTHER_PROJECT.id}/overview`);
    await expect.element(sheet).not.toBeInTheDocument();
  });

  test("the instance's name heads the workspace, as the switcher names a project", async () => {
    installFakeApi();
    renderApp("/projects");
    await expect
      .poll(
        () =>
          document.querySelector("[data-slot=sidebar-header] [data-slot=instance-name]")
            ?.textContent,
      )
      .toBe("AAcme IncInstance");
  });
});

describe("starring", () => {
  test("from the Projects page: the row's star, the sidebar at once, starred rows first", async () => {
    const api = installFakeApi({ projects: [PROJECT, OTHER_PROJECT] });
    renderApp("/projects");
    const starDocs = table().getByRole("button", { name: "Star Docs", exact: true });
    await expect.element(starDocs).toHaveAttribute("aria-pressed", "false");
    expect(groupNames("Projects")).toEqual(["Docs", "Main site"]);
    const rowNames = () =>
      [...(table().element().querySelectorAll("tbody tr th a") ?? [])].map(
        (link) => link.textContent,
      );
    expect(rowNames()).toEqual(["Main site", "Docs"]);

    await starDocs.click();
    // At once: the sidebar, the button, and the order.
    await expect.element(group("Starred")).toBeVisible();
    expect(groupNames("Starred")).toEqual(["Docs"]);
    const unstarDocs = table().getByRole("button", { name: "Unstar Docs", exact: true });
    await expect.element(unstarDocs).toHaveAttribute("aria-pressed", "true");
    expect(rowNames()).toEqual(["Docs", "Main site"]);
    await expect.poll(() => api.starred).toEqual([OTHER_PROJECT.id]);

    await unstarDocs.click();
    await expect.element(group("Projects")).toBeVisible();
    await expect.poll(() => api.starred).toEqual([]);
    expect(rowNames()).toEqual(["Main site", "Docs"]);
  });

  test("the star acts alone inside the clickable row", async () => {
    const api = installFakeApi({ projects: [PROJECT] });
    const router = renderApp("/projects");
    await table().getByRole("button", { name: "Star Main site" }).click();
    await expect.poll(() => api.starred).toEqual([PROJECT.id]);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(currentPath(router)).toBe("/projects");

    // The rest of the row still opens the project.
    const row = table().element().querySelector("tbody tr");
    const created = row?.querySelectorAll("td")[3];
    await page.elementLocator(created as Element).click();
    await expect.poll(() => currentPath(router)).toBe(`/projects/${PROJECT.id}/overview`);
  });

  test("members star the projects they were given", async () => {
    const api = installFakeApi({
      projects: [PROJECT, OTHER_PROJECT],
      access: memberAccess({ web_analytics: "view" }, [PROJECT.id]),
      // A star on a project taken from them stays hidden.
      starred: [OTHER_PROJECT.id],
    });
    renderApp("/projects");
    await expect.element(group("Projects")).toBeVisible();
    expect(groupNames("Projects")).toEqual(["Main site"]);
    await table().getByRole("button", { name: "Star Main site" }).click();
    await expect.element(group("Starred")).toBeVisible();
    expect(groupNames("Starred")).toEqual(["Main site"]);
    await expect.poll(() => api.starred).toEqual([OTHER_PROJECT.id, PROJECT.id]);
  });

  test("a star that fails to save goes back, and the page says why", async () => {
    installFakeApi({ projects: [PROJECT] });
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) =>
      init?.method === "PUT" && requestUrl(input).pathname.startsWith("/api/starred-projects/")
        ? new Response(JSON.stringify({ error: "internal", message: "The database is down." }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          })
        : realFetch(input, init);
    try {
      renderApp("/projects");
      await table().getByRole("button", { name: "Star Main site" }).click();
      await expect.element(page.getByText("The star could not be saved")).toBeVisible();
      await expect.element(page.getByText("The database is down.")).toBeVisible();
      await expect
        .element(table().getByRole("button", { name: "Star Main site" }))
        .toHaveAttribute("aria-pressed", "false");
      await expect.element(group("Projects")).toBeVisible();
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("from the project switcher: starred projects first, marked, and the current one starred there", async () => {
    const api = installFakeApi({ projects: [PROJECT, OTHER_PROJECT], starred: [OTHER_PROJECT.id] });
    renderApp(`/projects/${PROJECT.id}/web-analytics`);
    await page.getByRole("button", { name: "Project: Main site. Switch project" }).click();
    const menu = page.getByRole("menu");
    await expect.element(menu).toBeVisible();
    const items = menu.getByRole("menuitem").elements();
    expect(items.map((item) => item.textContent)).toEqual([
      "Docs",
      "Main site",
      "Star this project",
      "All projects",
    ]);
    await expect.element(menu.getByRole("menuitem", { name: "Docs Starred" })).toBeVisible();

    await menu.getByRole("menuitem", { name: "Star this project" }).click();
    await expect.poll(() => api.starred).toEqual([OTHER_PROJECT.id, PROJECT.id]);
    await page.getByRole("button", { name: "Project: Main site. Switch project" }).click();
    await expect
      .element(page.getByRole("menu").getByRole("menuitem", { name: "Unstar this project" }))
      .toBeVisible();
  });
});
