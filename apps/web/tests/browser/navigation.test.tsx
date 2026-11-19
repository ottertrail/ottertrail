import { describe, expect, test } from "vite-plus/test";
import { page } from "vite-plus/test/browser/context";

import { installFakeApi, OTHER_PROJECT, PROJECT } from "./fake-api.ts";
import { unmountAll } from "./mounted.ts";
import { currentPath, renderApp } from "./render.tsx";

const ANALYTICS = `/projects/${PROJECT.id}/web-analytics`;
const SETTINGS = `/projects/${PROJECT.id}/settings`;
const OVERVIEW = `/projects/${PROJECT.id}/overview`;
const LAST_PROJECT_KEY = "ottertrail.project";

const workspaceMenu = () => page.getByRole("navigation", { name: "Instance" });
const projectMenu = () => page.getByRole("navigation", { name: "Project" });
const switcher = (name: string) =>
  page.getByRole("button", { name: `Project: ${name}. Switch project` });

/** The header's breadcrumb as text, such as "Main site / Web analytics". */
function breadcrumb(): string {
  const nav = document.querySelector("header nav[aria-label=Breadcrumb]");
  return [...(nav?.children ?? [])].map((child) => child.textContent).join(" ");
}

describe("the workspace", () => {
  test("lists projects and the design system, and no project's menu", async () => {
    installFakeApi();
    renderApp("/projects");

    await expect.element(page.getByRole("link", { name: "Main site", exact: true })).toBeVisible();
    await expect.element(workspaceMenu().getByRole("link", { name: "Projects" })).toBeVisible();
    await expect
      .element(workspaceMenu().getByRole("link", { name: "Design system" }))
      .toBeVisible();
    await expect
      .element(workspaceMenu().getByRole("link", { name: "Web analytics" }))
      .not.toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: /^Project:/ })).not.toBeInTheDocument();
  });

  test("a new project opens on its install snippet", async () => {
    const api = installFakeApi({ projects: [] });
    const router = renderApp("/projects");

    await page.getByRole("button", { name: "New project" }).click();
    await page.getByRole("textbox", { name: "Name" }).fill("Blog");
    await page.getByRole("button", { name: "Create project" }).click();

    const created = api.projects[0];
    await expect.poll(() => currentPath(router)).toBe(`/projects/${created?.id}/settings`);
    await expect.element(page.getByRole("heading", { name: "Install" })).toBeVisible();
    await expect
      .element(projectMenu().getByRole("link", { name: "Settings" }))
      .toHaveAttribute("aria-current", "page");
  });

  test("a project's name opens the project", async () => {
    installFakeApi();
    const router = renderApp("/projects");

    await page.getByRole("link", { name: "Main site", exact: true }).click();

    await expect.poll(() => currentPath(router)).toBe(OVERVIEW);
    await expect.element(page.getByRole("heading", { name: "Traffic" })).toBeVisible();
  });
});

