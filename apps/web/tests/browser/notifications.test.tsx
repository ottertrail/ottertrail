import { afterEach, describe, expect, test } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser/context";

import { installFakeApi, PROJECT } from "./fake-api.ts";
import { fakeNotifications, manyNotifications } from "./fake-notifications.ts";
import { currentPath, renderApp } from "./render.tsx";

/*
 * The notifications inbox (docs/dashboard.md, "Notifications"): the item in
 * the sidebar's foot, its popover (a sheet on a phone), and the Notifications page.
 */

const OVERVIEW = `/projects/${PROJECT.id}/overview`;

afterEach(async () => {
  await page.viewport(1280, 900);
});

const list = () => [...document.querySelectorAll("main li")];
const bell = () => page.getByRole("button", { name: /^Notifications/ });
/** The unread count at the item's end, as it shows ("" with none). */
const shownCount = () =>
  bell().element().querySelector("[data-slot=unread-count]")?.textContent ?? "";
const panel = () => page.getByRole("dialog", { name: "Notifications" });

describe("the sidebar's Notifications item", () => {
  test("says how many are unread, in its name and its badge, with 9+ past nine", async () => {
    const api = installFakeApi();
    renderApp(OVERVIEW);
    await expect
      .element(page.getByRole("button", { name: "Notifications, 3 unread" }))
      .toBeVisible();
    expect(shownCount()).toBe("3");
    await expect.element(bell()).toHaveTextContent("Notifications3");

    api.notifications.items = manyNotifications(12).map((item) => ({ ...item, read: false }));
    // The count is read again when the window gets focus.
    window.dispatchEvent(new Event("visibilitychange"));
    await expect
      .element(page.getByRole("button", { name: "Notifications, 12 unread" }))
      .toBeVisible();
    expect(shownCount()).toBe("9+");

    api.notifications.items = [];
    window.dispatchEvent(new Event("visibilitychange"));
    await expect
      .element(page.getByRole("button", { name: "Notifications", exact: true }))
      .toBeVisible();
    expect(shownCount()).toBe("");
  });

  test("opens the newest items, unread marked; opening one marks it read and goes to it", async () => {
    const api = installFakeApi();
    const router = renderApp(OVERVIEW);
    await bell().click();
    await expect.element(panel()).toBeVisible();
    const links = panel().getByRole("link");
    await expect.element(links.first()).toHaveTextContent("Checkout API is down");
    const items = [...panel().element().querySelectorAll("li")];
    expect(items.map((item) => item.dataset.read)).toEqual([
      "false",
      "false",
      "false",
      "true",
      "true",
      "true",
    ]);
    // The project and when, and "unread" for screen readers.
    expect(items[0]?.textContent).toMatch(/^Checkout API is downMain site, .+, unread$/);
    // An instance item names no project.
    expect(items[2]?.textContent).toMatch(/^The last backup failed[^,]+, unread$/);

    await panel().getByRole("link", { name: "Checkout API is down" }).click();
    await expect.poll(() => currentPath(router)).toBe(`/projects/${PROJECT.id}/uptime`);
    await expect.element(panel()).not.toBeInTheDocument();
    await expect.poll(() => api.notifications.items[0]?.read).toBe(true);
    await expect
      .element(page.getByRole("button", { name: "Notifications, 2 unread" }))
      .toBeVisible();
  });

  test("marks one read or unread, and all read", async () => {
    const api = installFakeApi();
    renderApp(OVERVIEW);
    await bell().click();
    await panel().getByRole("button", { name: "Mark as unread: Checkout API is up" }).click();
    await expect
      .element(page.getByRole("button", { name: "Notifications, 4 unread" }))
      .toBeVisible();
    expect(api.notifications.items.find((item) => item.id === "note-5")?.read).toBe(false);

    await panel().getByRole("button", { name: "Mark all read" }).click();
    await expect
      .element(page.getByRole("button", { name: "Notifications", exact: true }))
      .toBeVisible();
    expect(api.notifications.items.every((item) => item.read)).toBe(true);
    // Nothing left to mark.
    await expect
      .element(panel().getByRole("button", { name: "Mark all read" }))
      .not.toBeInTheDocument();
  });

  test("says when there is nothing, and links to the Notifications page", async () => {
    const api = installFakeApi();
    api.notifications.items = [];
    const router = renderApp(OVERVIEW);
    await bell().click();
    await expect.element(panel().getByText("No notifications")).toBeVisible();
    await panel().getByRole("link", { name: "View all" }).click();
    await expect.poll(() => currentPath(router)).toBe("/notifications");
  });

  test("sits just above the user in the sidebar's foot, and opens to the sidebar's right", async () => {
    await page.viewport(1440, 900);
    installFakeApi();
    renderApp(OVERVIEW);
    await expect.element(bell()).toBeVisible();
    const footer = document.querySelector("[data-slot=sidebar-footer]");
    expect(footer?.contains(bell().element())).toBe(true);
    const user = page.getByRole("button", { name: /Account menu$/ });
    // The account menu can draw after the bell (on CI's slower runner it did): wait before measuring both.
    await expect.element(user).toBeVisible();
    const item = bell().element().getBoundingClientRect();
    const below = user.element().getBoundingClientRect();
    expect(below.top - item.bottom).toBeGreaterThanOrEqual(0);
    expect(below.top - item.bottom).toBeLessThanOrEqual(8);

    await bell().click();
    await expect.element(panel()).toBeVisible();
    // Over the content, past the sidebar, once it has opened; its foot lines up with the item's.
    const sidebar = document.querySelector("[data-slot=sidebar-container]");
    const right = sidebar?.getBoundingClientRect().right ?? 0;
    await expect
      .poll(() => panel().element().getBoundingClientRect().left)
      .toBeGreaterThanOrEqual(right);
    await expect
      .poll(() => Math.abs(panel().element().getBoundingClientRect().bottom - item.bottom))
      .toBeLessThanOrEqual(2);
  });

  test("collapsed to icons, is the bell with a dot while any is unread, and a tooltip", async () => {
    await page.viewport(1440, 900);
    const api = installFakeApi();
    renderApp(OVERVIEW);
    await expect.element(bell()).toBeVisible();
    await userEvent.keyboard("{Control>}b{/Control}");
    await expect
      .poll(() => document.querySelector("[data-slot=sidebar]")?.getAttribute("data-state"))
      .toBe("collapsed");

    const dot = () => bell().element().querySelector("[data-slot=unread-dot]");
    expect(dot()?.getBoundingClientRect().width).toBe(8);
    expect(
      bell().element().querySelector("[data-slot=unread-count]")?.getBoundingClientRect().width,
    ).toBe(0);
    await bell().hover();
    await expect
      .poll(() => document.querySelector("[data-slot=tooltip-content][data-open]")?.textContent)
      .toBe("Notifications");

    api.notifications.items = [];
    window.dispatchEvent(new Event("visibilitychange"));
    await expect
      .element(page.getByRole("button", { name: "Notifications", exact: true }))
      .toBeVisible();
    expect(dot()).toBeNull();
  });

  test("on a phone, is in the menu's foot and opens a sheet that fits the screen", async () => {
    await page.viewport(390, 844);
    installFakeApi();
    renderApp(OVERVIEW);
    await page.getByRole("button", { name: "Open menu" }).click();
    await page.getByRole("button", { name: "Notifications, 3 unread" }).click();
    await expect.element(panel()).toBeVisible();
    await expect.element(panel().getByRole("link", { name: "Checkout API is down" })).toBeVisible();
    const box = panel().element().getBoundingClientRect();
    expect(box.width).toBeLessThanOrEqual(390);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
    await panel().getByRole("button", { name: "Close" }).click();
    await expect.element(panel()).not.toBeInTheDocument();
  });
});

