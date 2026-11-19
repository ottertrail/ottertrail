import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser/context";

import { AGENT_DOCS_URL } from "../../src/features/projects/format.ts";
import { installFakeApi, PROJECT } from "./fake-api.ts";
import { renderApp } from "./render.tsx";

/*
 * The project's settings as tabs with a Save bar (docs/design-system.md,
 * "Settings tabs and the Save bar"): the save rule on each form tab, the
 * leave guard, the confirmations, and the setup prompt. The fields
 * themselves are in project-settings.test.tsx, replays.test.tsx and
 * source-maps.test.tsx.
 */

const SETTINGS = `/projects/${PROJECT.id}/settings`;

afterEach(async () => {
  await page.viewport(1280, 900);
});

const panel = () => page.getByRole("tabpanel");
const status = () => panel().getByRole("status");
const save = () => panel().getByRole("button", { name: "Save changes" });

describe("the settings tabs", () => {
  test("opens on Install, keeps the tab in the address, and lists every section", async () => {
    installFakeApi();
    const router = renderApp(SETTINGS);

    const tabs = page.getByRole("tablist", { name: "Project settings" });
    await expect.element(tabs).toBeVisible();
    expect(
      tabs
        .getByRole("tab")
        .elements()
        .map((tab) => tab.textContent),
    ).toEqual([
      "Install",
      "General",
      "Your server",
      "Spam and bots",
      "Source maps",
      "Session replay",
      "Danger zone",
    ]);
    await expect.element(panel().getByRole("heading", { name: "Install" })).toBeVisible();

    await page.getByRole("tab", { name: "Danger zone" }).click();
    await expect.poll(() => router.state.location.search).toEqual({ tab: "danger" });
    await expect.element(panel().getByRole("heading", { name: "Danger zone" })).toBeVisible();
  });

  test("General: Save waits for a change, Discard undoes it, and the tab says it is unsaved", async () => {
    installFakeApi();
    renderApp(`${SETTINGS}?tab=general`);
    const name = page.getByRole("textbox", { name: "Name" });
    await expect.element(name).toHaveValue("Main site");

    await expect.element(status()).toHaveTextContent("No unsaved changes");
    await expect.element(save()).toHaveAttribute("aria-disabled", "true");
    expect(panel().getByRole("button", { name: "Discard" }).elements()).toEqual([]);

    await name.fill("Main site 2");
    await expect.element(status()).toHaveTextContent("Unsaved changes");
    await expect.element(save()).not.toHaveAttribute("aria-disabled", "true");
    await expect
      .element(page.getByRole("tab", { name: /^General\s*, unsaved changes$/ }))
      .toBeVisible();

    // Undoing the edit by hand is no change either.
    await name.fill("Main site");
    await expect.element(save()).toHaveAttribute("aria-disabled", "true");

    await name.fill("Shop");
    await panel().getByRole("button", { name: "Discard" }).click();
    await expect.element(name).toHaveValue("Main site");
    await expect.element(status()).toHaveTextContent("No unsaved changes");
  });

  test("General: the same sites in another order are no change", async () => {
    installFakeApi({
      projects: [{ ...PROJECT, allowedHostnames: ["example.com", "www.example.com"] }],
    });
    renderApp(`${SETTINGS}?tab=general`);
    const sites = page.getByRole("textbox", { name: "Allowed sites" });
    await expect.element(sites).toHaveValue("example.com\nwww.example.com");

    await sites.fill("www.example.com\nexample.com");
    await expect.element(save()).toHaveAttribute("aria-disabled", "true");
    await sites.fill("www.example.com\nexample.com\nshop.example.com");
    await expect.element(save()).not.toHaveAttribute("aria-disabled", "true");
  });

  test("Your server: the signed-IDs switch waits for Save, and Discard turns it back", async () => {
    const api = installFakeApi();
    renderApp(`${SETTINGS}?tab=server`);
    const toggle = page.getByRole("switch", { name: "Only accept user IDs signed by your server" });
    await expect.element(save()).toHaveAttribute("aria-disabled", "true");

    await toggle.click();
    await expect.element(status()).toHaveTextContent("Unsaved changes");
    await panel().getByRole("button", { name: "Discard" }).click();
    await expect.element(toggle).not.toBeChecked();
    expect(api.bodies).toEqual([]);
  });

  test("Session replay: the mode is a radio group that waits for Save", async () => {
    const api = installFakeApi();
    renderApp(`${SETTINGS}?tab=replay`);
    const group = page.getByRole("radiogroup", { name: "Record replays" });
    await expect.element(group).toBeVisible();
    await expect.element(save()).toHaveAttribute("aria-disabled", "true");

    await group.getByRole("radio", { name: /^Around errors/ }).click();
    await expect
      .element(page.getByRole("tab", { name: /^Session replay\s*, unsaved changes$/ }))
      .toBeVisible();
    expect(api.bodies).toEqual([]);
    await save().click();
    await expect.element(status()).toHaveTextContent("No unsaved changes");
    expect(api.bodies.at(-1)?.body).toEqual({ replayMode: "errors" });
  });

  test("tabs without fields have no Save bar", async () => {
    installFakeApi();
    renderApp(SETTINGS);
    for (const tab of ["Install", "Source maps", "Danger zone"]) {
      await page.getByRole("tab", { name: tab }).click();
      await expect.element(panel().getByRole("heading", { name: tab })).toBeVisible();
      expect(panel().getByRole("button", { name: "Save changes" }).elements()).toEqual([]);
    }
  });

  test("leaving with unsaved changes asks first; another tab keeps them", async () => {
    installFakeApi();
    const router = renderApp(`${SETTINGS}?tab=general`);
    await page.getByRole("textbox", { name: "Name" }).fill("Shop");

    // Another tab of the page is not leaving it: the edit stays.
    await page.getByRole("tab", { name: "Install" }).click();
    await page.getByRole("tab", { name: /^General\s*, unsaved changes$/ }).click();
    await expect.element(page.getByRole("textbox", { name: "Name" })).toHaveValue("Shop");

    await page
      .getByRole("navigation", { name: "Project" })
      .getByRole("link", { name: "Web analytics" })
      .click();
    const ask = page.getByRole("dialog", { name: "Leave without saving?" });
    await expect.element(ask).toBeVisible();
    await ask.getByRole("button", { name: "Stay on this page" }).click();
    await expect.element(ask).not.toBeInTheDocument();
    expect(router.state.location.pathname).toBe(SETTINGS);
    await expect.element(page.getByRole("textbox", { name: "Name" })).toHaveValue("Shop");

    await page
      .getByRole("navigation", { name: "Project" })
      .getByRole("link", { name: "Web analytics" })
      .click();
    await page.getByRole("button", { name: "Leave and discard" }).click();
    await expect
      .poll(() => router.state.location.pathname)
      .toBe(`/projects/${PROJECT.id}/web-analytics`);
  });

  test("deleting all replays, a release's maps, and the project each ask first", async () => {
    const api = installFakeApi();
    renderApp(`${SETTINGS}?tab=replay`);

    await page.getByRole("button", { name: "Delete all replays" }).click();
    await expect.element(page.getByRole("dialog", { name: "Delete all replays?" })).toBeVisible();
    await page.getByRole("button", { name: "Cancel" }).click();

    await page.getByRole("tab", { name: "Source maps" }).click();
    await page.getByRole("button", { name: "Delete the source maps of release 1.4.2" }).click();
    await expect
      .element(page.getByRole("dialog", { name: "Delete the source maps of release 1.4.2?" }))
      .toBeVisible();
    await page.getByRole("button", { name: "Cancel" }).click();

    await page.getByRole("tab", { name: "Danger zone" }).click();
    await page.getByRole("button", { name: "Delete project" }).click();
    const confirm = page.getByRole("dialog", { name: "Delete Main site?" });
    await expect
      .element(confirm.getByRole("button", { name: "Delete permanently" }))
      .toBeDisabled();
    await page.getByRole("button", { name: "Cancel" }).click();
    expect(api.bodies).toEqual([]);
  });
});

