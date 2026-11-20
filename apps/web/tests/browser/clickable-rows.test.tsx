import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser/context";

import {
  ALERT_RULE_IDS,
  ERROR_FINGERPRINTS,
  fakeChecks,
  installFakeApi,
  PROJECT,
} from "./fake-api.ts";
import { trackMounted } from "./mounted.ts";
import { renderApp } from "./render.tsx";

/*
 * Rows that are one item opening one thing (docs/design-system.md,
 * "Clickable rows"): a click anywhere on the row does what a click on its
 * name does; the row's own controls act alone; a Cmd or middle click opens
 * the name's link in a new tab and leaves the list as it is; the keyboard
 * still goes through the name.
 */

const P = `/projects/${PROJECT.id}`;
const [SHOP, API] = fakeChecks();
const { typeError, referenceError } = ERROR_FINGERPRINTS;

afterEach(async () => {
  await page.viewport(1280, 900);
});

/** The row of a table that holds `text`, by its caption. */
function rowOf(caption: string, text: string): HTMLTableRowElement {
  const table = [...document.querySelectorAll("table")].find(
    (item) => item.caption?.textContent === caption,
  );
  const row = [...(table?.tBodies[0]?.rows ?? [])].find((item) => item.textContent?.includes(text));
  if (row === undefined) throw new Error(`No row with ${text} in ${caption}`);
  return row;
}

/** A cell of the row that is not its name, as a locator to click. */
const cell = (row: HTMLTableRowElement, index: number) => {
  const target = row.cells[index];
  if (target === undefined) throw new Error(`No cell ${index}`);
  return page.elementLocator(target);
};

/**
 * No colour transitions, so a hover's colour is read once it has settled,
 * not halfway through its fade.
 */
function withoutTransitions() {
  const style = document.createElement("style");
  style.textContent = "*, *::before, *::after { transition: none !important; }";
  document.head.append(style);
  trackMounted(() => style.remove());
}

