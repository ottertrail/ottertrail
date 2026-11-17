import { describe, expect, test } from "vite-plus/test";
import { page } from "vite-plus/test/browser/context";

import { installFakeApi, ORGANIZATION } from "./fake-api.ts";
import { renderApp } from "./render.tsx";

describe("the organization's settings", () => {
  test("the workspace menu carries the organization's name and leads to its settings", async () => {
    installFakeApi();
    renderApp("/projects");

    const workspace = page.getByRole("navigation", { name: "Workspace" });
    await expect.element(page.getByText("Acme Inc", { exact: true })).toBeVisible();
    await workspace.getByRole("link", { name: "Settings" }).click();

    await expect.element(page.getByRole("heading", { name: "Organization" })).toBeVisible();
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
      path: `/api/organizations/${ORGANIZATION.id}`,
      body: { name: "Acme Labs", timeZone: "Europe/Berlin" },
    });
    // The menu shows the new name, and the warning is gone with the change saved.
    await expect.element(page.getByText("Acme Labs", { exact: true }).first()).toBeVisible();
    await expect.element(page.getByText(/Reports count days in this timezone/)).toBeVisible();
  });

  test("a member sees the settings but cannot change them", async () => {
    installFakeApi({ organizations: [{ ...ORGANIZATION, role: "member" }] });
    renderApp("/settings");

    await expect
      .element(page.getByText("Only the organization's owner can change these."))
      .toBeVisible();
    await expect.element(page.getByRole("textbox", { name: "Name" })).toBeDisabled();
    await expect.element(page.getByRole("combobox", { name: "Timezone" })).toBeDisabled();
    await expect
      .element(page.getByRole("button", { name: "Save changes" }))
      .not.toBeInTheDocument();
  });

  test("says so when the account belongs to no organization", async () => {
    installFakeApi({ organizations: [] });
    renderApp("/settings");

    await expect.element(page.getByText("No organization")).toBeVisible();
    // The menu falls back to a neutral name.
    await expect.element(page.getByText("Workspace", { exact: true })).toBeVisible();
  });

  test("signing out forgets the organization before someone else signs in", async () => {
    const api = installFakeApi();
    const router = renderApp("/projects");
    await expect.element(page.getByText("Acme Inc", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Sign out" }).click();
    await expect.poll(() => router.state.location.pathname).toBe("/sign-in");

    // Someone from another organization signs in on the same browser.
    api.organizations = [
      { ...ORGANIZATION, id: "88888888-8888-4888-8888-888888888888", name: "Other Co" },
    ];
    api.projects = [];
    await page.getByRole("textbox", { name: "Email" }).fill("other@example.com");
    await page.getByLabelText("Password").fill("correct horse battery");
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect.element(page.getByText("Other Co", { exact: true })).toBeVisible();
    await expect.element(page.getByText("Acme Inc", { exact: true })).not.toBeInTheDocument();
  });
});