describe("the setup prompt", () => {
  test("copies this instance and the public key for a coding agent, never the secret key", async () => {
    installFakeApi();
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    renderApp(SETTINGS);

    await page.getByRole("button", { name: "Copy setup prompt" }).click();

    expect(writeText).toHaveBeenCalledTimes(1);
    const copied = writeText.mock.calls[0]?.[0] ?? "";
    expect(copied).toContain(AGENT_DOCS_URL);
    expect(copied).toContain(`instance is ${window.location.origin} `);
    expect(copied).toContain(`public key is ${PROJECT.publicKey}.`);
    expect(copied).toContain("OTTERTRAIL_SECRET_KEY");
    expect(copied).not.toContain("sk_");
    expect(copied).not.toContain(PROJECT.secretKey);
    await expect.element(page.getByRole("button", { name: "Copied" })).toBeVisible();
  });
});

describe("the settings page fits", () => {
  for (const [width, height] of [
    [390, 844],
    [1440, 900],
  ] as const) {
    test(`at ${width} wide: the tab row scrolls inside itself, nothing else sideways`, async () => {
      await page.viewport(width, height);
      installFakeApi();
      renderApp(`${SETTINGS}?tab=general`);

      await expect.element(page.getByRole("textbox", { name: "Name" })).toBeVisible();
      const content = document.querySelector("[data-slot=app-content]");
      expect(content?.scrollWidth).toBeLessThanOrEqual(content?.clientWidth ?? 0);
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
      // The tabs never wrap onto a second row.
      const tabs = page.getByRole("tab").elements();
      const tops = new Set(tabs.map((tab) => Math.round(tab.getBoundingClientRect().top)));
      expect(tops.size).toBe(1);
      // The Save bar sits at the foot of the screen while the form is in view.
      const bar = document.querySelector("[data-slot=save-bar]");
      expect(bar === null ? "" : getComputedStyle(bar).position).toBe("sticky");
    });
  }
});

