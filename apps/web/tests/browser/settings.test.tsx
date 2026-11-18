import { describe, expect, test } from "vite-plus/test";
import { page } from "vite-plus/test/browser/context";

import { ADMIN_ACCESS, installFakeApi, memberAccess, SETTINGS } from "./fake-api.ts";
import { renderApp } from "./render.tsx";

describe("the instance's settings", () => {
  test("the workspace menu carries the instance's name and leads to its settings", async () => {
    installFakeApi();
    renderApp("/projects");

    const workspace = page.getByRole("navigation", { name: "Workspace" });
    await expect.element(page.getByText("Acme Inc", { exact: true })).toBeVisible();
    await workspace.getByRole("link", { name: "Settings" }).click();

    await expect.element(page.getByRole("heading", { name: "Workspace" })).toBeVisible();
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
    await expect.element(page.getByText(/Reports count days in this timezone/)).toBeVisible();

    await page.getByRole("textbox", { name: "Name" }).fill("Acme Labs");
    await timeZone.fill("Europe/Berlin");
    await expect
      .element(page.getByText(/moves where days start in every report, past days included/))
      .toBeVisible();
    await page.getByRole("button", { name: "Save changes" }).click();

    await expect.element(page.getByText("Saved.")).toBeVisible();
    expect(api.bodies).toContainEqual({
      method: "PATCH",
      path: "/api/settings",
      body: { name: "Acme Labs", timeZone: "Europe/Berlin" },
    });
    // The menu shows the new name, and the warning is gone with the change saved.
    await expect.element(page.getByText("Acme Labs", { exact: true }).first()).toBeVisible();
    await expect.element(page.getByText(/Reports count days in this timezone/)).toBeVisible();
  });

  test("an admin sees the channels, but not the instance's name and timezone", async () => {
    installFakeApi({ access: ADMIN_ACCESS });
    renderApp("/settings");

    await expect
      .element(page.getByRole("heading", { name: "Notification channels" }))
      .toBeVisible();
    await expect.element(page.getByRole("heading", { name: "Workspace" })).not.toBeInTheDocument();
    await expect.element(page.getByRole("textbox", { name: "Name" })).not.toBeInTheDocument();
  });

  test("a member has no Settings page, and no link to it", async () => {
    installFakeApi({ access: memberAccess({ web_analytics: "view" }) });
    renderApp("/settings");

    await expect.element(page.getByText("You don't have access")).toBeVisible();
    const workspace = page.getByRole("navigation", { name: "Workspace" });
    await expect.element(workspace.getByRole("link", { name: "Projects" })).toBeVisible();
    await expect.element(workspace.getByRole("link", { name: "Settings" })).not.toBeInTheDocument();
  });

  test("signing out forgets the settings before someone else signs in", async () => {
    const api = installFakeApi();
    const router = renderApp("/projects");
    await expect.element(page.getByText("Acme Inc", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Sign out" }).click();
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
