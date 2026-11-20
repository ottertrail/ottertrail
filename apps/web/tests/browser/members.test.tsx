import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser/context";

import {
  ADMIN_ACCESS,
  ADMIN_PASSWORD,
  fakeMembers,
  installFakeApi,
  memberAccess,
  PROJECT,
  requestUrl,
} from "./fake-api.ts";
import { currentPath, renderApp } from "./render.tsx";

/*
 * The Members page: two tabs, Members and Invitations (?tab=invitations),
 * each a table, with a menu on each row holding what the role rules allow
 * (docs/access.md), and Change access in a sheet under the save rule.
 */

const MEMBERS = "/settings/members";
const INVITATIONS = `${MEMBERS}?tab=invitations`;
const workspaceMenu = () => page.getByRole("navigation", { name: "Instance" });
const dialog = (name: string) => page.getByRole("dialog", { name });
const sheet = (name: string) => dialog(`Change access for ${name}`);
const accessForm = () => page.getByRole("form", { name: "Access" });
const saveAccess = () => accessForm().getByRole("button", { name: "Save", exact: true });
const accessStatus = () => accessForm().getByRole("status");
const tab = (name: RegExp) => page.getByRole("tab", { name });
const menuButton = (name: string) => page.getByRole("button", { name: `More actions for ${name}` });
const menuItems = () =>
  [...document.querySelectorAll("[role=menuitem]")].map((item) => item.textContent);
/** Waits long enough for a click's effect to show, before asserting it had none. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

const rowsOf = (caption: string) => {
  const table = [...document.querySelectorAll("table")].find(
    (element) => element.caption?.textContent === caption,
  );
  return [...(table?.tBodies[0]?.rows ?? [])].map((row) =>
    [...row.cells].map((cell) => cell.textContent ?? ""),
  );
};
const rowOf = (text: string) =>
  [...document.querySelectorAll<HTMLTableRowElement>("tbody tr")].find((row) =>
    row.textContent?.includes(text),
  );

/** Opens a row's menu and picks an item. */
async function act(name: string, item: string) {
  await menuButton(name).click();
  await page.getByRole("menuitem", { name: item }).click();
}

/** Opens a row's menu, reads its items, and closes it. */
async function itemsFor(name: string) {
  await menuButton(name).click();
  await expect.element(page.getByRole("menu")).toBeVisible();
  const items = menuItems();
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByRole("menu")).not.toBeInTheDocument();
  return items;
}

afterEach(async () => {
  await page.viewport(1280, 900);
});