describe("the settings, after review", () => {
  test("deleting the project with unsaved edits elsewhere leaves without asking", async () => {
    const api = installFakeApi();
    const router = renderApp(`${SETTINGS}?tab=general`);
    await page.getByRole("textbox", { name: "Name" }).fill("Shop");

    await page.getByRole("tab", { name: "Danger zone" }).click();
    await page.getByRole("button", { name: "Delete project" }).click();
    await page.getByLabelText("Type the project's name to confirm").fill("Main site");
    await page.getByRole("button", { name: "Delete permanently" }).click();

    await expect.poll(() => router.state.location.pathname).toBe("/projects");
    expect(page.getByRole("dialog", { name: "Leave without saving?" }).elements()).toEqual([]);
    expect(api.bodies.at(-1)).toEqual({
      method: "DELETE",
      path: `/api/projects/${PROJECT.id}`,
      body: { confirmName: "Main site" },
    });
  });

  test("a failed save on General says why and keeps the edits", async () => {
    installFakeApi();
    renderApp(`${SETTINGS}?tab=general`);
    const name = page.getByRole("textbox", { name: "Name" });
    await expect.element(name).toHaveValue("Main site");

    const realFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) =>
      init?.method === "PATCH"
        ? new Response(JSON.stringify({ error: "internal", message: "The database is down." }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          })
        : realFetch(input, init);
    try {
      await name.fill("Shop");
      await save().click();
      await expect
        .element(panel().getByRole("alert"))
        .toMatchTextContent(/^The changes were not saved\s*The database is down\.$/);
    } finally {
      globalThis.fetch = realFetch;
    }
    await expect.element(name).toHaveValue("Shop");
    await expect.element(status()).toHaveTextContent("Unsaved changes");
  });

  test("when the browser refuses to copy the setup prompt, it shows the prompt to copy by hand", async () => {
    installFakeApi();
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("Not allowed"));
    renderApp(SETTINGS);

    await page.getByRole("button", { name: "Copy setup prompt" }).click();

    await expect.element(page.getByRole("button", { name: "Copy failed" })).toBeVisible();
    const shown = page.getByText(/^Add Ottertrail to this app\./);
    await expect.element(shown).toBeVisible();
    expect(shown.element().textContent).toContain(`public key is ${PROJECT.publicKey}.`);
    expect(shown.element().textContent).not.toContain("sk_");
    // The button's label comes back after a moment.
    await expect
      .element(page.getByRole("button", { name: "Copy setup prompt" }), { timeout: 4000 })
      .toBeVisible();
  });

  test("without a clipboard at all (plain HTTP), the prompt shows to copy by hand", async () => {
    installFakeApi();
    const original = Object.getOwnPropertyDescriptor(Navigator.prototype, "clipboard");
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    try {
      renderApp(SETTINGS);
      await page.getByRole("button", { name: "Copy setup prompt" }).click();
      await expect.element(page.getByText(/^Add Ottertrail to this app\./)).toBeVisible();
    } finally {
      // The instance property hides the prototype's: removing it brings the clipboard back.
      Reflect.deleteProperty(navigator, "clipboard");
      expect(Object.getOwnPropertyDescriptor(Navigator.prototype, "clipboard")).toEqual(original);
    }
  });
});
