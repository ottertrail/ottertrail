import { afterEach, describe, expect, test } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser/context";

import { installFakeApi } from "./fake-api.ts";
import { currentPath, renderApp } from "./render.tsx";

/*
 * The shared screen blocks (components/filter-bar.tsx, stat-strip.tsx,
 * breakdown-table.tsx, workbench.tsx, settings-tabs.tsx, settings-section.tsx
 * and hooks/use-dirty-form.ts), through their specimens on the design
 * system's reference page.
 */

const REFERENCE = "/design-system";

afterEach(async () => {
  await page.viewport(1280, 900);
});

const search = (router: ReturnType<typeof renderApp>) =>
  new URLSearchParams(router.state.location.searchStr);

describe("the filter bar", () => {
  test("holds the period and the filters, and shows the days and the timezone as two items", async () => {
    installFakeApi();
    renderApp(REFERENCE);

    await expect.element(page.getByText("10 to 16 Nov 2026", { exact: true })).toBeVisible();
    const element = document.querySelector("search[aria-label='Report filters']");
    if (element === null) throw new Error("No filter bar");
    const bar = page.elementLocator(element);
    await expect.element(bar.getByRole("combobox", { name: "Period" })).toBeVisible();
    await expect.element(bar.getByRole("group", { name: "Status" })).toBeVisible();
    await expect.element(bar.getByText("10 to 16 Nov 2026", { exact: true })).toBeVisible();
    await expect.element(bar.getByText("Asia/Singapore", { exact: true })).toBeVisible();
    expect(bar.element().textContent).not.toMatch(/[·–]/);
  });
});

describe("the stat strip", () => {
  test("shows each figure in tabular numerals, with its change read out as a sentence", async () => {
    installFakeApi();
    renderApp(REFERENCE);

    const strip = page.getByRole("definition").filter({ hasText: "1,820" });
    await expect.element(strip).toBeVisible();
    expect(getComputedStyle(strip.element()).fontVariantNumeric).toContain("tabular-nums");
    await expect.element(page.getByText("Up 12% from 683")).toBeInTheDocument();
    await expect.element(page.getByText("Down 6 points from 30%")).toBeInTheDocument();
    await expect.element(page.getByText("No change from 824")).toBeInTheDocument();
  });

  test("leaves out a change that rests on fewer than its minimum count", async () => {
    installFakeApi();
    renderApp(REFERENCE);

    // Up from 2 visits would read as 200%: the figures stand alone.
    await expect
      .poll(() => document.querySelector("dl[aria-label='Summary with few visits']")?.textContent)
      .toBe("Visitors6Visits7Pageviews9");
  });
});

describe("the breakdown table", () => {
  test("lists rows with bars in proportion, switches lists with its tabs, and offers show all", async () => {
    installFakeApi();
    renderApp(REFERENCE);

    const pages = page.getByRole("region", { name: "Pages" });
    const table = pages.getByRole("table", { name: "Pages, the most visitors first" });
    await expect.element(table).toBeVisible();
    const bars = [...pages.element().querySelectorAll<HTMLElement>("[data-slot=breakdown-bar]")];
    expect(bars.map((bar) => Math.round(Number.parseFloat(bar.style.width)))).toEqual([
      100,
      Math.round((201 / 322) * 100),
      Math.round((88 / 322) * 100),
    ]);
    await expect.element(table.getByRole("cell", { name: "/docs/getting-started" })).toBeVisible();

    // One table whose rows change: toggle buttons, not tabs without panels.
    expect(pages.element().querySelector("[role=tab], [role=tablist]")).toBeNull();
    const views = pages.getByRole("group", { name: "Which pages to list" });
    await expect
      .element(views.getByRole("button", { name: "Top pages" }))
      .toHaveAttribute("aria-pressed", "true");
    await views.getByRole("button", { name: "Entry" }).click();
    await expect
      .element(views.getByRole("button", { name: "Entry" }))
      .toHaveAttribute("aria-pressed", "true");
    // Pressing the shown list again keeps it shown.
    await views.getByRole("button", { name: "Entry" }).click();
    await expect
      .element(views.getByRole("button", { name: "Entry" }))
      .toHaveAttribute("aria-pressed", "true");

    await expect
      .element(table.getByRole("cell", { name: "/docs/getting-started" }))
      .not.toBeInTheDocument();
    await expect.element(pages.getByRole("button", { name: "Show all pages" })).toBeVisible();
  });

  test("says why it is empty instead of drawing an empty table", async () => {
    installFakeApi();
    renderApp(REFERENCE);

    const events = page.getByRole("region", { name: "Custom events" });
    await expect.element(events.getByText(/No custom events in this period/)).toBeVisible();
    await expect.element(events.getByRole("table")).not.toBeInTheDocument();
  });

  test("on a phone, stacks each row with its figures labelled, or scrolls inside itself", async () => {
    await page.viewport(390, 844);
    installFakeApi();
    renderApp(REFERENCE);

    const locations = page.getByRole("region", { name: "Locations" });
    const row = locations.getByRole("row").filter({ hasText: "Germany" });
    await expect.element(row).toBeVisible();
    expect(getComputedStyle(row.element()).display).toBe("grid");
    expect(row.element().textContent).toBe("GermanyVisitors155Visits160");

    const pages = page.getByRole("region", { name: "Pages" });
    await expect.element(pages.getByRole("table")).toBeVisible();
    const scroller = pages.element().querySelector<HTMLElement>("[data-slot=table-container]");
    expect(scroller?.scrollWidth).toBeGreaterThan(scroller?.clientWidth ?? 0);
    // The page itself never scrolls sideways.
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
  });
});

