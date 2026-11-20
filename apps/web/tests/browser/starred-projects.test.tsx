import { describe, expect, test } from "vite-plus/test";
import { page } from "vite-plus/test/browser/context";

import { installFakeApi, memberAccess, OTHER_PROJECT, PROJECT, requestUrl } from "./fake-api.ts";
import { currentPath, renderApp } from "./render.tsx";

/*
 * Starred projects (docs/dashboard.md, "Starred projects"): the star on
 * the Projects page's rows and in the project switcher.
 */

const table = () => page.getByRole("table", { name: "Projects" });

describe("starring", () => {
  test("from the Projects page: the row's star at once, starred rows first", async () => {
    const api = installFakeApi({ projects: [PROJECT, OTHER_PROJECT] });
    renderApp("/projects");
    const starDocs = table().getByRole("button", { name: "Star Docs", exact: true });
    await expect.element(starDocs).toHaveAttribute("aria-pressed", "false");
    const rowNames = () =>
      [...(table().element().querySelectorAll("tbody tr th a") ?? [])].map(
        (link) => link.textContent,
      );
    expect(rowNames()).toEqual(["Main site", "Docs"]);

    await starDocs.click();
    // At once: the button and the order.
    const unstarDocs = table().getByRole("button", { name: "Unstar Docs", exact: true });
    await expect.element(unstarDocs).toHaveAttribute("aria-pressed", "true");
    expect(rowNames()).toEqual(["Docs", "Main site"]);
    await expect.poll(() => api.starred).toEqual([OTHER_PROJECT.id]);

    await unstarDocs.click();
    await expect
      .element(table().getByRole("button", { name: "Star Docs", exact: true }))
      .toHaveAttribute("aria-pressed", "false");
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
    const star = table().getByRole("button", { name: "Star Main site" });
    await expect.element(star).toHaveAttribute("aria-pressed", "false");
    expect(
      table()
        .getByRole("button", { name: /^(Star|Unstar) / })
        .elements(),
    ).toHaveLength(1);
    await star.click();
    await expect
      .element(table().getByRole("button", { name: "Unstar Main site" }))
      .toHaveAttribute("aria-pressed", "true");
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
    // Each project after its icon, here its initial.
    expect(items.map((item) => item.textContent)).toEqual([
      "DDocs",
      "MMain site",
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