describe("inside a project", () => {
  test("the menu belongs to the project", async () => {
    installFakeApi();
    renderApp(ANALYTICS);

    await expect.element(switcher("Main site")).toBeVisible();
    await expect.element(projectMenu().getByRole("link", { name: "All projects" })).toBeVisible();
    await expect
      .element(projectMenu().getByRole("link", { name: "Web analytics" }))
      .toHaveAttribute("aria-current", "page");
    await expect.element(projectMenu().getByRole("link", { name: "Speed" })).toBeVisible();
    await expect.element(projectMenu().getByRole("link", { name: "Settings" })).toBeVisible();
    await expect.element(projectMenu().getByRole("link", { name: "Users" })).toBeVisible();
    await expect.element(projectMenu().getByRole("link", { name: "Errors" })).toBeVisible();
    await expect
      .element(projectMenu().getByRole("link", { name: "Replays" }))
      .toHaveAttribute("href", `/projects/${PROJECT.id}/replays`);
    await expect
      .element(projectMenu().getByRole("link", { name: "Product analytics" }))
      .toHaveAttribute("href", `/projects/${PROJECT.id}/product/events`);
    // Every module is built: none is shown as planned.
    await expect.element(projectMenu().getByText("Planned")).not.toBeInTheDocument();
    // The project's menu in order, settings last, right after the modules.
    const items = document.querySelectorAll("nav[aria-label=Project] [data-sidebar=menu-button]");
    expect([...items].map((item) => item.textContent)).toEqual([
      "All projects",
      "Overview",
      "Web analytics",
      "Speed",
      "Users",
      "Errors",
      "Replays",
      "Traces",
      "Logs",
      "Metrics",
      "Services",
      "Databases",
      "Hosts",
      "Uptime",
      "Alerts",
      "Product analytics",
      "Settings",
    ]);
    // Right under the last module, not pinned to the bottom of the sidebar.
    const lastModule = items[13]?.getBoundingClientRect();
    const settings = items[14]?.getBoundingClientRect();
    expect((settings?.top ?? 0) - (lastModule?.bottom ?? 0)).toBeLessThan(8);
    await expect.poll(breadcrumb).toBe("Main site / Web analytics");
  });

  test("Product analytics stays active on each of its pages", async () => {
    installFakeApi();
    const router = renderApp(ANALYTICS);

    await projectMenu().getByRole("link", { name: "Product analytics" }).click();
    await expect.poll(() => currentPath(router)).toBe(`/projects/${PROJECT.id}/product/events`);
    await expect.poll(breadcrumb).toBe("Main site / Product analytics");

    for (const path of ["events/signup", "funnel", "retention"]) {
      router.history.push(`/projects/${PROJECT.id}/product/${path}`);
      await expect.poll(() => router.state.location.pathname).toMatch(new RegExp(`${path}$`));
      await expect
        .element(projectMenu().getByRole("link", { name: "Product analytics" }))
        .toHaveAttribute("data-active");
      await expect
        .element(projectMenu().getByRole("link", { name: "Web analytics" }))
        .not.toHaveAttribute("data-active");
    }
  });

  test("the project's address alone opens its overview", async () => {
    installFakeApi();
    const router = renderApp(`/projects/${PROJECT.id}`);

    await expect.poll(() => currentPath(router)).toBe(OVERVIEW);
  });

  test("Settings shows the install snippet and the project's settings", async () => {
    installFakeApi();
    const router = renderApp(ANALYTICS);

    await projectMenu().getByRole("link", { name: "Settings" }).click();

    await expect.poll(() => currentPath(router)).toBe(SETTINGS);
    await expect.element(page.getByRole("heading", { name: "Install" })).toBeVisible();
    // The name is on the General tab.
    await page.getByRole("tab", { name: "General" }).click();
    await expect.element(page.getByRole("textbox", { name: "Name" })).toHaveValue("Main site");
    await expect.poll(breadcrumb).toBe("Main site / Settings");
  });

  test("the switcher opens the same page of another project, keeping the period", async () => {
    const api = installFakeApi({ projects: [PROJECT, OTHER_PROJECT] });
    const router = renderApp(`${ANALYTICS}?period=90d`);

    await switcher("Main site").click();
    await page.getByRole("menuitem", { name: "Docs" }).click();

    await expect
      .poll(() => currentPath(router))
      .toBe(`/projects/${OTHER_PROJECT.id}/web-analytics?period=90d`);
    await expect
      .poll(() => api.requests.at(-1))
      .toBe(`/api/projects/${OTHER_PROJECT.id}/analytics?period=90d`);
    await expect.element(switcher("Docs")).toBeVisible();
    await expect.poll(breadcrumb).toBe("Docs / Web analytics");
  });

  test("the switcher keeps the period but not the filters", async () => {
    installFakeApi({ projects: [PROJECT, OTHER_PROJECT] });
    const router = renderApp(`${ANALYTICS}?period=90d&country=DE`);

    await switcher("Main site").click();
    await page.getByRole("menuitem", { name: "Docs" }).click();

    await expect.poll(() => router.state.location.search).toEqual({ period: "90d" });
    expect(currentPath(router)).toBe(`/projects/${OTHER_PROJECT.id}/web-analytics?period=90d`);
  });

  test("the switcher keeps you on Settings", async () => {
    installFakeApi({ projects: [PROJECT, OTHER_PROJECT] });
    const router = renderApp(SETTINGS);

    await switcher("Main site").click();
    await page.getByRole("menuitem", { name: "Docs" }).click();

    await expect.poll(() => currentPath(router)).toBe(`/projects/${OTHER_PROJECT.id}/settings`);
    await page.getByRole("tab", { name: "General" }).click();
    await expect.element(page.getByRole("textbox", { name: "Name" })).toHaveValue("Docs");
  });

  test("All projects goes back to the workspace", async () => {
    installFakeApi();
    const router = renderApp(ANALYTICS);

    await projectMenu().getByRole("link", { name: "All projects" }).click();

    await expect.poll(() => currentPath(router)).toBe("/projects");
    await expect.element(page.getByRole("button", { name: /^Project:/ })).not.toBeInTheDocument();
    await expect
      .element(workspaceMenu().getByRole("link", { name: "Design system" }))
      .toBeVisible();
  });

  test("an unknown project says so", async () => {
    installFakeApi();
    renderApp("/projects/33333333-3333-4333-8333-333333333333/settings");

    await expect.element(page.getByText("No such project")).toBeVisible();
    await expect
      .element(page.getByRole("main").getByRole("link", { name: "All projects" }))
      .toBeVisible();
  });
});

describe("the home page", () => {
  test("opens the first project", async () => {
    installFakeApi({ projects: [PROJECT, OTHER_PROJECT] });
    const router = renderApp("/");

    await expect.poll(() => currentPath(router)).toBe(OVERVIEW);
  });

  test("opens the project this browser showed last", async () => {
    installFakeApi({ projects: [PROJECT, OTHER_PROJECT] });
    renderApp(`/projects/${OTHER_PROJECT.id}/settings`);
    await expect.poll(() => window.localStorage.getItem(LAST_PROJECT_KEY)).toBe(OTHER_PROJECT.id);
    unmountAll();

    const router = renderApp("/");

    await expect.poll(() => currentPath(router)).toBe(`/projects/${OTHER_PROJECT.id}/overview`);
  });

  test("opens the project list when there are no projects", async () => {
    installFakeApi({ projects: [] });
    const router = renderApp("/");

    await expect.poll(() => currentPath(router)).toBe("/projects");
    await expect.element(page.getByText("No projects yet")).toBeVisible();
  });

  test("sends a visitor who is not signed in to sign-in", async () => {
    const api = installFakeApi({ signedIn: false });
    const router = renderApp(ANALYTICS);

    await expect.poll(() => currentPath(router)).toBe("/sign-in");
    await expect.element(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    expect(api.requests.filter((path) => path.startsWith("/api/projects"))).toEqual([]);
  });
});