describe("the workbench", () => {
  test("shows a summary until an item is chosen, and keeps the choice in the address", async () => {
    installFakeApi();
    const router = renderApp(REFERENCE);

    const summary = page.getByRole("region", { name: "Example errors, summary" });
    await expect.element(summary.getByText("3 unresolved errors")).toBeVisible();
    expect(search(router).get("ds-item")).toBeNull();

    await page.getByRole("button", { name: /^ReferenceError/ }).click();

    await expect.poll(() => search(router).get("ds-item")).toBe("reference-error");
    const detail = page.getByRole("region", { name: "Example errors, selected" });
    await expect.element(detail.getByRole("heading", { name: "ReferenceError" })).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: /^ReferenceError/ }))
      .toHaveAttribute("aria-current", "true");
  });

  test("moves with j and k, acts with its key, and clears with Escape", async () => {
    installFakeApi();
    const router = renderApp(REFERENCE);
    await expect.element(page.getByText("3 unresolved errors")).toBeVisible();

    await userEvent.keyboard("j");
    await expect.poll(() => search(router).get("ds-item")).toBe("type-error");
    await userEvent.keyboard("j");
    await expect.poll(() => search(router).get("ds-item")).toBe("reference-error");
    await userEvent.keyboard("j");
    await userEvent.keyboard("j");
    // The last item stays chosen at the end of the list.
    await expect.poll(() => search(router).get("ds-item")).toBe("network-error");
    await userEvent.keyboard("k");
    await expect.poll(() => search(router).get("ds-item")).toBe("reference-error");

    const detail = page.getByRole("region", { name: "Example errors, selected" });
    await expect.element(detail.getByText("Unresolved")).toBeVisible();
    await userEvent.keyboard("e");
    await expect.element(detail.getByText("Resolved", { exact: true })).toBeVisible();

    await userEvent.keyboard("{Escape}");
    await expect.poll(() => search(router).get("ds-item")).toBeNull();
    await expect.element(page.getByText("3 unresolved errors")).toBeVisible();
  });

  test("answers the keys again once a choice is made in a Select", async () => {
    installFakeApi();
    const router = renderApp(REFERENCE);

    await page.getByRole("combobox", { name: "Period" }).first().click();
    await page.getByRole("option", { name: "Last 30 days" }).click();
    await expect
      .element(page.getByRole("option", { name: "Last 30 days" }))
      .not.toBeInTheDocument();
    await userEvent.keyboard("j");

    await expect.poll(() => search(router).get("ds-item")).toBe("type-error");
  });

  test("leaves the keys alone while a field has focus", async () => {
    installFakeApi();
    const router = renderApp(REFERENCE);

    const name = page.getByRole("textbox", { name: "Name" });
    await name.click();
    await userEvent.keyboard("j");

    expect(search(router).get("ds-item")).toBeNull();
    await expect.element(name).toHaveValue("Main sitej");
  });

  test("under 64rem, shows the list alone and opens an item's own page", async () => {
    await page.viewport(800, 900);
    installFakeApi();
    const router = renderApp(REFERENCE);

    await expect.element(page.getByRole("button", { name: /^TypeError/ })).toBeVisible();
    await expect
      .element(page.getByRole("region", { name: "Example errors, summary" }))
      .not.toBeInTheDocument();

    await page.getByRole("button", { name: /^TypeError/ }).click();

    await expect
      .element(
        page.getByRole("status").filter({ hasText: "choosing type-error opens its own page" }),
      )
      .toBeVisible();
    expect(search(router).get("ds-item")).toBeNull();
  });
});

const saveBar = () => page.getByRole("form", { name: "Settings" });
const exampleTabs = () => page.getByRole("tablist", { name: "Example settings" });