describe("the Notifications page", () => {
  test("lists all or unread, in the address, and pages back", async () => {
    const api = installFakeApi();
    api.notifications = {
      failure: null,
      items: [...fakeNotifications().items, ...manyNotifications(40)],
    };
    const router = renderApp("/notifications");
    await expect
      .element(page.getByRole("heading", { name: "Notifications", level: 1 }))
      .toBeVisible();
    await expect.poll(() => list().length).toBe(30);
    await page.getByRole("button", { name: "Show more" }).click();
    await expect.poll(() => list().length).toBe(46);
    await expect.element(page.getByRole("button", { name: "Show more" })).not.toBeInTheDocument();

    await page.getByRole("button", { name: "Unread" }).click();
    await expect.poll(() => currentPath(router)).toBe("/notifications?filter=unread");
    await expect.poll(() => list().length).toBe(3);

    await page.getByRole("button", { name: "Mark all read" }).click();
    await expect.element(page.getByText("No unread notifications")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Mark all read" })).toBeDisabled();
  });

  test("says when the list could not load, with Retry", async () => {
    const api = installFakeApi();
    api.notifications.failure = new Response(
      JSON.stringify({ error: "unavailable", message: "The database did not answer." }),
      { status: 503, headers: { "Content-Type": "application/json" } },
    );
    renderApp("/notifications");
    await expect.element(page.getByText("Notifications could not load")).toBeVisible();
    api.notifications.failure = null;
    await page.getByRole("button", { name: "Retry" }).click();
    await expect.element(page.getByRole("link", { name: "Checkout API is down" })).toBeVisible();
  });

  test("fits a phone", async () => {
    await page.viewport(390, 844);
    installFakeApi();
    renderApp("/notifications");
    await expect.element(page.getByRole("link", { name: "Checkout API is down" })).toBeVisible();
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
  });
});
