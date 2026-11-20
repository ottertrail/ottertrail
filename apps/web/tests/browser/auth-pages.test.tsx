import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser/context";

import { GOOD_INVITE, GOOD_RESET, installFakeApi, requestUrl } from "./fake-api.ts";
import { unmountAll } from "./mounted.ts";
import { currentPath, renderApp } from "./render.tsx";

/*
 * The pages before signing in, on a phone (390 wide) unless a test says
 * otherwise: sign-in, owner setup, an invitation, and a reset link. Each
 * one's fields, its errors and its success, the token kept in the
 * fragment, and the layout fitting the screen. links.test.tsx has the
 * links' own rules (who invited, the cache, the setup timezone).
 */

const PASSWORD = "a long new password";

/** Opens a link with its token in the fragment, as a copied link arrives. */
function open(path: string, token: string) {
  const { pathname, search } = window.location;
  window.history.replaceState(null, "", `${pathname}${search}#token=${token}`);
  return renderApp(path);
}

/** Answers one API path with an error, as the API would, and everything else as the fake does. */
function refuse(path: string, status: number, message: string) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    return requestUrl(input).pathname === path && init?.method === "POST"
      ? new Response(JSON.stringify({ error: "refused", message }), {
          status,
          headers: { "Content-Type": "application/json" },
        })
      : realFetch(input, init);
  };
  return () => {
    globalThis.fetch = realFetch;
  };
}

/** The page fits the screen: nothing scrolls sideways, and the panel stays inside it. */
function expectFits(width: number) {
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
  const panel = document.querySelector("[data-slot=auth-panel]")?.getBoundingClientRect();
  expect(panel !== undefined && panel.left >= 0 && panel.right <= width).toBe(true);
  const rights = [...document.querySelectorAll("input")]
    .map((field) => field.getBoundingClientRect())
    .filter((box) => box.width > 0)
    .map((box) => box.right);
  expect(Math.max(0, ...rights)).toBeLessThanOrEqual(width);
}

let restore: (() => void) | undefined;

beforeEach(async () => {
  await page.viewport(390, 844);
});

afterEach(async () => {
  restore?.();
  restore = undefined;
  await page.viewport(1280, 900);
});

