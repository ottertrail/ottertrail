import { afterEach, describe, expect, test } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser/context";

import { FAKE_PASSWORD } from "./fake-account.ts";
import { installFakeApi, memberAccess, PROJECT } from "./fake-api.ts";
import { currentPath, renderApp } from "./render.tsx";

/*
 * The sidebar's user menu and API status, and the Account settings page
 * (docs/dashboard.md, "Account settings"): each tab's save rule and
 * errors, the sessions, and the phone layout.
 */

const ANALYTICS = `/projects/${PROJECT.id}/web-analytics`;
const sidebar = () => document.querySelector("[data-slot=sidebar]");
const userButton = () => page.getByRole("button", { name: /Account menu$/ });
const menu = () => page.getByRole("menu");
/** The open tooltip's text (Base UI's tooltip has no role), or null with none open. */
const tooltip = () =>
  document.querySelector("[data-slot=tooltip-content][data-open]")?.textContent ?? null;
const form = (name: string) => page.getByRole("form", { name });
const saveBar = (name: string) => form(name).getByRole("status").last();
/** Waits long enough for a hover's effect to show, before asserting it had none. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

afterEach(async () => {
  await page.viewport(1280, 900);
});

describe("the sidebar", () => {
  test("its foot names the user, and opens a menu with Account settings and Sign out", async () => {
    await page.viewport(1440, 900);
    installFakeApi();
    const router = renderApp(ANALYTICS);

    const button = userButton();
    await expect.element(button).toMatchTextContent("Test Owner");
    await expect.element(button).toMatchTextContent("owner@example.com");
    // Initials stand in for a photo.
    await expect.element(button).toMatchTextContent("TO");

    await button.click();
    await expect.element(menu()).toBeVisible();
    await expect.element(menu()).toMatchTextContent("Test Owner");
    await expect.element(menu()).toMatchTextContent("owner@example.com");
    // Beside the sidebar on a desktop.
    const trigger = button.element().getBoundingClientRect();
    await expect
      .poll(() => menu().element().getBoundingClientRect().left)
      .toBeGreaterThanOrEqual(trigger.right);
    expect(
      menu()
        .getByRole("menuitem")
        .elements()
        .map((item) => item.textContent),
    ).toEqual(["Account settings", "Sign out"]);

    await menu().getByRole("menuitem", { name: "Account settings" }).click();
    await expect.poll(() => currentPath(router)).toBe("/account");
    await expect
      .element(page.getByRole("heading", { level: 1 }))
      .toMatchTextContent("Account settings");
  });

  test("Sign out signs out and forgets what was cached", async () => {
    const api = installFakeApi();
    const router = renderApp("/projects");
    await expect.element(page.getByText("Acme Inc", { exact: true })).toBeVisible();

    await userButton().click();
    await menu().getByRole("menuitem", { name: "Sign out" }).click();
    await expect.poll(() => router.state.location.pathname).toBe("/sign-in");
    expect(api.signedIn).toBe(false);
  });

  test("collapsed to icons, the foot is the avatar with a tooltip, and the API a dot", async () => {
    await page.viewport(1440, 900);
    installFakeApi();
    renderApp(ANALYTICS);
    await expect.element(page.getByText("API online")).toBeVisible();

    await userEvent.keyboard("{Control>}b{/Control}");
    await expect.poll(() => sidebar()?.getAttribute("data-state")).toBe("collapsed");

    const button = userButton();
    expect(button.element().getBoundingClientRect().width).toBeLessThanOrEqual(32);
    await button.hover();
    await expect.poll(tooltip).toBe("Test Ownerowner@example.com");

    // The status keeps its name as a dot, inside the collapsed rail.
    const status = page.getByRole("status", { name: "API status" });
    await expect.element(status).toMatchTextContent("API online");
    const dot = document.querySelector("[data-slot=api-status-dot]");
    expect(dot?.getAttribute("data-state")).toBe("ok");
    const rail = sidebar()?.querySelector("[data-slot=sidebar-header]")?.getBoundingClientRect();
    const box = dot?.getBoundingClientRect();
    expect(box !== undefined && rail !== undefined && box.right <= rail.right).toBe(true);
    await userEvent.hover(dot as Element);
    await expect.poll(tooltip).toBe("API online");
  });

  test("the API status sits in the header, on the logo's line", async () => {
    await page.viewport(1440, 900);
    installFakeApi();
    renderApp("/projects");
    const status = page.getByRole("status", { name: "API status" });
    await expect.element(status).toMatchTextContent("API online");
    const header = document.querySelector("[data-slot=sidebar-header]");
    expect(header?.contains(status.element())).toBe(true);
    const name = page.getByText("Ottertrail", { exact: true }).element().getBoundingClientRect();
    const badge = status.element().getBoundingClientRect();
    expect(badge.left).toBeGreaterThan(name.right);
    expect(Math.abs(badge.top + badge.height / 2 - (name.top + name.height / 2))).toBeLessThan(4);
  });

  test("a name too long for the row shows whole in a tooltip; a short one has none", async () => {
    await page.viewport(1440, 900);
    const api = installFakeApi();
    renderApp("/projects");
    await userButton().hover();
    await settle();
    expect(tooltip()).toBeNull();
    await userButton().unhover();

    const long = "Maximiliana Wilhelmina Featherstonehaugh-Cholmondeley";
    api.account.name = long;
    // The page reads the session again when the window regains focus; the name goes through the Profile form here.
    await page.getByRole("button", { name: /Account menu$/ }).click();
    await menu().getByRole("menuitem", { name: "Account settings" }).click();
    await form("Name").getByRole("textbox", { name: "Name" }).fill(long);
    await form("Name").getByRole("button", { name: "Save name" }).click();
    await expect.element(userButton()).toMatchTextContent(long);

    await userButton().hover();
    await expect.poll(tooltip).toBe(`${long}owner@example.com`);
    // The menu wraps the name rather than cutting it off.
    await userButton().click();
    const label = menu().getByText(long).element();
    expect(label.scrollWidth).toBeLessThanOrEqual(label.clientWidth);
  });
});

describe("Account settings", () => {
  test("has Profile, Password and Sessions, for a member too", async () => {
    installFakeApi({ access: memberAccess({ web_analytics: "view" }) });
    const router = renderApp("/account");
    const tabs = page.getByRole("tablist", { name: "Account settings" });
    await expect.element(tabs).toBeVisible();
    expect(
      tabs
        .getByRole("tab")
        .elements()
        .map((tab) => tab.textContent),
    ).toEqual(["Profile", "Password", "Sessions"]);
    await page.getByRole("tab", { name: "Sessions" }).click();
    await expect.poll(() => currentPath(router)).toBe("/account?tab=sessions");
  });

  test("the name follows the save rule, and the sidebar shows the new one", async () => {
    const api = installFakeApi();
    renderApp("/account");
    const name = form("Name").getByRole("textbox", { name: "Name" });
    const save = form("Name").getByRole("button", { name: "Save name" });
    await expect.element(name).toHaveValue("Test Owner");
    await expect.element(saveBar("Name")).toHaveTextContent("No unsaved changes");
    await expect.element(save).toHaveAttribute("aria-disabled", "true");

    await name.fill("Test Owner ");
    // Spaces around it are no change.
    await expect.element(save).toHaveAttribute("aria-disabled", "true");
    await name.fill("Tess Owner");
    await expect.element(saveBar("Name")).toHaveTextContent("Unsaved changes");
    await expect
      .element(page.getByRole("tab", { name: /^Profile\s*, unsaved changes$/ }))
      .toBeVisible();
    await form("Name").getByRole("button", { name: "Discard" }).click();
    await expect.element(name).toHaveValue("Test Owner");

    await name.fill("Tess Owner");
    await save.click();
    await expect.element(saveBar("Name")).toHaveTextContent("No unsaved changes");
    expect(api.account.name).toBe("Tess Owner");
    await expect.element(userButton()).toMatchTextContent("Tess Owner");
  });

  test("the email changes with the password, and says what a wrong password or a taken address is", async () => {
    const api = installFakeApi();
    renderApp("/account");
    const email = form("Email").getByRole("textbox", { name: "Email" });
    const password = form("Email").getByLabelText("Current password");
    const save = form("Email").getByRole("button", { name: "Change email" });
    await expect.element(email).toHaveValue("owner@example.com");
    await expect
      .element(form("Email"))
      .toMatchTextContent(
        "Ottertrail doesn't send a confirmation email, because most self-hosted servers have no mail set up. Check the new address: you'll sign in with it from now on.",
      );
    // The password alone is nothing to save.
    await password.fill("anything");
    await expect.element(save).toHaveAttribute("aria-disabled", "true");

    await email.fill("new@example.com");
    await password.fill("not my password");
    await save.click();
    await expect
      .element(form("Email").getByText("The current password is incorrect. Enter it again."))
      .toBeVisible();
    await expect.element(password).toHaveAttribute("aria-invalid", "true");
    expect(api.account.email).toBe("owner@example.com");

    await email.fill("admin@example.com");
    await password.fill(FAKE_PASSWORD);
    await save.click();
    await expect
      .element(
        form("Email").getByText(
          "Another account already uses this email address. Enter a different one.",
        ),
      )
      .toBeVisible();
    await expect.element(email).toHaveAttribute("aria-invalid", "true");

    await email.fill("New@Example.com");
    await save.click();
    await expect
      .element(
        form("Email").getByText("Your email is now new@example.com. Sign in with it from now on."),
      )
      .toBeVisible();
    expect(api.account.email).toBe("new@example.com");
    await expect.element(password).toHaveValue("");
    await expect.element(email).toHaveValue("new@example.com");
    await expect.element(saveBar("Email")).toHaveTextContent("No unsaved changes");
    await expect.element(userButton()).toMatchTextContent("new@example.com");
  });

  test("the email change says when there were too many tries", async () => {
    const api = installFakeApi();
    api.account.triesLeft = 0;
    renderApp("/account");
    await form("Email").getByRole("textbox", { name: "Email" }).fill("new@example.com");
    await form("Email").getByLabelText("Current password").fill(FAKE_PASSWORD);
    await form("Email").getByRole("button", { name: "Change email" }).click();
    await expect
      .element(form("Email").getByRole("alert"))
      .toMatchTextContent("Too many attempts. Retry after 60 seconds.");
  });

  test("the password needs a match and the current one, then signs out the other devices", async () => {
    const api = installFakeApi();
    renderApp("/account?tab=password");
    const current = form("Password").getByLabelText("Current password");
    const next = form("Password").getByLabelText("New password", { exact: true });
    const confirm = form("Password").getByLabelText("Confirm new password");
    const save = form("Password").getByRole("button", { name: "Change password" });
    const others = form("Password").getByRole("checkbox", { name: "Sign out of my other devices" });
    await expect.element(others).toBeChecked();
    await expect.element(save).toHaveAttribute("aria-disabled", "true");

    await current.fill(FAKE_PASSWORD);
    await next.fill("a long new password");
    await confirm.fill("a different password");
    await expect
      .element(page.getByRole("tab", { name: /^Password\s*, unsaved changes$/ }))
      .toBeVisible();
    await save.click();
    await expect
      .element(
        form("Password").getByText(
          "The passwords do not match. Enter the same password in both fields.",
        ),
      )
      .toBeVisible();
    expect(api.bodies.filter((body) => body.path === "/api/account/password")).toEqual([]);

    await confirm.fill("a long new password");
    await current.fill("not my password");
    await save.click();
    await expect
      .element(form("Password").getByText("The current password is incorrect. Enter it again."))
      .toBeVisible();

    await current.fill(FAKE_PASSWORD);
    await save.click();
    await expect
      .element(
        form("Password").getByText(
          "Your password is changed, and your other devices are signed out.",
        ),
      )
      .toBeVisible();
    expect(api.account.password).toBe("a long new password");
    await expect.element(current).toHaveValue("");
    await expect.element(saveBar("Password")).toHaveTextContent("No unsaved changes");

    await page.getByRole("tab", { name: "Sessions" }).click();
    await expect.element(page.getByRole("list", { name: "Your sessions" })).toBeVisible();
    expect(
      page.getByRole("list", { name: "Your sessions" }).getByRole("listitem").elements(),
    ).toHaveLength(1);
  });

  test("unchecking the box keeps the other devices", async () => {
    const api = installFakeApi();
    renderApp("/account?tab=password");
    await form("Password").getByLabelText("Current password").fill(FAKE_PASSWORD);
    await form("Password")
      .getByLabelText("New password", { exact: true })
      .fill("a long new password");
    await form("Password").getByLabelText("Confirm new password").fill("a long new password");
    await form("Password").getByRole("checkbox", { name: "Sign out of my other devices" }).click();
    await form("Password").getByRole("button", { name: "Change password" }).click();
    await expect.element(form("Password").getByText("Your password is changed.")).toBeVisible();
    expect(api.account.sessions).toHaveLength(3);
    expect(api.bodies.at(-1)?.body).toMatchObject({ revokeOtherSessions: false });
  });

  test("lists the sessions, marks this device, and signs out one or all the others", async () => {
    const api = installFakeApi();
    renderApp("/account?tab=sessions");
    const list = page.getByRole("list", { name: "Your sessions" });
    await expect.element(list).toBeVisible();
    const rows = () =>
      list
        .getByRole("listitem")
        .elements()
        .map((row) => row.textContent);
    expect(rows()).toEqual([
      expect.stringMatching(/^Chrome 142 on macOSThis deviceSigned in .*Active now\.$/),
      expect.stringMatching(
        /^Firefox 145 on WindowsSigned in .*Last active 15 Nov 2026\.Sign out$/,
      ),
      expect.stringMatching(/^Safari 18 on iOSSigned in .*Last active 12 Nov 2026\.Sign out$/),
    ]);
    await expect
      .element(
        page.getByText(
          "Ottertrail doesn't record where a device signed in from, because it never stores IP addresses.",
        ),
      )
      .toBeVisible();
    // This device has no Sign out of its own.
    expect(list.getByRole("button", { name: /Chrome/ }).elements()).toEqual([]);

    await list.getByRole("button", { name: "Sign out Firefox 145 on Windows" }).click();
    const dialog = page.getByRole("dialog", { name: "Sign out Firefox 145 on Windows?" });
    await expect.element(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    expect(api.account.sessions).toHaveLength(3);

    await list.getByRole("button", { name: "Sign out Firefox 145 on Windows" }).click();
    await dialog.getByRole("button", { name: "Sign out" }).click();
    await expect.element(page.getByText("Firefox 145 on Windows is signed out.")).toBeVisible();
    await expect.poll(() => rows().length).toBe(2);
    await expect.element(page.getByRole("heading", { name: "Sessions" })).toHaveFocus();

    await page.getByRole("button", { name: "Sign out of all other devices" }).click();
    const all = page.getByRole("dialog", { name: "Sign out of all other devices?" });
    await expect.element(all).toMatchTextContent("1 other session ends at once.");
    await all.getByRole("button", { name: "Sign out of other devices" }).click();
    await expect.element(page.getByText("Your other devices are signed out.")).toBeVisible();
    await expect.poll(() => rows().length).toBe(1);
    await expect.element(page.getByText("No other device is signed in.")).toBeVisible();
    expect(api.account.sessions.map((session) => session.id)).toEqual(["session-1"]);
  });

  test("a failed list says so, with Retry", async () => {
    const api = installFakeApi();
    api.account.listFails = true;
    renderApp("/account?tab=sessions");
    await expect.element(page.getByText("Your sessions could not load")).toBeVisible();
    api.account.listFails = false;
    await page.getByRole("button", { name: "Retry" }).click();
    await expect.element(page.getByRole("list", { name: "Your sessions" })).toBeVisible();
  });

  test("leaving with an unsaved name asks first", async () => {
    installFakeApi();
    const router = renderApp("/account");
    await form("Name").getByRole("textbox", { name: "Name" }).fill("Someone else");
    await page
      .getByRole("navigation", { name: "Instance" })
      .getByRole("link", { name: "Projects" })
      .click();
    await expect.element(page.getByRole("dialog", { name: "Leave without saving?" })).toBeVisible();
    expect(currentPath(router)).toBe("/account");
  });
});

describe("at 390 wide", () => {
  test("the menu opens below the user in the sheet, and every tab fits the screen", async () => {
    await page.viewport(390, 844);
    installFakeApi();
    const router = renderApp(ANALYTICS);
    await page.getByRole("button", { name: "Open menu" }).click();
    const sheet = page.getByRole("dialog", { name: "Menu" });
    await expect
      .element(sheet.getByRole("status", { name: "API status" }))
      .toMatchTextContent("API online");
    await sheet.getByRole("button", { name: /Account menu$/ }).click();
    await expect.element(menu()).toBeVisible();
    await menu().getByRole("menuitem", { name: "Account settings" }).click();
    await expect.poll(() => currentPath(router)).toBe("/account");
    await expect.element(sheet).not.toBeInTheDocument();

    for (const tab of ["Profile", "Password", "Sessions"]) {
      await page.getByRole("tab", { name: tab }).click();
      await expect.element(page.getByRole("tabpanel")).toBeVisible();
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
      const content = document.querySelector<HTMLElement>("[data-slot=app-content]");
      expect(content?.scrollWidth).toBeLessThanOrEqual(content?.clientWidth ?? 0);
    }
    // A session's Sign out keeps its 32px height and its whole label.
    const button = page.getByRole("button", { name: "Sign out Firefox 145 on Windows" });
    await expect.element(button).toBeVisible();
    expect(button.element().scrollWidth).toBeLessThanOrEqual(button.element().clientWidth);
  });

  test("a device name cut off on a phone shows whole in a tooltip on focus", async () => {
    await page.viewport(320, 700);
    const api = installFakeApi();
    api.account.sessions[1] = {
      ...api.account.sessions[1],
      userAgent:
        "Mozilla/5.0 (Linux; Android 15; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 Chrome/130.0.0.0 Mobile Safari/537.36",
    };
    renderApp("/account?tab=sessions");
    const name = page.getByText("Samsung Internet 28 on Android");
    await expect.element(name).toBeVisible();
    const element = name.element();
    expect(element.scrollWidth).toBeGreaterThan(element.clientWidth);
    expect(element.getAttribute("tabindex")).toBe("0");
    // From the tab row, the keyboard reaches it: a name cut off takes a tab stop.
    await page.getByRole("tab", { name: "Sessions" }).click();
    for (let step = 0; step < 6 && document.activeElement !== element; step += 1) {
      await userEvent.tab();
    }
    expect(document.activeElement).toBe(element);
    await expect.poll(tooltip).toBe("Samsung Internet 28 on Android");
    // A name that fits takes no tab stop.
    expect(page.getByText("Safari 18 on iOS").element().getAttribute("tabindex")).toBeNull();
  });
});
