import { afterEach, describe, expect, test } from "vite-plus/test";
import { page } from "vite-plus/test/browser/context";

import { ADMIN_ACCESS, installFakeApi, memberAccess, PROJECT } from "./fake-api.ts";
import { currentPath, renderApp } from "./render.tsx";

/*
 * The instance's Settings as tabs (docs/dashboard.md, "Settings"): which
 * tabs each role sees, the save rule on the form tabs, the leave guard, and
 * the links from elsewhere that land on the right tab. The fields are in
 * settings.test.tsx, location-data.test.tsx and channels.test.tsx.
 */

const workspaceMenu = () => page.getByRole("navigation", { name: "Instance" });
const tabNames = () =>
  page
    .getByRole("tablist", { name: "Instance settings" })
    .getByRole("tab")
    .elements()
    .map((tab) => tab.textContent);
const panel = () => page.getByRole("tabpanel");
const form = () => page.getByRole("form", { name: "Instance" });
const save = () => form().getByRole("button", { name: "Save instance settings" });
const status = () => form().getByRole("status");
/** Waits long enough for a click's effect to show, before asserting it had none. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

afterEach(async () => {
  await page.viewport(1280, 900);
});

describe("the tabs each role sees", () => {
  test("the owner has General, Location data, Storage, AI models, Backups and Notification channels, General first", async () => {
    installFakeApi();
    const router = renderApp("/projects");
    await workspaceMenu().getByRole("link", { name: "Settings" }).click();

    await expect.element(page.getByRole("tablist", { name: "Instance settings" })).toBeVisible();
    expect(tabNames()).toEqual([
      "General",
      "Location data",
      "Storage",
      "AI models",
      "Backups",
      "Notification channels",
    ]);
    await expect.element(panel().getByRole("heading", { name: "Instance" })).toBeVisible();
    expect(currentPath(router)).toBe("/settings");

    await page.getByRole("tab", { name: "Location data" }).click();
    await expect.poll(() => router.state.location.search).toEqual({ tab: "location-data" });
    await expect.element(panel().getByRole("heading", { name: "Location data" })).toBeVisible();
    await page.getByRole("tab", { name: "General" }).click();
    await expect.poll(() => currentPath(router)).toBe("/settings");
  });

  test("an admin has Storage, AI models and the channels, Storage first", async () => {
    installFakeApi({ access: ADMIN_ACCESS });
    renderApp("/settings");

    await expect.element(page.getByRole("tablist", { name: "Instance settings" })).toBeVisible();
    expect(tabNames()).toEqual(["Storage", "AI models", "Notification channels"]);
    await expect
      .element(panel().getByRole("heading", { name: "What fills the disk" }))
      .toBeVisible();
    await page.getByRole("tab", { name: "Notification channels" }).click();
    await expect
      .element(panel().getByRole("heading", { name: "Notification channels" }))
      .toBeVisible();
  });

  test("an admin who opens an owner's tab by its address gets Storage", async () => {
    const api = installFakeApi({ access: ADMIN_ACCESS });
    renderApp("/settings?tab=general");

    await expect.element(page.getByRole("tab", { name: "Storage", selected: true })).toBeVisible();
    await expect
      .element(panel().getByRole("heading", { name: "What fills the disk" }))
      .toBeVisible();
    await settle();
    // The owner's settings are never asked for; the storage and the AI models, which admins may read, are.
    expect(api.requests.filter((path) => path.startsWith("/api/settings")).toSorted()).toEqual([
      "/api/settings/ai-models",
      "/api/settings/storage",
    ]);
  });

  test("a storage notification's link opens the Storage tab", async () => {
    installFakeApi();
    // The URL storage.low and storage.recovered carry (apps/api/src/storage/warning-job.ts).
    const router = renderApp("/settings?tab=storage");
    await expect.element(page.getByRole("tab", { name: "Storage", selected: true })).toBeVisible();
    await expect
      .element(panel().getByRole("heading", { name: "What fills the disk" }))
      .toBeVisible();
    expect(currentPath(router)).toBe("/settings?tab=storage");
  });

  test("every tab stays mounted: the storage is measured when the page opens, on any tab", async () => {
    const api = installFakeApi();
    renderApp("/settings");
    await expect.element(panel().getByRole("heading", { name: "Instance" })).toBeVisible();
    await expect
      .poll(() => api.requests.filter((path) => path === "/api/settings/storage"))
      .toEqual(["/api/settings/storage"]);
  });

  test("a member has no tabs", async () => {
    installFakeApi({ access: memberAccess({ web_analytics: "view" }) });
    renderApp("/settings?tab=channels");
    await expect.element(page.getByText("You don't have access")).toBeVisible();
    await expect.element(page.getByRole("tablist")).not.toBeInTheDocument();
  });
});

describe("the save rule on General", () => {
  test("Save waits for a change, Discard undoes it, and the tab says it is unsaved", async () => {
    const api = installFakeApi();
    renderApp("/settings");
    const name = form().getByRole("textbox", { name: "Name" });
    await expect.element(name).toHaveValue("Acme Inc");

    await expect.element(status()).toHaveTextContent("No unsaved changes");
    await expect.element(save()).toHaveAttribute("aria-disabled", "true");
    expect(form().getByRole("button", { name: "Discard" }).elements()).toEqual([]);

    await name.fill("Acme Labs");
    await expect.element(status()).toHaveTextContent("Unsaved changes");
    await expect.element(save()).not.toHaveAttribute("aria-disabled", "true");
    await expect
      .element(page.getByRole("tab", { name: /^General\s*, unsaved changes$/ }))
      .toBeVisible();

    // Undoing the edit by hand, or with spaces around it, is no change either.
    await name.fill(" Acme Inc ");
    await expect.element(save()).toHaveAttribute("aria-disabled", "true");

    await name.fill("Acme Labs");
    await form().getByRole("button", { name: "Discard" }).click();
    await expect.element(name).toHaveValue("Acme Inc");
    await expect.element(status()).toHaveTextContent("No unsaved changes");
    await expect.element(page.getByRole("tab", { name: "General" })).toHaveTextContent("General");
    await settle();
    expect(api.bodies).toEqual([]);
  });

  test("a failed save says why and keeps the edits", async () => {
    installFakeApi();
    renderApp("/settings");
    const name = form().getByRole("textbox", { name: "Name" });
    await expect.element(name).toHaveValue("Acme Inc");

    const realFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) =>
      init?.method === "PATCH"
        ? new Response(JSON.stringify({ error: "internal", message: "The database is down." }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          })
        : realFetch(input, init);
    try {
      await name.fill("Acme Labs");
      await save().click();
      await expect
        .element(form().getByRole("alert"))
        .toMatchTextContent(/^The changes were not saved\s*The database is down\.$/);
    } finally {
      globalThis.fetch = realFetch;
    }
    await expect.element(name).toHaveValue("Acme Labs");
    await expect.element(status()).toHaveTextContent("Unsaved changes");
  });

  test("leaving with unsaved changes asks first; another tab keeps them", async () => {
    installFakeApi();
    const router = renderApp("/settings");
    await form().getByRole("textbox", { name: "Name" }).fill("Acme Labs");

    // Another tab of the page is not leaving it: the edit stays.
    await page.getByRole("tab", { name: "Notification channels" }).click();
    await page.getByRole("tab", { name: /^General\s*, unsaved changes$/ }).click();
    await expect.element(form().getByRole("textbox", { name: "Name" })).toHaveValue("Acme Labs");

    await workspaceMenu().getByRole("link", { name: "Projects" }).click();
    const ask = page.getByRole("dialog", { name: "Leave without saving?" });
    await expect.element(ask).toBeVisible();
    await ask.getByRole("button", { name: "Stay on this page" }).click();
    await expect.element(ask).not.toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/settings");

    await workspaceMenu().getByRole("link", { name: "Projects" }).click();
    await page.getByRole("button", { name: "Leave and discard" }).click();
    await expect.poll(() => router.state.location.pathname).toBe("/projects");
  });

  test("the Storage tab's unsaved channel choice marks the tab, and leaving asks first", async () => {
    installFakeApi();
    const router = renderApp("/settings?tab=storage");
    await panel().getByRole("checkbox", { name: "Pager webhook (webhook)" }).click();
    await expect
      .element(page.getByRole("tab", { name: /^Storage\s*, unsaved changes$/ }))
      .toBeVisible();
    await workspaceMenu().getByRole("link", { name: "Projects" }).click();
    const ask = page.getByRole("dialog", { name: "Leave without saving?" });
    await expect.element(ask).toBeVisible();
    await ask.getByRole("button", { name: "Leave and discard" }).click();
    await expect.poll(() => router.state.location.pathname).toBe("/projects");
  });

  test("the channels tab has no Save bar: its changes are dialogs and actions", async () => {
    installFakeApi();
    renderApp("/settings?tab=channels");
    await expect
      .element(panel().getByRole("heading", { name: "Notification channels" }))
      .toBeVisible();
    expect(
      document.querySelectorAll("[role=tabpanel]:not([hidden]) [data-slot=save-bar]"),
    ).toHaveLength(0);
  });
});

describe("links into Settings land on the channels", () => {
  test("from the Alerts page, Channels are in Settings", async () => {
    installFakeApi();
    const router = renderApp(`/projects/${PROJECT.id}/alerts`);
    await page.getByRole("link", { name: "Channels are in Settings" }).click();
    await expect.poll(() => currentPath(router)).toBe("/settings?tab=channels");
    await expect
      .element(panel().getByRole("heading", { name: "Notification channels" }))
      .toBeVisible();
    await expect
      .element(page.getByRole("tab", { name: "Notification channels" }))
      .toHaveAttribute("aria-selected", "true");
  });

  test("from the Alerts page with no channels, Go to Settings", async () => {
    const api = installFakeApi({ alerts: { rules: [], firing: [], history: [] } });
    api.channels.list = [];
    const router = renderApp(`/projects/${PROJECT.id}/alerts`);
    await page.getByRole("link", { name: "Go to Settings" }).click();
    await expect.poll(() => currentPath(router)).toBe("/settings?tab=channels");
    await expect.element(panel().getByText("No channels yet")).toBeVisible();
  });

  test("from the rule form with no channels, Add one in Settings", async () => {
    const api = installFakeApi();
    api.channels.list = [];
    const router = renderApp(`/projects/${PROJECT.id}/alerts`);
    // Editing a rule whose channels are all gone: the form says where to add one.
    await page.getByRole("button", { name: "Edit API down" }).click();
    await page.getByRole("link", { name: "Add one in Settings" }).click();
    await expect.poll(() => currentPath(router)).toBe("/settings?tab=channels");
    await expect.element(panel().getByText("No channels yet")).toBeVisible();
  });
});

describe("the Settings page fits", () => {
  for (const [width, height] of [
    [390, 844],
    [1440, 900],
  ] as const) {
    for (const tab of ["general", "location-data", "storage", "ai-models", "channels"]) {
      test(`at ${width} wide, the ${tab} tab: the tab row scrolls inside itself, nothing else sideways`, async () => {
        await page.viewport(width, height);
        installFakeApi();
        renderApp(`/settings?tab=${tab}`);

        await expect.element(panel().getByRole("heading").first()).toBeVisible();
        const content = document.querySelector("[data-slot=app-content]");
        expect(content?.scrollWidth).toBeLessThanOrEqual(content?.clientWidth ?? 0);
        expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
        // The tabs never wrap onto a second row.
        const tops = new Set(
          page
            .getByRole("tab")
            .elements()
            .map((element) => Math.round(element.getBoundingClientRect().top)),
        );
        expect(tops.size).toBe(1);
        // No text spills out of the panel.
        const shown = document.querySelector<HTMLElement>("[role=tabpanel]:not([hidden])");
        expect(shown?.scrollWidth).toBeLessThanOrEqual(shown?.clientWidth ?? 0);
      });
    }
  }
});