/** Time for anything a click set off to land, before checking that it did not. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

const search = (router: ReturnType<typeof renderApp>) =>
  router.state.location.search as Record<string, unknown>;

describe("clickable rows", () => {
  test("Uptime: a click on a cell selects the check, as its name does, with the pointer and a hover wash", async () => {
    installFakeApi();
    withoutTransitions();
    const router = renderApp(`${P}/uptime`);
    await expect.element(page.getByRole("table", { name: "Uptime checks" })).toBeVisible();
    const row = rowOf("Uptime checks", "API health");
    expect(getComputedStyle(row).cursor).toBe("pointer");
    await userEvent.hover(row.cells[1] ?? row);
    expect(getComputedStyle(row).backgroundColor).not.toBe("rgba(0, 0, 0, 0)");

    // The state cell, then the 24 hours cell: neither holds a control.
    await cell(row, 1).click();
    await expect.poll(() => search(router).check).toBe(API?.id);
    expect(router.state.location.pathname).toBe(`${P}/uptime`);
    await expect.element(page.getByRole("region", { name: "Uptime, selected" })).toBeVisible();
    expect(rowOf("Uptime checks", "API health").getAttribute("data-state")).toBe("selected");
    // Focus is on the row's name, as a click on the name leaves it, so Tab carries on from there.
    expect(document.activeElement).toBe(
      rowOf("Uptime checks", "API health").querySelector("[data-row-link]"),
    );
    await userEvent.tab();
    expect(rowOf("Uptime checks", "API health").contains(document.activeElement)).toBe(true);

    await cell(rowOf("Uptime checks", "Shop home"), 2).click();
    await expect.poll(() => search(router).check).toBe(SHOP?.id);
  });

  test("Uptime: pause on a row only pauses, and Cmd or a middle click opens the check apart", async () => {
    const api = installFakeApi();
    const router = renderApp(`${P}/uptime`);
    await expect.element(page.getByRole("table", { name: "Uptime checks" })).toBeVisible();
    const open = vi.spyOn(window, "open").mockImplementation(() => null);

    await page.getByRole("button", { name: "Pause Shop home" }).click();
    await expect.element(page.getByRole("button", { name: "Resume Shop home" })).toBeVisible();
    expect(api.bodies.at(-1)).toMatchObject({ body: { paused: true } });
    await settle();
    expect(search(router).check).toBeUndefined();

    // Cmd (Ctrl on Linux) on a cell: the check's own page in a new tab, the list unchanged.
    await cell(rowOf("Uptime checks", "API health"), 1).click({ modifiers: ["ControlOrMeta"] });
    expect(open).toHaveBeenCalledTimes(1);
    expect(open.mock.calls[0]?.[0]).toBe(`${location.origin}${P}/uptime/${API?.id}`);
    expect(open.mock.calls[0]?.[1]).toBe("_blank");
    await settle();
    expect(search(router).check).toBeUndefined();

    await cell(rowOf("Uptime checks", "Shop home"), 1).click({ button: "middle" });
    expect(open).toHaveBeenCalledTimes(2);
    expect(open.mock.calls[1]?.[0]).toBe(`${location.origin}${P}/uptime/${SHOP?.id}`);
    await settle();
    expect(search(router).check).toBeUndefined();

    // Shift extends a text selection; it neither selects nor opens anything.
    await cell(rowOf("Uptime checks", "Shop home"), 1).click({ modifiers: ["Shift"] });
    await settle();
    expect(open).toHaveBeenCalledTimes(2);
    expect(search(router).check).toBeUndefined();
    expect(router.state.location.pathname).toBe(`${P}/uptime`);
  });

  test("Uptime: a drag that selects a row's text does not select the row", async () => {
    installFakeApi();
    const router = renderApp(`${P}/uptime`);
    await expect.element(page.getByRole("table", { name: "Uptime checks" })).toBeVisible();
    const row = rowOf("Uptime checks", "API health");
    const address = row.cells[0]?.querySelector("span");
    if (address === null || address === undefined) throw new Error("No address");
    // What a drag over the address leaves: its text selected, then a click on the row.
    getSelection()?.selectAllChildren(address);
    address.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
    await settle();
    expect(search(router).check).toBeUndefined();

    // With nothing selected, the same click on another row selects that one.
    getSelection()?.removeAllRanges();
    const other = rowOf("Uptime checks", "Shop home").cells[0]?.querySelector("span");
    other?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
    await expect.poll(() => search(router).check).toBe(SHOP?.id);
  });

  test("Uptime: the keyboard still goes through the name, and the row takes no tab stop", async () => {
    installFakeApi();
    const router = renderApp(`${P}/uptime`);
    const name = page.getByRole("region", { name: "Uptime, list" }).getByRole("link", {
      name: "API health",
    });
    await expect.element(name).toBeVisible();
    const row = rowOf("Uptime checks", "API health");
    expect(row.hasAttribute("tabindex")).toBe(false);
    expect(row.hasAttribute("role")).toBe(false);

    name.element().focus();
    await userEvent.keyboard("{Enter}");
    await expect.poll(() => search(router).check).toBe(API?.id);
    await userEvent.keyboard("j");
    // j from the last row stays on it; k moves up, focus on the name.
    await userEvent.keyboard("k");
    await expect.poll(() => search(router).check).toBe(SHOP?.id);
    expect(document.activeElement?.textContent).toBe("Shop home");
  });

  test("Errors: a click on a cell selects the error, and under 64rem opens its page", async () => {
    installFakeApi();
    const router = renderApp(`${P}/errors`);
    const caption = "Errors, most recently seen first";
    await expect.element(page.getByRole("table", { name: caption })).toBeVisible();

    await cell(rowOf(caption, "ReferenceError"), 1).click();
    await expect.poll(() => search(router).error).toBe(referenceError);
    await expect
      .element(
        page
          .getByRole("region", { name: "Errors, selected" })
          .getByRole("heading", { name: "ReferenceError" }),
      )
      .toBeVisible();

    // Cmd leaves the selection as it is.
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    await cell(rowOf(caption, "TypeError"), 1).click({ modifiers: ["ControlOrMeta"] });
    expect(open).toHaveBeenCalledTimes(1);
    expect(String(open.mock.calls[0]?.[0])).toContain(`${P}/errors/${typeError}`);
    await settle();
    expect(search(router).error).toBe(referenceError);

    await page.viewport(800, 900);
    await cell(rowOf(caption, "TypeError"), 1).click();
    await expect.poll(() => router.state.location.pathname).toBe(`${P}/errors/${typeError}`);
  });

  test("Alerts: the on and off switch only turns the rule on or off", async () => {
    const api = installFakeApi();
    const router = renderApp(`${P}/alerts`);
    await page.getByRole("switch", { name: "Turn off API down" }).click();
    await expect.element(page.getByRole("switch", { name: "Turn on API down" })).toBeVisible();
    expect(api.bodies.at(-1)).toMatchObject({ body: { enabled: false } });
    expect(search(router).rule).toBeUndefined();

    // The cell around the switch is the row's, and selects the rule.
    const switchCell = page
      .getByRole("switch", { name: "Turn on API down" })
      .element()
      .closest("td");
    if (switchCell === null) throw new Error("No cell");
    await page.elementLocator(switchCell).click({ position: { x: 2, y: 2 } });
    await expect.poll(() => search(router).rule).toBe(ALERT_RULE_IDS.apiDown);
  });

  test("the projects list: a click on a cell opens the project; its Settings link opens settings", async () => {
    installFakeApi();
    const router = renderApp("/projects");
    await expect.element(page.getByRole("table", { name: "Projects" })).toBeVisible();
    const row = rowOf("Projects", PROJECT.name);
    expect(getComputedStyle(row).cursor).toBe("pointer");

    await page.getByRole("link", { name: `Settings of ${PROJECT.name}` }).click();
    await expect.poll(() => router.state.location.pathname).toBe(`${P}/settings`);

    router.history.back();
    await expect.poll(() => router.state.location.pathname).toBe("/projects");
    // The list draws again after the address changes: wait for its row.
    await expect.element(page.getByRole("link", { name: PROJECT.name, exact: true })).toBeVisible();
    await cell(rowOf("Projects", PROJECT.name), 1).click();
    await expect.poll(() => router.state.location.pathname).toMatch(new RegExp(`^${P}`));
    expect(router.state.location.pathname).not.toBe(`${P}/settings`);
  });

  test("the hosts table: a click on a cell opens the host's page with the period kept", async () => {
    installFakeApi();
    const router = renderApp(`${P}/hosts?period=30d`);
    await expect.element(page.getByRole("link", { name: "web-1" })).toBeVisible();
    const row = page.getByRole("link", { name: "web-1" }).element().closest("tr");
    if (row === null) throw new Error("No row");

    await cell(row, 2).click();
    await expect.poll(() => router.state.location.pathname).toBe(`${P}/hosts/web-1`);
    expect(router.state.location.search).toEqual({ period: "30d" });
  });

  test("Services: a click on a route's status bar, which only shows a tooltip, opens the route", async () => {
    installFakeApi();
    const router = renderApp(`${P}/services`);
    const bar = page.getByRole("button", { name: /^Status classes of \/orders\/\{id\}/ });
    await expect.element(bar).toBeVisible();
    expect(getComputedStyle(bar.element()).cursor).toBe("pointer");

    await bar.click();
    await expect.poll(() => router.state.location.pathname).toBe(`${P}/services/web`);
    expect(router.state.location.search).toMatchObject({ route: "/orders/{id}" });
  });

  test("a table whose rows open nothing has neither the pointer nor a hover wash", async () => {
    installFakeApi();
    withoutTransitions();
    renderApp(`${P}/uptime`);
    await expect.element(page.getByRole("table", { name: "Uptime of each check" })).toBeVisible();
    const row = rowOf("Uptime of each check", "API health");
    expect(getComputedStyle(row).cursor).toBe("auto");
    await userEvent.hover(row.cells[1] ?? row);
    await settle();
    expect(getComputedStyle(row).backgroundColor).toBe("rgba(0, 0, 0, 0)");
    // A clickable row's wash shows at once with no transition, so the check above is not early.
    await userEvent.hover(rowOf("Uptime checks", "API health").cells[1] ?? row);
    expect(getComputedStyle(rowOf("Uptime checks", "API health")).backgroundColor).not.toBe(
      "rgba(0, 0, 0, 0)",
    );
  });
});
