import { afterEach, describe, expect, test } from "vite-plus/test";
import { page } from "vite-plus/test/browser/context";

import { deferred, installFakeApi, memberAccess, PROJECT, requestUrl } from "./fake-api.ts";
import { currentPath, renderApp } from "./render.tsx";

/*
 * The project list (/projects) in each of its states: loading, failed,
 * empty, and full, for those who manage projects and for members, at 390
 * and 1440 wide.
 */

const table = () => page.getByRole("table", { name: "Projects" });
const heads = () =>
  table()
    .getByRole("columnheader")
    .elements()
    .map((head) => head.textContent);
const cells = () =>
  [...(table().element().querySelectorAll("tbody tr") ?? [])].map((row) =>
    [...row.children].map((cell) => cell.textContent ?? ""),
  );

afterEach(async () => {
  await page.viewport(1280, 900);
});

describe("the project list", () => {
  test("shows each project with its last event, sites, how long it keeps events, and when it was made", async () => {
    installFakeApi({ projects: [{ ...PROJECT, retentionDays: 365 }] });
    const router = renderApp("/projects");

    await expect.element(table()).toBeVisible();
    expect(heads()).toEqual([
      "Name",
      "Last event",
      "Allowed sites",
      "Keeps events",
      "Created",
      "Actions",
    ]);
    expect(cells()[0]?.slice(2)).toEqual(["example.com", "1 year", "1 Oct 2026", "Settings"]);
    // Each row's action names its project.
    await expect.element(table().getByRole("rowheader", { name: "Main site" })).toBeVisible();

    await table().getByRole("link", { name: "Settings of Main site" }).click();
    await expect.poll(() => currentPath(router)).toBe(`/projects/${PROJECT.id}/settings`);
  });

  test("a project without allowed sites says its events are refused, and leads to adding one", async () => {
    installFakeApi({ projects: [{ ...PROJECT, allowedHostnames: [], lastEventAt: null }] });
    const router = renderApp("/projects");

    await expect.element(table().getByText("None: events are refused")).toBeVisible();
    await expect.element(table().getByText("No events yet")).toBeVisible();
    await table().getByRole("link", { name: "Add a site to Main site" }).click();
    await expect
      .poll(() => currentPath(router))
      .toBe(`/projects/${PROJECT.id}/settings?tab=general`);
    await expect.element(page.getByRole("textbox", { name: "Allowed sites" })).toBeVisible();
  });

  test("members see their projects, without sites, retention, settings, or New project", async () => {
    installFakeApi({ access: memberAccess({ web_analytics: "view" }) });
    renderApp("/projects");

    await expect.element(table()).toBeVisible();
    expect(heads()).toEqual(["Name", "Last event", "Created"]);
    await expect.element(page.getByRole("button", { name: "New project" })).not.toBeInTheDocument();
    await expect
      .element(table().getByRole("link", { name: /^Settings of / }))
      .not.toBeInTheDocument();
  });

  test("while the list loads, rows of its shape, then the list", async () => {
    installFakeApi();
    const hold = deferred<void>();
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      if (requestUrl(input).pathname === "/api/projects") await hold.promise;
      return realFetch(input, init);
    };
    try {
      renderApp("/projects");
      await expect.element(page.getByLabelText("Loading projects")).toBeInTheDocument();
      expect(page.getByRole("table").elements()).toEqual([]);
      hold.resolve();
      await expect.element(table()).toBeVisible();
      await expect.element(page.getByLabelText("Loading projects")).not.toBeInTheDocument();
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("a failed load says what failed, and Retry loads it", async () => {
    installFakeApi();
    let fail = true;
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) =>
      fail && requestUrl(input).pathname === "/api/projects"
        ? new Response(JSON.stringify({ error: "internal", message: "The database is down." }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          })
        : realFetch(input, init);
    try {
      renderApp("/projects");
      await expect.element(page.getByText("Projects could not load")).toBeVisible();
      await expect.element(page.getByText("The database is down.")).toBeVisible();
      fail = false;
      await page.getByRole("button", { name: "Retry" }).click();
      await expect.element(table()).toBeVisible();
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("with no projects, the owner is offered New project there", async () => {
    installFakeApi({ projects: [] });
    renderApp("/projects");
    await expect.element(page.getByText("No projects yet")).toBeVisible();
    await expect
      .element(
        page.getByText("Create a project for your website or app to get its tracking snippet."),
      )
      .toBeVisible();
    // One New project button: in the empty state, not also above it.
    expect(page.getByRole("button", { name: "New project" }).elements()).toHaveLength(1);
  });
});

describe("the project list fits", () => {
  test("at 390 the table scrolls inside itself, its name and action pinned, with the scroll hint", async () => {
    await page.viewport(390, 844);
    installFakeApi();
    renderApp("/projects");
    await expect.element(table()).toBeVisible();

    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
    const content = document.querySelector("[data-slot=app-content]");
    expect(content?.scrollWidth).toBeLessThanOrEqual(content?.clientWidth ?? 0);
    const container = document.querySelector<HTMLElement>("[data-slot=table-container]");
    expect(container?.scrollWidth ?? 0).toBeGreaterThan(container?.clientWidth ?? 0);
    const name = table().getByRole("rowheader", { name: "Main site" }).element();
    expect(getComputedStyle(name).position).toBe("sticky");
    const action = table()
      .getByRole("link", { name: "Settings of Main site" })
      .element()
      .closest("td");
    expect(action === null ? "" : getComputedStyle(action).position).toBe("sticky");
    await expect.poll(() => document.querySelector("[data-slot=scroll-hint]")).not.toBeNull();
  });

  test("at 1440 the table fits without scrolling", async () => {
    await page.viewport(1440, 900);
    installFakeApi();
    renderApp("/projects");
    await expect.element(table()).toBeVisible();

    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(1440);
    const container = document.querySelector<HTMLElement>("[data-slot=table-container]");
    expect(container?.scrollWidth).toBeLessThanOrEqual(container?.clientWidth ?? 0);
    expect(document.querySelector("[data-slot=scroll-hint]")).toBeNull();
  });
});
