import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser/context";

import { installFakeApi } from "./fake-api.ts";
import { currentPath, renderApp } from "./render.tsx";

/*
 * Account email, which works only when the instance has SMTP set up
 * (docs/access.md, "Account email"): Forgot password on the sign-in page
 * and its request page, the invitation and reset-link dialogs emailing
 * their links, and the test email on the Notification channels tab. Each
 * also without SMTP, where the page says why and what to do instead.
 */

const NO_EMAIL_LINE =
  "Forgot your password? Email isn't set up on this instance, so ask the person who runs it for a reset link.";
const REQUESTED =
  "If an account uses that email, we'll send a reset link. Check your inbox and spam folder.";
const LIMITED = "Too many reset requests. Wait a little, then try again.";
const dialog = (name: string) => page.getByRole("dialog", { name });

afterEach(async () => {
  await page.viewport(1280, 900);
});

describe("the sign-in page", () => {
  test("with email set up, links to Forgot password beside the Password label", async () => {
    const api = installFakeApi({ signedIn: false, emailConfigured: true });
    const router = renderApp("/sign-in");
    const link = page.getByRole("link", { name: "Forgot password?" });
    await expect.element(link).toBeVisible();
    await expect.element(page.getByText(NO_EMAIL_LINE)).not.toBeInTheDocument();
    // On the Password label's row, at its right.
    const label = page.getByText("Password", { exact: true }).element().getBoundingClientRect();
    const box = link.element().getBoundingClientRect();
    expect(Math.abs(box.top - label.top)).toBeLessThan(8);
    expect(box.left).toBeGreaterThan(label.right);

    await link.click();
    await expect.poll(() => currentPath(router)).toBe("/forgot-password");
    expect(api.signedIn).toBe(false);
  });

  test("without email, no link: one quiet line under Sign in says whom to ask", async () => {
    installFakeApi({ signedIn: false, emailConfigured: false });
    renderApp("/sign-in");
    const line = page.getByText(NO_EMAIL_LINE);
    await expect.element(line).toBeVisible();
    await expect
      .element(page.getByRole("link", { name: "Forgot password?" }))
      .not.toBeInTheDocument();
    const button = page.getByRole("button", { name: "Sign in" }).element().getBoundingClientRect();
    expect(line.element().getBoundingClientRect().top).toBeGreaterThan(button.bottom);
    expect(line.element().className).toContain("text-ink-subtle");
  });
});

describe("the Forgot password page", () => {
  test("sends the address and answers the same for any of them", async () => {
    await page.viewport(390, 844);
    const api = installFakeApi({ signedIn: false, emailConfigured: true });
    renderApp("/forgot-password");
    await expect
      .element(page.getByRole("heading", { level: 1, name: "Reset your password" }))
      .toBeVisible();
    await expect
      .element(page.getByText("Enter your account email to request a reset link."))
      .toBeVisible();
    await page.getByRole("textbox", { name: "Email" }).fill("someone@example.com");
    await page.getByRole("button", { name: "Send reset link" }).click();
    await expect.element(page.getByRole("status").filter({ hasText: REQUESTED })).toBeVisible();
    expect(api.bodies).toContainEqual({
      method: "POST",
      path: "/api/reset-password/request",
      body: { email: "someone@example.com" },
    });
    await expect.element(page.getByRole("link", { name: "Back to sign in" })).toBeVisible();
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
  });

  test("says when the limit is reached, without a wait time", async () => {
    installFakeApi({ signedIn: false, emailConfigured: true, resetRequest: "limited" });
    renderApp("/forgot-password");
    await page.getByRole("textbox", { name: "Email" }).fill("someone@example.com");
    await page.getByRole("button", { name: "Send reset link" }).click();
    await expect.element(page.getByRole("alert").filter({ hasText: LIMITED })).toBeVisible();
    // The form stays, to try again later.
    await expect.element(page.getByRole("button", { name: "Send reset link" })).toBeVisible();
  });

  test("without email, says whom to ask instead of offering the form", async () => {
    installFakeApi({ signedIn: false, emailConfigured: false });
    renderApp("/forgot-password");
    await expect
      .element(page.getByText("Email isn't set up on this instance", { exact: false }))
      .toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Send reset link" }))
      .not.toBeInTheDocument();
  });
});

