import { describe, expect, test } from "vite-plus/test";
import { page } from "vite-plus/test/browser/context";

import { ERROR_FINGERPRINTS, installFakeApi, memberAccess, PROJECT } from "./fake-api.ts";
import { currentPath, renderApp } from "./render.tsx";

const projectMenu = () => page.getByRole("navigation", { name: "Project" });
const workspaceMenu = () => page.getByRole("navigation", { name: "Instance" });
const ERROR_PAGE = `/projects/${PROJECT.id}/errors/${ERROR_FINGERPRINTS.typeError}`;

describe("a member's dashboard shows only what they may use", () => {
  test("the project menu lists only the member's areas, without the project's settings", async () => {
    installFakeApi({ access: memberAccess({ errors: "view", monitoring: "view" }) });
    renderApp(`/projects/${PROJECT.id}/errors`);

    await expect.element(projectMenu().getByRole("link", { name: "Errors" })).toBeVisible();
    await expect.element(projectMenu().getByRole("link", { name: "Traces" })).toBeVisible();
    await expect.element(projectMenu().getByRole("link", { name: "Hosts" })).toBeVisible();
    for (const name of [
      "Web analytics",
      "Speed",
      "Heatmaps",
      "Users",
      "Replays",
      "Uptime",
      "Alerts",
      "Product analytics",
      "Settings",
    ]) {
      await expect.element(projectMenu().getByRole("link", { name })).not.toBeInTheDocument();
    }
    // AI is an area of its own.
    await expect
      .element(projectMenu().getByRole("link", { name: "AI", exact: true }))
      .not.toBeInTheDocument();
  });

  test("a page outside the member's areas says so, and the project opens on its overview", async () => {
    installFakeApi({ access: memberAccess({ errors: "view" }) });
    const router = renderApp(`/projects/${PROJECT.id}/web-analytics`);
    await expect.element(page.getByText("You don't have access")).toBeVisible();

    await projectMenu().getByRole("link", { name: "Errors" }).click();
    await expect.poll(() => router.state.location.pathname).toBe(`/projects/${PROJECT.id}/errors`);

    const opened = renderApp(`/projects/${PROJECT.id}`);
    await expect
      .poll(() => opened.state.location.pathname)
      .toBe(`/projects/${PROJECT.id}/overview`);
  });

  test("the home page opens the first area of the member's first project, without the overview's", async () => {
    installFakeApi({ access: memberAccess({ users: "view", replays: "view" }) });
    const router = renderApp("/");
    await expect
      .poll(() => currentPath(router))
      .toMatch(new RegExp(`^/projects/${PROJECT.id}/users`));
  });

  test("a project's settings say the member has no access", async () => {
    installFakeApi({ access: memberAccess({ web_analytics: "view" }) });
    renderApp(`/projects/${PROJECT.id}/settings`);
    await expect.element(page.getByText("You don't have access")).toBeVisible();
    await expect.element(page.getByRole("heading", { name: "Install" })).not.toBeInTheDocument();
  });

  test("the project list has no New project button and no allowed sites", async () => {
    installFakeApi({ access: memberAccess({ web_analytics: "view" }) });
    renderApp("/projects");

    await expect.element(page.getByRole("link", { name: "Main site", exact: true })).toBeVisible();
    await expect.element(page.getByRole("button", { name: "New project" })).not.toBeInTheDocument();
    await expect
      .element(page.getByRole("columnheader", { name: "Allowed sites" }))
      .not.toBeInTheDocument();
    await expect
      .element(workspaceMenu().getByRole("link", { name: "Settings" }))
      .not.toBeInTheDocument();
  });

  test("a member without projects is told to ask an admin", async () => {
    installFakeApi({ access: memberAccess({ web_analytics: "view" }, []) });
    renderApp("/projects");
    await expect.element(page.getByText(/Ask an admin of this instance/)).toBeVisible();
  });

  test("an error's page has no links into areas the member lacks, and no Resolve for a viewer", async () => {
    installFakeApi({ access: memberAccess({ errors: "view" }) });
    renderApp(ERROR_PAGE);

    const occurrences = page.getByRole("table", { name: "Latest occurrences, newest first" });
    await expect.element(occurrences).toBeVisible();
    // The user ID shows, as text: a known limit (docs/access.md).
    await expect.element(occurrences.getByText("ada", { exact: true })).toBeVisible();
    await expect.element(occurrences.getByRole("link", { name: "ada" })).not.toBeInTheDocument();
    expect(
      [...occurrences.element().querySelectorAll("thead th")].map((cell) => cell.textContent),
    ).not.toContain("Replay");
    await expect
      .element(page.getByRole("heading", { name: "Alert rules" }))
      .not.toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "Resolve" })).not.toBeInTheDocument();
  });

  test("with users, replays, and uptime and alerts, the same page links to them", async () => {
    installFakeApi({
      access: memberAccess({
        errors: "manage",
        users: "view",
        replays: "view",
        uptime_alerts: "view",
      }),
    });
    renderApp(ERROR_PAGE);

    const occurrences = page.getByRole("table", { name: "Latest occurrences, newest first" });
    await expect.element(occurrences.getByRole("link", { name: "ada" })).toBeVisible();
    expect(
      [...occurrences.element().querySelectorAll("thead th")].map((cell) => cell.textContent),
    ).toContain("Replay");
    await expect.element(page.getByRole("heading", { name: "Alert rules" })).toBeVisible();
    // Viewing alerts does not add rules.
    await expect
      .element(page.getByRole("link", { name: "Add an alert rule" }))
      .not.toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "Resolve" })).toBeVisible();
  });

  test("the Alerts page lets a viewer read the rules, not change them or reach the channels", async () => {
    installFakeApi({ access: memberAccess({ uptime_alerts: "view" }) });
    renderApp(`/projects/${PROJECT.id}/alerts`);

    await expect.element(page.getByRole("table", { name: "Alert rules" })).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Add rule" })).not.toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: /^Edit / })).not.toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: /^Delete / })).not.toBeInTheDocument();
    await expect
      .element(page.getByRole("link", { name: "Channels are in Settings" }))
      .not.toBeInTheDocument();
    for (const toggle of page.getByRole("switch").all()) {
      await expect.element(toggle).toBeDisabled();
    }
  });

  test("web analytics leaves out goals without product analytics", async () => {
    installFakeApi({ access: memberAccess({ web_analytics: "view" }) });
    renderApp(`/projects/${PROJECT.id}/web-analytics`);

    await expect.element(page.getByRole("heading", { name: "Visitors per day" })).toBeVisible();
    await expect.element(page.getByRole("heading", { name: "Goals" })).not.toBeInTheDocument();
  });

  test("the rule form offers only the kinds whose area the member has", async () => {
    installFakeApi({ access: memberAccess({ uptime_alerts: "manage", errors: "view" }) });
    renderApp(`/projects/${PROJECT.id}/alerts`);

    await page.getByRole("button", { name: "Add rule" }).click();
    const form = page.getByRole("dialog", { name: "Add an alert rule" });
    await form.getByRole("combobox", { name: "When" }).click();
    // The list renders after the click resolves: wait for it, not just read it.
    await expect
      .poll(() =>
        page
          .getByRole("option")
          .elements()
          .map((option) => option.textContent),
      )
      .toEqual([
        "Check down",
        "Certificate expiring",
        "New error",
        "Regressed error",
        "Error spike",
      ]);
  });
});