describe("the Members page", () => {
  test("lists the members in a table, and is in the workspace menu", async () => {
    installFakeApi();
    renderApp("/projects");
    await workspaceMenu().getByRole("link", { name: "Members" }).click();

    await expect.element(page.getByRole("table", { name: "Members" })).toBeVisible();
    const heads = [...document.querySelectorAll("thead th")].map((th) => th.textContent);
    expect(heads).toEqual(["Name", "Role", "Access", "Last sign-in", "Actions"]);
    expect(rowsOf("Members")).toEqual([
      ["Test OwnerYouowner@example.com", "Owner", "Everything", "16 Nov 2026", ""],
      ["Ada Adminada@example.com", "Admin", "Everything", "Never", ""],
      ["Mia Membermia@example.com", "Member", "Viewer · All projects", "15 Nov 2026", ""],
    ]);
    // The summary page of the old layout is gone.
    expect(document.body.textContent).not.toContain("Everyone with access");
  });

  test("the tabs: Members with its count, Invitations with a badge of pending ones, in the address", async () => {
    const members = fakeMembers();
    const [invitation] = members.invitations;
    if (invitation === undefined) throw new Error("the fixtures changed");
    const inFive = new Date(Date.now() + 5 * 86_400_000 + 60_000).toISOString();
    members.invitations = [
      { ...invitation, expiresAt: inFive },
      {
        ...invitation,
        id: "invite-old",
        email: "old@example.com",
        expiresAt: "2026-01-01T00:00:00.000Z",
      },
    ];
    installFakeApi({ members });
    const router = renderApp(MEMBERS);

    await expect.element(tab(/^Members/)).toHaveAttribute("aria-selected", "true");
    await expect.element(tab(/^Members/)).toHaveAccessibleName("Members 3");
    // Only the invitation still working counts as pending; screen readers hear it in words.
    await expect.element(tab(/^Invitations/)).toHaveAccessibleName("Invitations 1 pending");
    expect(
      document.querySelector("[data-members-tab=invitations] [data-slot=badge]")?.textContent,
    ).toBe("1");

    await tab(/^Invitations/).click();
    await expect.poll(() => currentPath(router)).toBe(INVITATIONS);
    await expect.element(page.getByRole("table", { name: "Pending invitations" })).toBeVisible();
    const heads = [...document.querySelectorAll("thead th")].map((th) => th.textContent);
    expect(heads).toEqual([
      "Email",
      "Role",
      "Access",
      "Invited by",
      "Created",
      "Expires",
      "Actions",
    ]);
    expect(rowsOf("Pending invitations")).toEqual([
      [
        "zoe@example.com",
        "Member",
        "Marketing · 1 project",
        "Test Owner",
        "16 Nov 2026",
        "in 5 days",
        "",
      ],
      [
        "old@example.com",
        "Member",
        "Marketing · 1 project",
        "Test Owner",
        "16 Nov 2026",
        "Expired",
        "",
      ],
    ]);
    // The moment it expires is in the time element, to the minute.
    expect(document.querySelector(`time[datetime="${inFive}"]`)).not.toBeNull();
    await expect
      .element(
        page.getByText("Only a fingerprint is saved, so invitation links can't be retrieved.", {
          exact: false,
        }),
      )
      .toBeVisible();

    await tab(/^Members/).click();
    await expect.poll(() => currentPath(router)).toBe(MEMBERS);
  });

  test("no badge without pending invitations, an empty state, and an unknown tab falls back", async () => {
    const members = fakeMembers();
    members.invitations = [];
    installFakeApi({ members });
    renderApp(`${MEMBERS}?tab=nonsense`);
    await expect.element(tab(/^Members/)).toHaveAttribute("aria-selected", "true");
    await expect.element(tab(/^Invitations/)).toHaveAccessibleName("Invitations");
    await tab(/^Invitations/).click();
    await expect.element(page.getByText("No pending invitations")).toBeVisible();
    await expect.element(page.getByText("Choose Invite", { exact: false })).toBeVisible();
  });

  test("members have no Members page or link", async () => {
    installFakeApi({ access: memberAccess({ web_analytics: "view" }) });
    renderApp(MEMBERS);
    await expect.element(page.getByText("You don't have access")).toBeVisible();
    await expect
      .element(workspaceMenu().getByRole("link", { name: "Members" }))
      .not.toBeInTheDocument();
  });

  test("invites a member with a preset, changed areas, and chosen projects, and shows the link once to copy", async () => {
    const api = installFakeApi();
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    renderApp(MEMBERS);
    await page.getByRole("button", { name: "Invite" }).click();
    const form = dialog("Invite someone");
    // Why no email goes out, and what to do instead.
    await expect
      .element(form.getByText("Email isn't set up. Copy the invitation link", { exact: false }))
      .toBeVisible();
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
    await form.getByRole("button", { name: "Copy the link" }).click();
    expect(writeText).toHaveBeenCalledWith("http://localhost:5173/invite#token=new-invite-token");
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
    await form.getByRole("button", { name: "Done" }).click();
    // The new invitation is counted and listed, the link no longer shown anywhere.
    await expect.element(tab(/^Invitations/)).toHaveAccessibleName("Invitations 2 pending");
    await tab(/^Invitations/).click();
    await expect.poll(() => rowsOf("Pending invitations")[0]?.[0]).toBe("leo@example.com");
    expect(rowsOf("Pending invitations")[0]?.[2]).toBe(
      "Web analytics, Product analytics, Errors, Replays, Users, Monitoring, Uptime and alerts · 1 project",
    );
    expect(document.body.textContent).not.toContain("new-invite-token");
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

  test("the owner's row menus: every action on others, none on themselves", async () => {
    installFakeApi();
    renderApp(MEMBERS);
    await expect.element(page.getByRole("table", { name: "Members" })).toBeVisible();
    expect(await itemsFor("Ada Admin")).toEqual([
      "Change access",
      "Make reset link",
      "Make owner",
      "Remove",
    ]);
    expect(await itemsFor("Mia Member")).toEqual([
      "Change access",
      "Make reset link",
      "Make owner",
      "Remove",
    ]);
    await expect.element(menuButton("Test Owner")).not.toBeInTheDocument();
    await expect.element(page.getByText("Owners keep full access", { exact: false })).toBeVisible();
  });

  test("an admin's row menus: members only, and no ownership", async () => {
    // The fixtures sign the admin in as the first person listed: themselves.
    installFakeApi({ access: ADMIN_ACCESS });
    renderApp(MEMBERS);
    await expect.element(page.getByRole("table", { name: "Members" })).toBeVisible();
    expect(await itemsFor("Mia Member")).toEqual(["Change access", "Make reset link", "Remove"]);
    for (const name of ["Ada Admin", "Test Owner"]) {
      await expect.element(menuButton(name)).not.toBeInTheDocument();
    }
    // Rows the admin can't change open nothing, and their names are no buttons.
    await expect.element(page.getByRole("button", { name: /^Ada Admin/ })).not.toBeInTheDocument();
    rowOf("Ada Admin")?.cells[2]?.click();
    await settle();
    expect(document.querySelector("[data-slot=sheet-content]")).toBeNull();
    await expect
      .element(page.getByText("Only the owner can manage admins", { exact: false }))
      .toBeVisible();
  });

  test("an admin who is the second row sees the owner's row without actions", async () => {
    installFakeApi({ access: ADMIN_ACCESS, membersYou: "user-2" });
    renderApp(MEMBERS);
    await expect
      .element(page.getByRole("row").filter({ hasText: "Ada Admin" }))
      .toMatchTextContent(/You/);
    await expect.element(menuButton("Test Owner")).not.toBeInTheDocument();
    await expect.element(menuButton("Ada Admin")).not.toBeInTheDocument();
    await expect.element(menuButton("Mia Member")).toBeVisible();
  });

  test("a member's row menu has no Make owner for an admin, and the invitation menus follow the role rules", async () => {
    const members = fakeMembers();
    const [invitation] = members.invitations;
    if (invitation === undefined) throw new Error("the fixtures changed");
    members.invitations = [
      { ...invitation, id: "invite-admin", email: "boss@example.com", role: "admin", access: null },
      invitation,
    ];
    installFakeApi({ access: ADMIN_ACCESS, members });
    renderApp(INVITATIONS);
    await expect.element(page.getByRole("table", { name: "Pending invitations" })).toBeVisible();
    await expect.element(menuButton("boss@example.com")).not.toBeInTheDocument();
    expect(await itemsFor("zoe@example.com")).toEqual(["New link", "Revoke"]);
    await expect
      .element(
        page.getByText("Only the owner can renew or revoke admin invitations", { exact: false }),
      )
      .toBeVisible();
  });

  test("a click on a member's row opens Change access; a click on its menu button opens only the menu", async () => {
    installFakeApi();
    renderApp(MEMBERS);
    await expect.element(page.getByRole("table", { name: "Members" })).toBeVisible();
    rowOf("Mia Member")?.cells[3]?.click();
    await expect.element(sheet("Mia Member")).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await expect.element(sheet("Mia Member")).not.toBeInTheDocument();
    // Focus returns to the row's menu button.
    await expect
      .poll(() => document.activeElement?.getAttribute("aria-label"))
      .toBe("More actions for Mia Member");

    await menuButton("Ada Admin").click();
    await expect.element(page.getByRole("menu")).toBeVisible();
    expect(document.querySelector("[data-slot=sheet-content]")).toBeNull();
    await userEvent.keyboard("{Escape}");

    // The name is the button the row stands for, for the keyboard.
    await page.getByRole("button", { name: "Ada Admin, change access" }).click();
    await expect.element(sheet("Ada Admin")).toBeVisible();
  });

  test("changing a member's access follows the save rule", async () => {
    const api = installFakeApi();
    renderApp(MEMBERS);
    await act("Mia Member", "Change access");
    await expect.element(sheet("Mia Member")).toBeVisible();
    await expect
      .element(
        sheet("Mia Member").getByText("Changes apply on their next action", { exact: false }),
      )
      .toBeVisible();

    // Save waits for a change; undoing the change by hand disables it again.
    await expect.element(saveAccess()).toHaveAttribute("aria-disabled", "true");
    await expect.element(accessStatus()).toHaveTextContent("No unsaved changes");
    await accessForm()
      .getByRole("radio", { name: /^Marketing/ })
      .click();
    await expect.element(accessStatus()).toHaveTextContent("Unsaved changes");
    await expect.element(saveAccess()).not.toHaveAttribute("aria-disabled", "true");
    await accessForm()
      .getByRole("radio", { name: /^Viewer/ })
      .click();
    await expect.element(saveAccess()).toHaveAttribute("aria-disabled", "true");

    // Cancel with a change asks; Keep editing keeps it, Discard drops it and closes.
    await accessForm()
      .getByRole("radio", { name: /^Admin/ })
      .click();
    await accessForm().getByRole("button", { name: "Cancel" }).click();
    const ask = dialog("Discard your changes?");
    await expect.element(ask).toBeVisible();
    await ask.getByRole("button", { name: "Keep editing" }).click();
    await expect.element(ask).not.toBeInTheDocument();
    await expect.element(accessForm().getByRole("radio", { name: /^Admin/ })).toBeChecked();
    await accessForm().getByRole("button", { name: "Cancel" }).click();
    await ask.getByRole("button", { name: "Discard changes" }).click();
    await expect.element(sheet("Mia Member")).not.toBeInTheDocument();
    await settle();
    expect(api.bodies).toEqual([]);

    // Opened again, it starts from the saved access. Save sends it, closes, and says so.
    await act("Mia Member", "Change access");
    await expect.element(accessForm().getByRole("radio", { name: /^Member/ })).toBeChecked();
    await accessForm()
      .getByRole("radio", { name: /^Admin/ })
      .click();
    await saveAccess().click();
    await expect.element(sheet("Mia Member")).not.toBeInTheDocument();
    expect(api.bodies).toEqual([
      { method: "PATCH", path: "/api/members/user-3", body: { role: "admin" } },
    ]);
    await expect.poll(() => rowsOf("Members")[2]?.[1]).toBe("Admin");
    await expect
      .element(page.getByRole("status").filter({ hasText: "Mia Member's access was saved." }))
      .toBeVisible();
    await expect
      .poll(() => document.activeElement?.getAttribute("aria-label"))
      .toBe("More actions for Mia Member");
  });

  test("closing the sheet unchanged does not ask; Escape and the close button with changes do", async () => {
    installFakeApi();
    renderApp(MEMBERS);
    await act("Mia Member", "Change access");
    await userEvent.keyboard("{Escape}");
    await expect.element(sheet("Mia Member")).not.toBeInTheDocument();
    expect(dialog("Discard your changes?").elements()).toEqual([]);

    await act("Mia Member", "Change access");
    await accessForm()
      .getByRole("radio", { name: /^Marketing/ })
      .click();
    await userEvent.keyboard("{Escape}");
    await expect.element(dialog("Discard your changes?")).toBeVisible();
    await dialog("Discard your changes?").getByRole("button", { name: "Keep editing" }).click();
    await sheet("Mia Member").getByRole("button", { name: "Close" }).click();
    await expect.element(dialog("Discard your changes?")).toBeVisible();
  });

  test("demoting an admin says their invitations go", async () => {
    installFakeApi();
    renderApp(MEMBERS);
    await act("Ada Admin", "Change access");
    await accessForm()
      .getByRole("radio", { name: /^Member/ })
      .click();
    await expect
      .element(accessForm().getByText("will be revoked; send replacements", { exact: false }))
      .toBeVisible();
  });

  test("a member's chosen projects need one before Save sends them", async () => {
    const api = installFakeApi();
    renderApp(MEMBERS);
    await act("Mia Member", "Change access");
    await accessForm().getByRole("radio", { name: "Chosen projects" }).click();
    await saveAccess().click();
    await expect
      .element(accessForm().getByRole("alert"))
      .toMatchTextContent(/Choose at least one project, or choose all projects\.$/);
    await settle();
    expect(api.bodies).toEqual([]);

    await accessForm().getByRole("checkbox", { name: PROJECT.name }).click();
    await expect.element(accessForm().getByRole("alert")).not.toBeInTheDocument();
    await saveAccess().click();
    await expect.element(sheet("Mia Member")).not.toBeInTheDocument();
    expect(api.bodies.at(-1)).toEqual({
      method: "PATCH",
      path: "/api/members/user-3",
      body: { role: "member", access: { projects: [PROJECT.id], areas: expect.any(Object) } },
    });
  });

  test("leaving the page with unsaved access asks first", async () => {
    const api = installFakeApi();
    const router = renderApp(MEMBERS);
    await act("Mia Member", "Change access");
    await accessForm()
      .getByRole("radio", { name: /^Engineering/ })
      .click();
    void router.navigate({ to: "/projects" });
    const ask = dialog("Leave without saving?");
    await expect.element(ask).toBeVisible();
    await ask.getByRole("button", { name: "Stay on this page" }).click();
    expect(currentPath(router)).toBe(MEMBERS);
    await expect.element(accessForm().getByRole("radio", { name: /^Engineering/ })).toBeChecked();

    void router.navigate({ to: "/projects" });
    await ask.getByRole("button", { name: "Leave and discard" }).click();
    await expect.poll(() => currentPath(router)).toBe("/projects");
    expect(api.bodies).toEqual([]);
  });

  test("makes a reset link to copy, says why it isn't emailed, and focus returns to the menu", async () => {
    installFakeApi();
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    renderApp(MEMBERS);
    await act("Ada Admin", "Make reset link");
    const reset = dialog("A reset link for Ada Admin");
    await expect
      .element(
        reset.getByText("Email isn't set up. Copy the reset link and send it yourself.", {
          exact: false,
        }),
      )
      .toBeVisible();
    await reset.getByRole("button", { name: "Make the link" }).click();
    await expect
      .element(reset.getByText("http://localhost:5173/reset-password#token=reset-token"))
      .toBeVisible();
    await reset.getByRole("button", { name: "Copy the link" }).click();
    expect(writeText).toHaveBeenCalledWith(
      "http://localhost:5173/reset-password#token=reset-token",
    );
    await reset.getByRole("button", { name: "Done" }).click();
    await expect.element(reset).not.toBeInTheDocument();
    await expect
      .poll(() => document.activeElement?.getAttribute("aria-label"))
      .toBe("More actions for Ada Admin");
  });

  test("hands over ownership after the password, refusing a wrong one", async () => {
    installFakeApi();
    renderApp(MEMBERS);
    await act("Ada Admin", "Make owner");
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
    await act("Ada Admin", "Make owner");
    await expect.element(hand.getByLabelText("Your password")).toHaveValue("");
    await hand.getByLabelText("Your password").fill(ADMIN_PASSWORD);
    await hand.getByRole("button", { name: "Hand over ownership" }).click();
    await expect.element(hand).not.toBeInTheDocument();
    await expect.poll(() => rowsOf("Members")[0]?.[1]).toBe("Admin");
    // Ada is the owner now: nobody acts on her here, the old owner included.
    await expect.poll(() => rowsOf("Members")[1]?.[1]).toBe("Owner");
    await expect.element(menuButton("Ada Admin")).not.toBeInTheDocument();
  });

  test("a failed load says so, and Retry loads the page", async () => {
    installFakeApi();
    const realFetch = globalThis.fetch;
    let fail = true;
    globalThis.fetch = async (input, init) =>
      fail && requestUrl(input).pathname === "/api/members"
        ? new Response(JSON.stringify({ error: "internal", message: "The database is down." }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          })
        : realFetch(input, init);
    try {
      renderApp(MEMBERS);
      await expect.element(page.getByText("Members could not load")).toBeVisible();
      await expect.element(page.getByText("The database is down.")).toBeVisible();
      fail = false;
      await page.getByRole("button", { name: "Retry" }).click();
      await expect.element(page.getByRole("table", { name: "Members" })).toBeVisible();
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("while loading, the page shows its shape", async () => {
    installFakeApi();
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) =>
      requestUrl(input).pathname === "/api/members"
        ? new Promise<Response>(() => {})
        : realFetch(input, init);
    try {
      renderApp(MEMBERS);
      await expect.element(page.getByLabelText("Loading members")).toBeVisible();
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

for (const [width, height] of [
  [390, 844],
  [1440, 900],
] as const) {
  describe(`at ${width} wide`, () => {
    test("removing someone asks first, moves focus to the next row's menu, and says so once", async () => {
      await page.viewport(width, height);
      const api = installFakeApi();
      renderApp(MEMBERS);

      await act("Ada Admin", "Remove");
      await dialog("Remove Ada Admin?").getByRole("button", { name: "Remove" }).click();
      await expect.element(dialog("Remove Ada Admin?")).not.toBeInTheDocument();
      expect(api.members.members.map((member) => member.id)).toEqual(["user-1", "user-3"]);
      // One live region, always there, says it.
      const notice = page.getByRole("status").filter({ hasText: "Ada Admin was removed." });
      await expect.element(notice).toBeVisible();
      expect(document.querySelectorAll("[data-slot=members-notice]")).toHaveLength(1);
      await expect.element(page.getByText("ada@example.com")).not.toBeInTheDocument();
      await expect
        .poll(() => document.activeElement?.getAttribute("aria-label"))
        .toBe("More actions for Mia Member");

      // The next action clears it.
      await act("Mia Member", "Make reset link");
      await userEvent.keyboard("{Escape}");
      await settle();
      expect(document.querySelector("[data-slot=members-notice]")?.textContent).toBe("");
    });

    test("revoking needs confirming; the last one moves focus to its tab, and says so", async () => {
      await page.viewport(width, height);
      const api = installFakeApi();
      renderApp(INVITATIONS);
      await act("zoe@example.com", "New link");
      const renew = dialog("A new link for zoe@example.com");
      await renew.getByRole("button", { name: "Make a new link" }).click();
      await expect.element(renew.getByText(/renewed-invite-token/)).toBeVisible();
      await renew.getByRole("button", { name: "Done" }).click();

      // Cancelling the confirmation revokes nothing.
      await act("zoe@example.com", "Revoke");
      const revoke = dialog("Revoke the invitation of zoe@example.com?");
      await revoke.getByRole("button", { name: "Cancel" }).click();
      await settle();
      expect(api.members.invitations).toHaveLength(1);

      await act("zoe@example.com", "Revoke");
      await revoke.getByRole("button", { name: "Revoke" }).click();
      await expect.element(page.getByText("No pending invitations")).toBeVisible();
      await expect
        .element(
          page
            .getByRole("status")
            .filter({ hasText: "The invitation of zoe@example.com was revoked." }),
        )
        .toBeVisible();
      await expect
        .poll(() => document.activeElement?.getAttribute("data-members-tab"))
        .toBe("invitations");
      await expect.element(tab(/^Invitations/)).toHaveAccessibleName("Invitations");
    });

    test("Change access opens as a sheet that fits", async () => {
      await page.viewport(width, height);
      installFakeApi();
      renderApp(MEMBERS);
      await act("Mia Member", "Change access");
      await expect.element(sheet("Mia Member")).toBeVisible();
      const box = document.querySelector("[data-slot=sheet-content]")?.getBoundingClientRect();
      expect(box !== undefined && box.right <= width + 1 && box.left >= 0).toBe(true);
      // The whole width on a phone, 36rem from 40rem.
      expect(box?.width).toBe(Math.min(width, 576));
    });
  });
}

/** Nothing in the content panel or the page scrolls sideways, and no cell spills. */
function expectFits(width: number) {
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
  const panel = document.querySelector("[data-slot=app-content]");
  expect(panel?.scrollWidth).toBeLessThanOrEqual(panel?.clientWidth ?? 0);
  for (const container of document.querySelectorAll<HTMLElement>("[data-slot=table-container]")) {
    expect(container.scrollWidth).toBeLessThanOrEqual(container.clientWidth);
  }
}

describe("the Members page on a phone and a wide screen", () => {
  test("at 390 the tables are stacked rows with the menu at the right, and nothing scrolls sideways", async () => {
    await page.viewport(390, 844);
    installFakeApi();
    renderApp(MEMBERS);

    await expect.element(page.getByRole("table", { name: "Members" })).toBeVisible();
    const heads = [...document.querySelectorAll("thead th")].map((th) => th.textContent);
    expect(heads).toEqual(["Member", "Actions"]);
    expect(rowsOf("Members")[2]).toEqual([
      "Mia MemberMembermia@example.comViewer · All projects·Last sign-in 15 Nov 2026",
      "",
    ]);
    const mia = rowOf("Mia Member");
    const name = mia?.querySelector("[data-row-link]")?.getBoundingClientRect();
    const role = [...(mia?.querySelectorAll("span") ?? [])]
      .find((span) => span.textContent === "Member")
      ?.getBoundingClientRect();
    // The name and the role on one line.
    expect(name !== undefined && role !== undefined && Math.abs(name.top - role.top) < 4).toBe(
      true,
    );
    await expect.element(menuButton("Mia Member")).toBeVisible();
    expectFits(390);

    // The tab row and Invite fit beside each other.
    const invite = page.getByRole("button", { name: "Invite" }).element().getBoundingClientRect();
    expect(invite.right).toBeLessThanOrEqual(390);
    await tab(/^Invitations/).click();
    expect(rowsOf("Pending invitations")[0]?.[0]).toMatch(
      /^zoe@example\.comMemberMarketing · 1 projectExpires in \d[\d,]* days·Invited by Test Owner$/,
    );
    expectFits(390);
  });

  test("an open reset link and a typed password survive crossing to the phone layout", async () => {
    await page.viewport(1024, 768);
    installFakeApi();
    renderApp(MEMBERS);
    await act("Mia Member", "Make reset link");
    const reset = dialog("A reset link for Mia Member");
    await reset.getByRole("button", { name: "Make the link" }).click();
    await expect.element(reset.getByText(/reset-password#token=reset-token/)).toBeVisible();
    await page.viewport(390, 844);
    await settle();
    await expect.element(reset.getByText(/reset-password#token=reset-token/)).toBeVisible();
    await reset.getByRole("button", { name: "Done" }).click();

    await act("Mia Member", "Make owner");
    const hand = dialog("Make Mia Member the owner?");
    await hand.getByLabelText("Your password").fill("half typed");
    await page.viewport(1024, 768);
    await settle();
    await expect.element(hand.getByLabelText("Your password")).toHaveValue("half typed");
  });

  test("at 1440 both tables fit, and a cut-off text shows in full in a tooltip on focus", async () => {
    await page.viewport(1440, 900);
    const members = fakeMembers();
    const long = `${"a-very-long-address-".repeat(6)}@example.com`;
    members.members = members.members.map((member) =>
      member.id === "user-3" ? { ...member, email: long } : member,
    );
    installFakeApi({ members });
    renderApp(MEMBERS);
    await expect.element(page.getByRole("table", { name: "Members" })).toBeVisible();
    expectFits(1440);
    // A text that fits takes no tab stop and no tooltip.
    const short = page.getByText("ada@example.com").element();
    expect(short.getAttribute("tabindex")).toBeNull();
    const cut = page.getByText(long).element() as HTMLElement;
    await expect.poll(() => cut.getAttribute("tabindex")).toBe("0");
    // From the name before it, Tab reaches it, and its tooltip shows the whole address.
    page.getByRole("button", { name: "Mia Member, change access" }).element().focus();
    await userEvent.keyboard("{Tab}");
    expect(document.activeElement).toBe(cut);
    await expect
      .poll(() => document.querySelector("[data-slot=tooltip-content]")?.textContent)
      .toBe(long);

    await tab(/^Invitations/).click();
    await expect.element(page.getByRole("table", { name: "Pending invitations" })).toBeVisible();
    expectFits(1440);
  });
});
