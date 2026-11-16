import { describe, expect, test } from "vite-plus/test";
import { page } from "vite-plus/test/browser/context";

import { installFakeApi, OTHER_PROJECT, PROJECT } from "./fake-api.ts";
import { unmountAll } from "./mounted.ts";
import { currentPath, renderApp } from "./render.tsx";

const ANALYTICS = `/projects/${PROJECT.id}/web-analytics`;
const SETTINGS = `/projects/${PROJECT.id}/settings`;
const LAST_PROJECT_KEY = "ottertrail.project";

const workspaceMenu = () => page.getByRole("navigation", { name: "Workspace" });
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

    await expect.element(page.getByRole("link", { name: "Main site" })).toBeVisible();
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

    await page.getByRole("link", { name: "Main site" }).click();

    await expect.poll(() => currentPath(router)).toBe(ANALYTICS);
    await expect.element(page.getByRole("heading", { name: "Visitors per day" })).toBeVisible();
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
    await expect.element(projectMenu().getByRole("link", { name: "Settings" })).toBeVisible();
    // Modules that are not built yet are shown, disabled and labeled.
    for (const module of ["Product analytics", "Users", "Errors", "Email"]) {
      await expect.element(projectMenu().getByRole("button", { name: module })).toBeDisabled();
    }
    await expect.element(projectMenu().getByText("Planned").first()).toBeVisible();
    // The project's menu in order, settings last, right after the modules.
    const items = document.querySelectorAll("nav[aria-label=Project] [data-sidebar=menu-button]");
    expect([...items].map((item) => item.textContent)).toEqual([
      "All projects",
      "Web analytics",
      "Product analytics",
      "Users",
      "Errors",
      "Email",
      "Settings",
    ]);
    // Right under Email, not pinned to the bottom of the sidebar.
    const email = items[5]?.getBoundingClientRect();
    const settings = items[6]?.getBoundingClientRect();
    expect((settings?.top ?? 0) - (email?.bottom ?? 0)).toBeLessThan(8);
    await expect.poll(breadcrumb).toBe("Main site / Web analytics");
  });

  test("the project's address alone opens its web analytics", async () => {
    installFakeApi();
    const router = renderApp(`/projects/${PROJECT.id}`);

    await expect.poll(() => currentPath(router)).toBe(ANALYTICS);
  });

  test("Settings shows the install snippet and the project's settings", async () => {
    installFakeApi();
    const router = renderApp(ANALYTICS);

    await projectMenu().getByRole("link", { name: "Settings" }).click();

    await expect.poll(() => currentPath(router)).toBe(SETTINGS);
    await expect.element(page.getByRole("heading", { name: "Install" })).toBeVisible();
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

  test("the switcher keeps you on Settings", async () => {
    installFakeApi({ projects: [PROJECT, OTHER_PROJECT] });
    const router = renderApp(SETTINGS);

    await switcher("Main site").click();
    await page.getByRole("menuitem", { name: "Docs" }).click();

    await expect.poll(() => currentPath(router)).toBe(`/projects/${OTHER_PROJECT.id}/settings`);
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

    await expect.poll(() => currentPath(router)).toBe(ANALYTICS);
  });

  test("opens the project this browser showed last", async () => {
    installFakeApi({ projects: [PROJECT, OTHER_PROJECT] });
    renderApp(`/projects/${OTHER_PROJECT.id}/settings`);
    await expect.poll(() => window.localStorage.getItem(LAST_PROJECT_KEY)).toBe(OTHER_PROJECT.id);
    unmountAll();

    const router = renderApp("/");

    await expect
      .poll(() => currentPath(router))
      .toBe(`/projects/${OTHER_PROJECT.id}/web-analytics`);
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