describe("sign-in", () => {
  test("asks for the email and password, says when they are wrong, and signs in", async () => {
    const api = installFakeApi({ signedIn: false });
    const router = renderApp("/sign-in");

    await expect.element(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();
    const email = page.getByRole("textbox", { name: "Email" });
    await expect.element(email).toHaveAttribute("autocomplete", "username");
    await expect
      .element(page.getByLabelText("Password"))
      .toHaveAttribute("autocomplete", "current-password");
    expectFits(390);

    api.signInRefusal = { status: 401, message: "Invalid email or password" };
    await email.fill("ada@example.com");
    await page.getByLabelText("Password").fill("not the password");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect
      .element(page.getByRole("alert").filter({ hasText: "Wrong email or password." }))
      .toBeVisible();
    expect(api.signedIn).toBe(false);
    expect(currentPath(router)).toBe("/sign-in");

    api.signInRefusal = null;
    await page.getByLabelText("Password").fill("correct horse battery");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect.poll(() => router.state.location.pathname).not.toBe("/sign-in");
    expect(api.signedIn).toBe(true);
  });

  test("too many attempts say to wait", async () => {
    installFakeApi({
      signedIn: false,
      signInRefusal: { status: 429, message: "Too many requests" },
    });
    renderApp("/sign-in");
    await page.getByRole("textbox", { name: "Email" }).fill("ada@example.com");
    await page.getByLabelText("Password").fill("not the password");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect
      .element(
        page
          .getByRole("alert")
          .filter({ hasText: "Too many attempts. Wait a minute. Then try again." }),
      )
      .toBeVisible();
  });
});

describe("owner setup", () => {
  test("has every field, the browser's timezone and the email line, and shows the API's refusal", async () => {
    const api = installFakeApi({ signedIn: false });
    open("/setup", "setup-token");

    await expect
      .element(page.getByRole("heading", { level: 1, name: "Create the owner account" }))
      .toBeVisible();
    for (const name of ["Name", "Email", "Instance name"]) {
      await expect.element(page.getByRole("textbox", { name, exact: true })).toBeVisible();
    }
    await expect.element(page.getByLabelText("Password", { exact: true })).toBeVisible();
    await expect.element(page.getByLabelText("Confirm password")).toBeVisible();
    await expect
      .element(page.getByRole("combobox", { name: "Timezone" }))
      .toHaveValue(Intl.DateTimeFormat().resolvedOptions().timeZone);
    await expect
      .element(page.getByLabelText("Email status"))
      .toMatchTextContent(/Email isn't set up on this server/);
    expectFits(390);

    restore = refuse("/api/setup", 400, "This setup link no longer works. Run the setup again.");
    await page.getByRole("textbox", { name: "Name", exact: true }).fill("Ada");
    await page.getByRole("textbox", { name: "Email" }).fill("ada@example.com");
    await page.getByRole("textbox", { name: "Instance name" }).fill("Ada's company");
    await page.getByLabelText("Password", { exact: true }).fill(PASSWORD);
    await page.getByLabelText("Confirm password").fill(PASSWORD);
    await page.getByRole("button", { name: "Create account" }).click();
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("This setup link no longer works. Run the setup again.");
    expect(api.signedIn).toBe(false);
  });

  test("creates the account and signs in", async () => {
    const api = installFakeApi({ signedIn: false });
    const router = open("/setup", "setup-token");
    await page.getByRole("textbox", { name: "Name", exact: true }).fill("Ada");
    await page.getByRole("textbox", { name: "Email" }).fill("ada@example.com");
    await page.getByRole("textbox", { name: "Instance name" }).fill("Ada's company");
    await page.getByLabelText("Password", { exact: true }).fill(PASSWORD);
    await page.getByLabelText("Confirm password").fill(PASSWORD);
    await page.getByRole("button", { name: "Create account" }).click();
    await expect.poll(() => router.state.location.pathname).not.toBe("/setup");
    expect(api.signedIn).toBe(true);
  });

  test("without a link, says how to get one and links to sign-in", async () => {
    installFakeApi({ signedIn: false });
    renderApp("/setup");
    await expect.element(page.getByText("No setup link")).toBeVisible();
    await expect
      .element(page.getByRole("link", { name: "sign in" }))
      .toHaveAttribute("href", "/sign-in");
    await expect.element(page.getByRole("textbox", { name: "Email" })).not.toBeInTheDocument();
    expectFits(390);
  });
});

describe("an invitation", () => {
  test("Accept reveals the fields, the email fixed; the password is checked twice and saved with the account", async () => {
    const api = installFakeApi({ signedIn: false });
    const router = open("/invite", GOOD_INVITE);

    await expect
      .element(page.getByRole("heading", { level: 1, name: "Join Acme Inc" }))
      .toBeVisible();
    await expect.element(page.getByRole("textbox", { name: "Name" })).not.toBeInTheDocument();
    // Who invited whom, and to what: never the role or the access.
    expect(document.body.textContent).not.toMatch(
      /admin|member|viewer|engineering|marketing|web analytics|Main site|project/i,
    );
    expectFits(390);

    await page.getByRole("button", { name: "Accept" }).click();
    const email = page.getByRole("textbox", { name: "Email" });
    await expect.element(email).toHaveValue("zoe@example.com");
    await expect.element(email).toBeDisabled();
    expectFits(390);

    await page.getByRole("textbox", { name: "Name" }).fill("Zoe");
    await page.getByLabelText("Password", { exact: true }).fill(PASSWORD);
    await page.getByLabelText("Confirm password").fill("something else");
    await page.getByRole("button", { name: "Create account" }).click();
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("The passwords do not match. Enter the same password in both fields.");
    expect(api.bodies.some((item) => item.path === "/api/invite/accept")).toBe(false);

    restore = refuse("/api/invite/accept", 400, "Use at least 12 characters.");
    await page.getByLabelText("Confirm password").fill(PASSWORD);
    await page.getByRole("button", { name: "Create account" }).click();
    await expect.element(page.getByRole("alert")).toHaveTextContent("Use at least 12 characters.");
    expect(api.signedIn).toBe(false);

    restore();
    restore = undefined;
    await page.getByRole("button", { name: "Create account" }).click();
    await expect.poll(() => router.state.location.pathname).not.toBe("/invite");
    expect(api.signedIn).toBe(true);
  });

  test("a link that no longer works says only that", async () => {
    installFakeApi({ signedIn: false });
    open("/invite", "revoked");
    await expect
      .element(page.getByText("This invitation link no longer works. Ask for a new one."))
      .toBeVisible();
    expectFits(390);
  });

  test("while it loads, the panel holds its shape and says so", async () => {
    installFakeApi({ signedIn: false });
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) =>
      requestUrl(input).pathname === "/api/invite/preview"
        ? new Promise<Response>(() => {})
        : realFetch(input, init);
    restore = () => {
      globalThis.fetch = realFetch;
    };
    open("/invite", GOOD_INVITE);
    await expect.element(page.getByText("Loading the invitation…")).toBeInTheDocument();
    expect(document.querySelector("[aria-busy=true] [data-slot=skeleton]")).not.toBeNull();
  });
});

describe("a reset link", () => {
  test("asks for the new password twice, shows the API's refusal, then signs in", async () => {
    const api = installFakeApi({ signedIn: false });
    const router = open("/reset-password", GOOD_RESET);
    await expect.element(page.getByText(/For mia@example\.com/)).toBeVisible();
    await expect
      .element(page.getByLabelText("New password"))
      .toHaveAttribute("autocomplete", "new-password");
    expectFits(390);

    await page.getByLabelText("New password").fill(PASSWORD);
    await page.getByLabelText("Confirm password").fill("something else");
    await page.getByRole("button", { name: "Set password" }).click();
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("The passwords do not match. Enter the same password in both fields.");

    restore = refuse(
      "/api/reset-password",
      404,
      "This reset link no longer works. Ask for a new one.",
    );
    await page.getByLabelText("Confirm password").fill(PASSWORD);
    await page.getByRole("button", { name: "Set password" }).click();
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("This reset link no longer works. Ask for a new one.");
    expect(api.signedIn).toBe(false);

    restore();
    restore = undefined;
    await page.getByRole("button", { name: "Set password" }).click();
    await expect.poll(() => router.state.location.pathname).not.toBe("/reset-password");
    expect(api.signedIn).toBe(true);
  });
});

describe("the link's token", () => {
  test("stays in the fragment: never in the address's query, a request's address, or the console", async () => {
    const logged: unknown[][] = [];
    // console.error is setup.ts's spy already (any error fails the test): its calls are read below.
    for (const method of ["log", "info", "warn", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logged.push(args);
      });
    }
    for (const [path, token, loaded] of [
      ["/invite", GOOD_INVITE, /Test Owner invited zoe@example\.com/],
      ["/reset-password", GOOD_RESET, /For mia@example\.com/],
      ["/setup", "setup-token", /The owner manages this instance/],
    ] as const) {
      unmountAll();
      const api = installFakeApi({ signedIn: false });
      const router = open(path, token);
      await expect.element(page.getByText(loaded)).toBeVisible();
      expect(window.location.hash).toBe("");
      expect(window.location.search).not.toContain(token);
      expect(currentPath(router)).not.toContain(token);
      expect(api.requests.filter((request) => request.includes(token))).toEqual([]);
    }
    const errors = vi.mocked(console.error).mock.calls;
    expect(JSON.stringify([...logged, ...errors])).not.toMatch(
      /good-invite|good-reset|setup-token/,
    );
  });
});

describe("the pages fit a wide screen", () => {
  test("at 1440 each page is one centred panel", async () => {
    await page.viewport(1440, 900);
    for (const [path, token, heading] of [
      ["/sign-in", null, "Sign in"],
      ["/setup", "setup-token", "Create the owner account"],
      ["/invite", GOOD_INVITE, "Join Acme Inc"],
      ["/reset-password", GOOD_RESET, "Set a new password"],
    ] as const) {
      unmountAll();
      installFakeApi({ signedIn: false });
      if (token === null) renderApp(path);
      else open(path, token);
      await expect.element(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
      expectFits(1440);
      const panel = document.querySelector("[data-slot=auth-panel]")?.getBoundingClientRect();
      // Centred, and no wider than a form needs.
      expect(panel !== undefined && Math.abs(panel.left + panel.right - 1440) <= 2).toBe(true);
      expect(panel !== undefined && panel.width <= 420).toBe(true);
    }
  });
});
