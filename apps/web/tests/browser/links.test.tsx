import { describe, expect, test } from "vite-plus/test";
import { page } from "vite-plus/test/browser/context";

import { GOOD_INVITE, GOOD_RESET, installFakeApi } from "./fake-api.ts";
import { unmountAll } from "./mounted.ts";
import { renderApp } from "./render.tsx";

const PASSWORD = "a long new password";

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Opens a link with its token in the fragment, as a copied link arrives:
 * the page reads the fragment from the browser's address, the router's
 * path from its in-memory history.
 */
function open(path: string, token: string) {
  const { pathname, search } = window.location;
  window.history.replaceState(null, "", `${pathname}${search}#token=${token}`);
  return renderApp(path);
}

describe("accepting an invitation", () => {
  test("shows who invited, to what, and creates the account only once the password is set", async () => {
    const api = installFakeApi({ signedIn: false });
    const router = open("/invite", GOOD_INVITE);

    await expect.element(page.getByRole("heading", { name: "Join Acme Inc" })).toBeVisible();
    await expect.element(page.getByText(/Test Owner invited zoe@example\.com/)).toBeVisible();
    await expect.element(page.getByText(/on Main site/)).toBeVisible();
    await expect
      .element(page.getByRole("list", { name: "Areas" }))
      .toMatchTextContent(/Web analytics \(view\)Product analytics \(manage\)/);
    // The token left the address bar.
    expect(window.location.hash).toBe("");
    expect(api.bodies.some((item) => item.path === "/api/invite/accept")).toBe(false);

    await page.getByRole("button", { name: "Accept" }).click();
    await expect
      .element(page.getByRole("textbox", { name: "Email" }))
      .toHaveValue("zoe@example.com");
    await page.getByRole("textbox", { name: "Name" }).fill("Zoe");
    await page.getByLabelText("Password", { exact: true }).fill(PASSWORD);
    await page.getByLabelText("Confirm password").fill(`${PASSWORD}!`);
    await page.getByRole("button", { name: "Create account" }).click();
    await expect
      .element(page.getByText("The two passwords differ.", { exact: false }))
      .toBeVisible();
    expect(api.bodies.some((item) => item.path === "/api/invite/accept")).toBe(false);

    await page.getByLabelText("Confirm password").fill(PASSWORD);
    await page.getByRole("button", { name: "Create account" }).click();
    await expect.poll(() => router.state.location.pathname).not.toBe("/invite");
    expect(api.bodies).toContainEqual({
      method: "POST",
      path: "/api/invite/accept",
      body: { token: GOOD_INVITE, name: "Zoe", password: PASSWORD, confirmPassword: PASSWORD },
    });
    expect(api.signedIn).toBe(true);
  });

  test("a link that no longer works says only that", async () => {
    installFakeApi({ signedIn: false });
    open("/invite", "used-or-revoked");
    await expect
      .element(page.getByText("This invitation link no longer works. Ask for a new one."))
      .toBeVisible();
    await expect.element(page.getByRole("button", { name: "Accept" })).not.toBeInTheDocument();
  });

  test("a signed-in visitor is asked to sign out first", async () => {
    installFakeApi();
    open("/invite", GOOD_INVITE);
    await expect.element(page.getByText("Sign out first to accept this invitation.")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Accept" })).not.toBeInTheDocument();
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect.element(page.getByRole("button", { name: "Accept" })).toBeVisible();
  });
});

describe("a reset link", () => {
  test("a signed-in visitor is asked to sign out first", async () => {
    installFakeApi();
    open("/reset-password", GOOD_RESET);
    await expect.element(page.getByText("Sign out first to use this reset link.")).toBeVisible();
    await expect.element(page.getByLabelText("New password")).not.toBeInTheDocument();
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect.element(page.getByLabelText("New password")).toBeVisible();
  });

  test("keeps the token out of the page's cache, as the invitation page does", async () => {
    for (const [path, token, loaded] of [
      ["/invite", GOOD_INVITE, /Test Owner invited zoe@example\.com/],
      ["/reset-password", GOOD_RESET, /For mia@example\.com/],
    ] as const) {
      unmountAll();
      installFakeApi({ signedIn: false });
      const router = open(path, token);
      await expect.element(page.getByText(loaded)).toBeVisible();
      const keys = router.options.context.queryClient
        .getQueryCache()
        .getAll()
        .map((query) => JSON.stringify(query.queryKey));
      expect({ path, leaked: keys.filter((key) => key.includes(token)) }).toEqual({
        path,
        leaked: [],
      });
    }
  });

  test("sets the password, checked twice, then signs in", async () => {
    const api = installFakeApi({ signedIn: false });
    const router = open("/reset-password", GOOD_RESET);
    await expect.element(page.getByText(/For mia@example\.com/)).toBeVisible();
    await page.getByLabelText("New password").fill(PASSWORD);
    await page.getByLabelText("Confirm password").fill("something else");
    await page.getByRole("button", { name: "Set password" }).click();
    await expect
      .element(page.getByText("The two passwords differ.", { exact: false }))
      .toBeVisible();
    await page.getByLabelText("Confirm password").fill(PASSWORD);
    await page.getByRole("button", { name: "Set password" }).click();
    await expect.poll(() => router.state.location.pathname).not.toBe("/reset-password");
    expect(api.bodies).toContainEqual({
      method: "POST",
      path: "/api/reset-password",
      body: { token: GOOD_RESET, password: PASSWORD, confirmPassword: PASSWORD },
    });
  });

  test("a link that no longer works says so", async () => {
    installFakeApi({ signedIn: false });
    open("/reset-password", "expired");
    await expect
      .element(page.getByText("This reset link no longer works. Ask for a new one."))
      .toBeVisible();
  });
});

describe("the setup page", () => {
  test("asks for the password twice and the timezone, the browser's chosen, and says email is off", async () => {
    const api = installFakeApi({ signedIn: false });
    open("/setup", "setup-token");
    const timeZone = page.getByRole("combobox", { name: "Timezone" });
    await expect.element(timeZone).toHaveValue(Intl.DateTimeFormat().resolvedOptions().timeZone);
    await expect.element(page.getByText(/Email for alerts is not set up/)).toBeVisible();

    await page.getByRole("textbox", { name: "Name" }).fill("Ada");
    await page.getByRole("textbox", { name: "Email" }).fill("ada@example.com");
    await page.getByRole("textbox", { name: "Workspace name" }).fill("Ada's company");
    await page.getByLabelText("Password", { exact: true }).fill(PASSWORD);
    await page.getByLabelText("Confirm password").fill("not the same");
    await timeZone.fill("berlin");
    await page.getByRole("option", { name: /^Europe\/Berlin/ }).click();
    await expect.element(timeZone).toHaveValue("Europe/Berlin");
    await page.getByRole("button", { name: "Create account" }).click();
    await expect
      .element(page.getByText("The two passwords differ.", { exact: false }))
      .toBeVisible();
    expect(api.bodies.some((item) => item.path === "/api/setup")).toBe(false);

    await page.getByLabelText("Confirm password").fill(PASSWORD);
    await page.getByRole("button", { name: "Create account" }).click();
    await expect
      .poll(() => api.bodies.find((item) => item.path === "/api/setup")?.body)
      .toEqual({
        token: "setup-token",
        name: "Ada",
        email: "ada@example.com",
        password: PASSWORD,
        confirmPassword: PASSWORD,
        instanceName: "Ada's company",
        timeZone: "Europe/Berlin",
      });
  });

  test("marks the browser's timezone as chosen in the list", async () => {
    installFakeApi({ signedIn: false });
    open("/setup", "setup-token");
    const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const timeZone = page.getByRole("combobox", { name: "Timezone" });
    await expect.element(timeZone).toHaveValue(browserZone);

    await page.getByRole("button", { name: "Show timezones" }).click();
    // The whole list shows, not only the names that contain the chosen one.
    await expect.element(page.getByRole("option", { name: /^UTC/ })).toBeVisible();
    await expect
      .element(page.getByRole("option", { name: new RegExp(`^${escapeRegExp(browserZone)} ·`) }))
      .toHaveAttribute("aria-selected", "true");
  });

  test("says when alert email is set up", async () => {
    installFakeApi({ signedIn: false, emailConfigured: true });
    open("/setup", "setup-token");
    await expect
      .element(page.getByText("Email for alerts is set up on this server."))
      .toBeVisible();
  });
});

describe("the sign-in page", () => {
  test("before the owner exists, says how to run setup on a real install", async () => {
    installFakeApi({ signedIn: false });
    renderApp("/sign-in");
    await expect.element(page.getByText("No account exists yet")).toBeVisible();
    await expect
      .element(page.getByText("docker compose exec api node dist/setup.mjs"))
      .toBeVisible();
    await expect.element(page.getByText(/in the instance's folder/)).toBeVisible();
    await expect.element(page.getByText("vp run setup")).toBeVisible();
    await expect.element(page.getByText(/In development, run/)).toBeVisible();
  });
});