describe("the Members page with email set up", () => {
  test("emails an invitation, says so, and still shows the link to copy", async () => {
    installFakeApi({ emailConfigured: true });
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    renderApp("/settings/members");
    await page.getByRole("button", { name: "Invite" }).click();
    const form = dialog("Invite someone");
    await expect
      .element(
        form.getByText("Ottertrail emails an invitation link to the address you enter.", {
          exact: false,
        }),
      )
      .toBeVisible();
    await form.getByRole("textbox", { name: "Email" }).fill("leo@example.com");
    await form.getByRole("button", { name: "Send invitation" }).click();
    await expect
      .element(
        form
          .getByRole("status")
          .filter({ hasText: "Ottertrail is emailing the link to leo@example.com" }),
      )
      .toBeVisible();
    await form.getByRole("button", { name: "Copy the link" }).click();
    expect(writeText).toHaveBeenCalledWith("http://localhost:5173/invite#token=new-invite-token");
  });

  test('a reset link can be emailed with "Email it to them", or made to copy', async () => {
    const api = installFakeApi({ emailConfigured: true });
    renderApp("/settings/members");
    await page.getByRole("button", { name: "More actions for Mia Member" }).click();
    await page.getByRole("menuitem", { name: "Make reset link" }).click();
    const reset = dialog("A reset link for Mia Member");
    await expect.element(reset.getByRole("button", { name: "Make the link" })).toBeVisible();
    await reset.getByRole("button", { name: "Email it to them" }).click();
    await expect
      .element(
        reset
          .getByRole("status")
          .filter({ hasText: "Ottertrail is emailing the link to mia@example.com" }),
      )
      .toBeVisible();
    await expect
      .element(reset.getByText("http://localhost:5173/reset-password#token=reset-token"))
      .toBeVisible();
    expect(api.bodies).toContainEqual({
      method: "POST",
      path: "/api/members/user-3/reset-link",
      body: { email: true },
    });
  });

  test('"New link" on an invitation sends it again', async () => {
    const api = installFakeApi({ emailConfigured: true });
    renderApp("/settings/members?tab=invitations");
    await page.getByRole("button", { name: "More actions for zoe@example.com" }).click();
    await page.getByRole("menuitem", { name: "New link" }).click();
    const renew = dialog("A new link for zoe@example.com");
    await renew.getByRole("button", { name: "Send a new link" }).click();
    await expect
      .element(
        renew
          .getByRole("status")
          .filter({ hasText: "Ottertrail is emailing the link to zoe@example.com" }),
      )
      .toBeVisible();
    expect(api.requests).toContain("/api/invitations/invite-1/link");
  });
});

describe("the test email", () => {
  test("says the mail server accepted it", async () => {
    const api = installFakeApi();
    api.channels.emailConfigured = true;
    renderApp("/settings?tab=channels");
    await page.getByRole("button", { name: "Send a test email" }).click();
    await expect
      .element(
        page.getByRole("status").filter({
          hasText: "The mail server accepted a test email for owner@example.com. Check your inbox.",
        }),
      )
      .toBeVisible();
    await expect.element(page.getByText("Accepted", { exact: true })).toBeVisible();
  });

  test("shows the server's error and what to do", async () => {
    const api = installFakeApi();
    api.channels.emailConfigured = true;
    api.channels.testEmail = {
      error: "The SMTP server refused the user name and password (535).",
    };
    renderApp("/settings?tab=channels");
    await page.getByRole("button", { name: "Send a test email" }).click();
    await expect
      .element(
        page.getByRole("status").filter({
          hasText:
            "The test email could not be sent. Check the server's email settings, then try again. Error: The SMTP server refused the user name and password (535).",
        }),
      )
      .toBeVisible();
    await expect.element(page.getByText("Not sent", { exact: true })).toBeVisible();
  });

  test("without email, there is no button and the card says what to set", async () => {
    installFakeApi();
    renderApp("/settings?tab=channels");
    await expect
      .element(page.getByText("Email is not set up on this instance", { exact: true }))
      .toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Send a test email" }))
      .not.toBeInTheDocument();
  });
});

describe("the Account page's email change", () => {
  test("with email set up, says the old address gets a notice", async () => {
    installFakeApi({ emailConfigured: true });
    renderApp("/account");
    await expect
      .element(
        page.getByText(
          "Ottertrail sends a notice of the change to your old address. Check the new address: you'll sign in with it from now on.",
        ),
      )
      .toBeVisible();
    await expect
      .element(page.getByText("Ottertrail doesn't send a confirmation email", { exact: false }))
      .not.toBeInTheDocument();
  });

  test("without email, says no confirmation is sent", async () => {
    installFakeApi({ emailConfigured: false });
    renderApp("/account");
    await expect
      .element(page.getByText("Ottertrail doesn't send a confirmation email", { exact: false }))
      .toBeVisible();
  });
});