/** Whether closing the tab now would ask first. */
function unloadAsks() {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

describe("settings tabs and the save bar", () => {
  test("Save waits for a change, and undoing the change disables it again", async () => {
    installFakeApi();
    renderApp(REFERENCE);

    const form = saveBar();
    const save = form.getByRole("button", { name: "Save changes" });
    await expect.element(save).toHaveAttribute("aria-disabled", "true");
    await expect.element(form.getByText("No unsaved changes")).toBeVisible();
    await expect.element(form.getByRole("button", { name: "Discard" })).not.toBeInTheDocument();

    await form.getByRole("textbox", { name: "Name" }).fill("Main site 2");

    await expect.element(save).not.toHaveAttribute("aria-disabled", "true");
    await expect.element(form.getByText("Unsaved changes", { exact: true })).toBeVisible();
    await expect
      .element(exampleTabs().getByRole("tab", { name: /^Settings\s*, unsaved changes$/ }))
      .toBeVisible();

    await form.getByRole("textbox", { name: "Name" }).fill("Main site");

    await expect.element(save).toHaveAttribute("aria-disabled", "true");
    await expect.element(form.getByText("No unsaved changes")).toBeVisible();
  });

  test("Discard puts the saved values back, and Save makes the edits the saved ones", async () => {
    installFakeApi();
    renderApp(REFERENCE);

    const form = saveBar();
    const data = form.getByRole("checkbox", { name: "Ignore visits from data centers" });
    await data.click();
    await expect.element(data).not.toBeChecked();

    await form.getByRole("button", { name: "Discard" }).click();

    await expect.element(data).toBeChecked();
    await expect
      .element(form.getByRole("button", { name: "Save changes" }))
      .toHaveAttribute("aria-disabled", "true");

    await form.getByRole("textbox", { name: "Name" }).fill("Docs");
    await form.getByRole("button", { name: "Save changes" }).click();

    await expect.element(form.getByText("No unsaved changes")).toBeVisible();
    await expect.element(form.getByRole("textbox", { name: "Name" })).toHaveValue("Docs");
    await expect
      .element(form.getByRole("button", { name: "Save changes" }))
      .toHaveAttribute("aria-disabled", "true");
  });

  test("a switch and a choice join their section's form", async () => {
    installFakeApi();
    const router = renderApp(REFERENCE);

    await exampleTabs().getByRole("tab", { name: "Session replay" }).click();

    await expect.poll(() => search(router).get("ds-tab")).toBe("replay");
    const form = page.getByRole("form", { name: "Session replay" });
    await form.getByRole("switch", { name: "Only accept user IDs signed by your server" }).click();
    await expect
      .element(form.getByRole("button", { name: "Save changes" }))
      .not.toHaveAttribute("aria-disabled", "true");
    await form.getByRole("switch", { name: "Only accept user IDs signed by your server" }).click();
    await expect
      .element(form.getByRole("button", { name: "Save changes" }))
      .toHaveAttribute("aria-disabled", "true");

    await form.getByRole("radio", { name: "Around errors" }).click();
    await expect
      .element(form.getByRole("button", { name: "Save changes" }))
      .not.toHaveAttribute("aria-disabled", "true");
  });

  test("the chosen tab comes from the address, and edits survive a visit to another tab", async () => {
    installFakeApi();
    const router = renderApp(`${REFERENCE}?ds-tab=replay`);

    await expect
      .element(exampleTabs().getByRole("tab", { name: "Session replay" }))
      .toHaveAttribute("aria-selected", "true");

    await exampleTabs()
      .getByRole("tab", { name: /^Settings/ })
      .click();
    await expect.poll(() => search(router).get("ds-tab")).toBeNull();
    await saveBar().getByRole("textbox", { name: "Name" }).fill("Blog");
    await exampleTabs().getByRole("tab", { name: "Session replay" }).click();
    await exampleTabs()
      .getByRole("tab", { name: /^Settings/ })
      .click();

    await expect.element(saveBar().getByRole("textbox", { name: "Name" })).toHaveValue("Blog");
  });

  test("leaving with unsaved changes asks first, in the app and when the tab closes", async () => {
    installFakeApi();
    const router = renderApp(REFERENCE);

    await expect.element(saveBar()).toBeVisible();
    expect(unloadAsks()).toBe(false);

    await saveBar().getByRole("textbox", { name: "Name" }).fill("Blog");
    expect(unloadAsks()).toBe(true);

    await page.getByRole("link", { name: "Projects" }).click();
    const dialog = page.getByRole("dialog", { name: "Leave without saving?" });
    await expect.element(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Stay on this page" }).click();
    await expect.element(dialog).not.toBeInTheDocument();
    expect(currentPath(router)).toMatch(/^\/design-system/);
    await expect.element(saveBar().getByRole("textbox", { name: "Name" })).toHaveValue("Blog");

    await page.getByRole("link", { name: "Projects" }).click();
    await page.getByRole("button", { name: "Leave and discard" }).click();
    await expect.poll(() => currentPath(router)).toBe("/projects");
  });
});
