import { describe, expect, test } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser/context";

import { ADMIN_ACCESS, installFakeApi, memberAccess, SETTINGS } from "./fake-api.ts";
import { renderApp } from "./render.tsx";

describe("the instance's settings", () => {
  test("the workspace menu carries the instance's name and leads to its settings", async () => {
    installFakeApi();
    renderApp("/projects");

    const workspace = page.getByRole("navigation", { name: "Instance" });
    await expect.element(page.getByText("Acme Inc", { exact: true })).toBeVisible();
    await workspace.getByRole("link", { name: "Settings" }).click();

    await expect.element(page.getByRole("heading", { name: "Instance" })).toBeVisible();
    await expect.element(page.getByRole("textbox", { name: "Name" })).toHaveValue("Acme Inc");
    await expect
      .element(page.getByRole("combobox", { name: "Timezone" }))
      .toHaveValue("Asia/Singapore");
  });

  test("the owner renames it and changes its timezone, warned first about moving days", async () => {
    const api = installFakeApi();
    renderApp("/settings");
    const timeZone = page.getByRole("combobox", { name: "Timezone" });
    await expect.element(timeZone).toHaveValue("Asia/Singapore");
    await expect
      .element(page.getByText(/Reports use this timezone for day boundaries/))
      .toBeVisible();

    await page.getByRole("textbox", { name: "Name" }).fill("Acme Labs");
    await timeZone.fill("berlin");
    await page.getByRole("option", { name: /^Europe\/Berlin/ }).click();
    await expect.element(timeZone).toHaveValue("Europe/Berlin");
    await expect
      .element(page.getByText(/Changes day boundaries in past reports too/))
      .toBeVisible();
    await page.getByRole("button", { name: "Save instance settings" }).click();

    // The Save bar says the change is saved (it said "Saved." before the save rule).
    await expect
      .element(page.getByRole("form", { name: "Instance" }).getByRole("status"))
      .toHaveTextContent("No unsaved changes");
    expect(api.bodies).toContainEqual({
      method: "PATCH",
      path: "/api/settings",
      body: { name: "Acme Labs", timeZone: "Europe/Berlin" },
    });
    // The menu shows the new name, and the warning is gone with the change saved.
    await expect.element(page.getByText("Acme Labs", { exact: true }).first()).toBeVisible();
    await expect
      .element(page.getByText(/Reports use this timezone for day boundaries/))
      .toBeVisible();
  });

  test("the timezone list filters by any part of the name, spaces matching underscores", async () => {
    installFakeApi();
    renderApp("/settings");
    const timeZone = page.getByRole("combobox", { name: "Timezone" });
    await expect.element(timeZone).toHaveValue("Asia/Singapore");

    await timeZone.fill("new york");
    await expect.element(page.getByRole("option", { name: /^America\/New_York \(/ })).toBeVisible();
    await expect
      .element(page.getByRole("option", { name: /^Asia\/Singapore/ }))
      .not.toBeInTheDocument();

    // Case does not matter, and each option shows its offset from UTC (Singapore has no summer time).
    await timeZone.fill("SINGAPORE");
    await expect
      .element(page.getByRole("option", { name: "Asia/Singapore (UTC+8)" }))
      .toBeVisible();
    await expect.element(page.getByRole("option", { name: /^America\// })).not.toBeInTheDocument();
  });

  test("the timezone list says when nothing matches", async () => {
    installFakeApi();
    renderApp("/settings");
    const timeZone = page.getByRole("combobox", { name: "Timezone" });
    await expect.element(timeZone).toHaveValue("Asia/Singapore");

    await timeZone.fill("atlantis");
    await expect.element(page.getByText("No matching timezone")).toBeVisible();
    await expect.element(page.getByRole("option").first()).not.toBeInTheDocument();
  });

  test("a timezone is chosen with the arrow keys and Enter, and Escape closes the list", async () => {
    const api = installFakeApi();
    renderApp("/settings");
    const timeZone = page.getByRole("combobox", { name: "Timezone" });
    await expect.element(timeZone).toHaveValue("Asia/Singapore");

    await timeZone.fill("north dakota");
    // The first match is highlighted as soon as one types; ArrowDown moves to the next.
    const first = page.getByRole("option", { name: /^America\/North_Dakota\/Beulah \(/ });
    await expect.element(first).toHaveAttribute("data-highlighted");
    await userEvent.keyboard("{ArrowDown}");
    const second = page.getByRole("option", { name: /^America\/North_Dakota\/Center \(/ });
    await expect.element(second).toHaveAttribute("data-highlighted");
    await expect.element(first).not.toHaveAttribute("data-highlighted");
    await userEvent.keyboard("{Enter}");
    await expect.element(timeZone).toHaveValue("America/North_Dakota/Center");
    await expect.element(page.getByRole("listbox")).not.toBeInTheDocument();

    await userEvent.keyboard("{ArrowDown}");
    await expect.element(page.getByRole("listbox")).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await expect.element(page.getByRole("listbox")).not.toBeInTheDocument();
    await expect.element(timeZone).toHaveValue("America/North_Dakota/Center");

    await page.getByRole("button", { name: "Save instance settings" }).click();
    await expect
      .element(page.getByRole("form", { name: "Instance" }).getByRole("status"))
      .toHaveTextContent("No unsaved changes");
    expect(api.bodies).toContainEqual({
      method: "PATCH",
      path: "/api/settings",
      body: { name: "Acme Inc", timeZone: "America/North_Dakota/Center" },
    });
  });

  test("an admin sees the channels, but not the instance's name and timezone", async () => {
    installFakeApi({ access: ADMIN_ACCESS });
    // An admin's Settings opens on Storage; the channels are their other tab.
    renderApp("/settings?tab=channels");

    await expect
      .element(page.getByRole("heading", { name: "Notification channels" }))
      .toBeVisible();
    await expect.element(page.getByRole("heading", { name: "Instance" })).not.toBeInTheDocument();
    await expect.element(page.getByRole("textbox", { name: "Name" })).not.toBeInTheDocument();
  });

  test("a member has no Settings page, and no link to it", async () => {
    installFakeApi({ access: memberAccess({ web_analytics: "view" }) });
    renderApp("/settings");

    await expect.element(page.getByText("You don't have access")).toBeVisible();
    const workspace = page.getByRole("navigation", { name: "Instance" });
    await expect.element(workspace.getByRole("link", { name: "Projects" })).toBeVisible();
    await expect.element(workspace.getByRole("link", { name: "Settings" })).not.toBeInTheDocument();
  });

  test("signing out forgets the settings before someone else signs in", async () => {
    const api = installFakeApi();
    const router = renderApp("/projects");
    await expect.element(page.getByText("Acme Inc", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: /Account menu$/ }).click();
    await page.getByRole("menuitem", { name: "Sign out" }).click();
    await expect.poll(() => router.state.location.pathname).toBe("/sign-in");

    // Another user signs in on the same browser, after the settings changed.
    api.settings = { ...SETTINGS, name: "Other Co" };
    api.access = memberAccess({ web_analytics: "view" });
    api.projects = [];
    await page.getByRole("textbox", { name: "Email" }).fill("other@example.com");
    await page.getByLabelText("Password").fill("correct horse battery");
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect.element(page.getByText("Other Co", { exact: true })).toBeVisible();
    await expect.element(page.getByText("Acme Inc", { exact: true })).not.toBeInTheDocument();
  });
});
