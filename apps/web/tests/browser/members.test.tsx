import { describe, expect, test } from "vite-plus/test";
import { page } from "vite-plus/test/browser/context";

import { ADMIN_ACCESS, ADMIN_PASSWORD, installFakeApi, memberAccess, PROJECT } from "./fake-api.ts";
import { renderApp } from "./render.tsx";

const MEMBERS = "/settings/members";
const workspaceMenu = () => page.getByRole("navigation", { name: "Instance" });
const dialog = (name: string) => page.getByRole("dialog", { name });
const rowsOf = (caption: string) => {
  const table = [...document.querySelectorAll("table")].find(
    (element) => element.caption?.textContent === caption,
  );
  return [...(table?.tBodies[0]?.rows ?? [])].map((row) =>
    [...row.cells].slice(0, -1).map((cell) => cell.textContent ?? ""),
  );
};

describe("the Members page", () => {
  test("lists everyone and the pending invitations, and is in the workspace menu", async () => {
    installFakeApi();
    renderApp("/projects");
    await workspaceMenu().getByRole("link", { name: "Members" }).click();

    await expect.element(page.getByRole("table", { name: "Members" })).toBeVisible();
    expect(rowsOf("Members")).toEqual([
      ["Test OwnerYou", "owner@example.com", "Owner", "16 Nov 2026, 16:00"],
      ["Ada Admin", "ada@example.com", "Admin", "Never"],
      ["Mia Member", "mia@example.com", "Member: Viewer, all projects", "15 Nov 2026, 16:00"],
    ]);
    expect(rowsOf("Pending invitations")).toEqual([
      ["zoe@example.com", "Member: Marketing, 1 project", "Test Owner", "1 Jan 2099, 08:00"],
    ]);
  });

  test("members have no Members page or link", async () => {
    installFakeApi({ access: memberAccess({ web_analytics: "view" }) });
    renderApp(MEMBERS);
    await expect.element(page.getByText("You don't have access")).toBeVisible();
    await expect
      .element(workspaceMenu().getByRole("link", { name: "Members" }))
      .not.toBeInTheDocument();
  });

  test("invites a member with a preset, changed areas, and chosen projects, and shows the link once", async () => {
    const api = installFakeApi();
    renderApp(MEMBERS);
    await page.getByRole("button", { name: "Invite" }).click();
    const form = dialog("Invite someone");
    await form.getByRole("textbox", { name: "Email" }).fill("Leo@Example.com");
    await form.getByRole("radio", { name: /^Engineering/ }).click();
    await form.getByRole("radio", { name: "View Users" }).click();
    // Changing an area makes the preset Custom.
    await expect.element(form.getByRole("radio", { name: /^Custom/ })).toBeChecked();
    await form.getByRole("radio", { name: "Chosen projects" }).click();
    // A chosen list needs a project.
    await expect
      .element(form.getByRole("button", { name: "Create invitation link" }))
      .toBeDisabled();
    await form.getByRole("checkbox", { name: PROJECT.name }).click();
    await form.getByRole("button", { name: "Create invitation link" }).click();

    await expect
      .element(form.getByText("http://localhost:5173/invite#token=new-invite-token"))
      .toBeVisible();
    await expect.element(form.getByRole("button", { name: "Copy the link" })).toBeVisible();
    expect(api.bodies).toContainEqual({
      method: "POST",
      path: "/api/invitations",
      body: {
        email: "Leo@Example.com",
        role: "member",
        access: {
          projects: [PROJECT.id],
          areas: {
            web_analytics: "view",
            product_analytics: "view",
            errors: "manage",
            replays: "view",
            users: "view",
            monitoring: "view",
            uptime_alerts: "manage",
          },
        },
      },
    });
  });

  test("the owner may invite an admin", async () => {
    installFakeApi();
    renderApp(MEMBERS);
    await page.getByRole("button", { name: "Invite" }).click();
    await expect
      .element(dialog("Invite someone").getByRole("radio", { name: /^Admin/ }))
      .toBeVisible();
  });

  test("an admin invites members only", async () => {
    installFakeApi({ access: ADMIN_ACCESS });
    renderApp(MEMBERS);
    await page.getByRole("button", { name: "Invite" }).click();
    const form = dialog("Invite someone");
    await expect.element(form.getByRole("radio", { name: /^Viewer/ })).toBeVisible();
    await expect.element(form.getByRole("radio", { name: /^Admin/ })).not.toBeInTheDocument();
  });

  test("an admin acts on members only, and cannot hand over ownership", async () => {
    installFakeApi({ access: ADMIN_ACCESS });
    renderApp(MEMBERS);
    await expect.element(page.getByRole("button", { name: "Remove Mia Member" })).toBeVisible();
    for (const name of [
      "Remove Ada Admin",
      "Remove Test Owner",
      "Change the access of Test Owner",
      "Make Mia Member the owner",
    ]) {
      await expect.element(page.getByRole("button", { name })).not.toBeInTheDocument();
    }
  });

  test("changes a member's access, removes a member, and makes a reset link", async () => {
    const api = installFakeApi();
    renderApp(MEMBERS);

    await page.getByRole("button", { name: "Change the access of Mia Member" }).click();
    const change = dialog("Change the access of Mia Member");
    await change.getByRole("radio", { name: /^Admin/ }).click();
    await change.getByRole("button", { name: "Save access" }).click();
    await expect.element(change).not.toBeInTheDocument();
    expect(api.bodies).toContainEqual({
      method: "PATCH",
      path: "/api/members/user-3",
      body: { role: "admin" },
    });

    await page.getByRole("button", { name: "Make a reset link for Ada Admin" }).click();
    const reset = dialog("A reset link for Ada Admin");
    await reset.getByRole("button", { name: "Make the link" }).click();
    await expect
      .element(reset.getByText("http://localhost:5173/reset-password#token=reset-token"))
      .toBeVisible();
    await reset.getByRole("button", { name: "Done" }).click();

    await page.getByRole("button", { name: "Remove Ada Admin" }).click();
    await dialog("Remove Ada Admin?").getByRole("button", { name: "Remove" }).click();
    await expect.element(page.getByText("ada@example.com")).not.toBeInTheDocument();
  });

  test("hands over ownership after the password, refusing a wrong one", async () => {
    installFakeApi();
    renderApp(MEMBERS);
    await page.getByRole("button", { name: "Make Ada Admin the owner" }).click();
    const hand = dialog("Make Ada Admin the owner?");
    await hand.getByLabelText("Your password").fill("not it");
    await hand.getByRole("button", { name: "Hand over ownership" }).click();
    await expect
      .element(hand.getByText("The password is incorrect. Enter it again."))
      .toBeVisible();
    // The password does not stay in the form after a failure, or after closing.
    await expect.element(hand.getByLabelText("Your password")).toHaveValue("");
    await hand.getByLabelText("Your password").fill("typed, then cancelled");
    await hand.getByRole("button", { name: "Cancel" }).click();
    await page.getByRole("button", { name: "Make Ada Admin the owner" }).click();
    await expect.element(hand.getByLabelText("Your password")).toHaveValue("");
    await hand.getByLabelText("Your password").fill(ADMIN_PASSWORD);
    await hand.getByRole("button", { name: "Hand over ownership" }).click();
    await expect.element(hand).not.toBeInTheDocument();
    await expect.poll(() => rowsOf("Members")[0]?.[2]).toBe("Admin");
  });

  test("renews and revokes an invitation", async () => {
    installFakeApi();
    renderApp(MEMBERS);
    await page.getByRole("button", { name: "Make a new link for zoe@example.com" }).click();
    const renew = dialog("A new link for zoe@example.com");
    await renew.getByRole("button", { name: "Make a new link" }).click();
    await expect.element(renew.getByText(/renewed-invite-token/)).toBeVisible();
    await renew.getByRole("button", { name: "Done" }).click();

    await page.getByRole("button", { name: "Revoke the invitation of zoe@example.com" }).click();
    await dialog("Revoke the invitation of zoe@example.com?")
      .getByRole("button", { name: "Revoke" })
      .click();
    await expect.element(page.getByText("No pending invitations.")).toBeVisible();
  });
});
