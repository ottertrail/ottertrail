import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser/context";

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
 * The Members page: the list of members and pending invitations, with the
 * chosen person beside it (?member=, ?invitation=), and every action the
 * role rules allow (docs/access.md).
 */

const MEMBERS = "/settings/members";
const workspaceMenu = () => page.getByRole("navigation", { name: "Instance" });
const dialog = (name: string) => page.getByRole("dialog", { name });
const accessForm = () => page.getByRole("form", { name: "Access" });
const saveAccess = () => accessForm().getByRole("button", { name: "Save access" });
const accessStatus = () => accessForm().getByRole("status");
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

/** Chooses a person in the list by the link that names them. */
const choose = (name: string) => page.getByRole("link", { name, exact: true }).click();

/** Whether the list is hidden behind a person's page, as on a phone. */
const listHidden = () => {
  const list = document.querySelector("[data-slot=members-list]");
  return list !== null && getComputedStyle(list).display === "none";
};

/** On a phone the list is behind a person's page: back to it, then choose. */
async function chooseFromAnywhere(name: string, narrow: boolean) {
  if (narrow && document.querySelector("[data-slot=person-heading]") !== null) {
    await page.getByRole("link", { name: "All members" }).click();
  }
  await choose(name);
}

afterEach(async () => {
  await page.viewport(1280, 900);
});

describe("the Members page", () => {
  test("lists everyone and the pending invitations, and is in the workspace menu", async () => {
    installFakeApi();
    const router = renderApp("/projects");
    await workspaceMenu().getByRole("link", { name: "Members" }).click();

    await expect.element(page.getByRole("table", { name: "Members" })).toBeVisible();
    expect(rowsOf("Members")).toEqual([
      ["Test OwnerYouowner@example.com", "Owner", "16 Nov 2026"],
      ["Ada Adminada@example.com", "Admin", "Never"],
      ["Mia Membermia@example.com", "Member: Viewer, all projects", "15 Nov 2026"],
    ]);
    expect(rowsOf("Pending invitations")).toEqual([
      ["zoe@example.com", "Member: Marketing, 1 project", "1 Jan 2099"],
    ]);
    // Nobody is chosen on arrival: the pane beside the list sums them up.
    await expect.element(page.getByRole("heading", { name: "Everyone with access" })).toBeVisible();

    // An invitation's page has who invited them and when it expires, to the minute.
    await choose("zoe@example.com");
    await expect.poll(() => currentPath(router)).toBe(`${MEMBERS}?invitation=invite-1`);
    await expect.element(page.getByRole("heading", { name: "zoe@example.com" })).toBeVisible();
    await expect
      .element(page.getByRole("definition").filter({ hasText: /^Test Owner$/ }))
      .toBeVisible();
    await expect.element(page.getByText("1 Jan 2099, 08:00")).toBeVisible();
    await expect
      .element(page.getByRole("link", { name: "zoe@example.com" }))
      .toHaveAttribute("aria-current", "page");
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
    // The new invitation is listed, the link no longer shown anywhere.
    await expect.element(page.getByRole("link", { name: "leo@example.com" })).toBeVisible();
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

  test("an admin acts on members only, and cannot hand over ownership", async () => {
    installFakeApi({ access: ADMIN_ACCESS });
    renderApp(MEMBERS);

    await choose("Mia Member");
    await expect.element(page.getByRole("button", { name: "Remove Mia Member" })).toBeVisible();
    await expect.element(accessForm()).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Make a reset link for Mia Member" }))
      .toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Make Mia Member the owner" }))
      .not.toBeInTheDocument();

    await choose("Ada Admin");
    await expect
      .element(page.getByText("Only the owner changes an admin's access", { exact: false }))
      .toBeVisible();
    for (const name of ["Remove Ada Admin", "Make a reset link for Ada Admin"]) {
      await expect.element(page.getByRole("button", { name })).not.toBeInTheDocument();
    }
    await expect.element(accessForm()).not.toBeInTheDocument();

    // The fixtures sign the admin in as the first person listed: themselves.
    await choose("Test Owner");
    await expect
      .element(
        page.getByText("Nobody changes their own access or removes themselves here.", {
          exact: false,
        }),
      )
      .toBeVisible();
    for (const name of ["Remove Test Owner", "Make a reset link for Test Owner"]) {
      await expect.element(page.getByRole("button", { name })).not.toBeInTheDocument();
    }
    await expect.element(accessForm()).not.toBeInTheDocument();
  });

  test("an admin cannot renew or revoke an invitation to be an admin", async () => {
    const members = fakeMembers();
    const [invitation] = members.invitations;
    if (invitation === undefined) throw new Error("the fixtures changed");
    members.invitations = [{ ...invitation, role: "admin", access: null }];
    installFakeApi({ access: ADMIN_ACCESS, members });
    renderApp(`${MEMBERS}?invitation=${invitation.id}`);

    await expect
      .element(page.getByText("Only the owner renews or revokes an invitation to be an admin."))
      .toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Revoke the invitation of zoe@example.com" }))
      .not.toBeInTheDocument();
  });

  test("changing a member's access follows the save rule", async () => {
    const api = installFakeApi();
    renderApp(MEMBERS);
    await choose("Mia Member");

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

    // Discard puts the saved access back.
    await accessForm()
      .getByRole("radio", { name: /^Admin/ })
      .click();
    await accessForm().getByRole("button", { name: "Discard" }).click();
    await expect.element(accessForm().getByRole("radio", { name: /^Member/ })).toBeChecked();
    await settle();
    expect(api.bodies).toEqual([]);

    // Save sends it; the list shows the new role.
    await accessForm()
      .getByRole("radio", { name: /^Admin/ })
      .click();
    await saveAccess().click();
    await expect.element(accessStatus()).toHaveTextContent("No unsaved changes");
    expect(api.bodies).toEqual([
      { method: "PATCH", path: "/api/members/user-3", body: { role: "admin" } },
    ]);
    await expect.poll(() => rowsOf("Members")[2]?.[1]).toBe("Admin");
  });

  test("a member's chosen projects need one before Save sends them", async () => {
    const api = installFakeApi();
    renderApp(`${MEMBERS}?member=user-3`);
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
    await expect.element(accessStatus()).toHaveTextContent("No unsaved changes");
    expect(api.bodies.at(-1)).toEqual({
      method: "PATCH",
      path: "/api/members/user-3",
      body: { role: "member", access: { projects: [PROJECT.id], areas: expect.any(Object) } },
    });
  });

  test("with nothing changed, choosing someone else does not ask", async () => {
    installFakeApi();
    const router = renderApp(`${MEMBERS}?member=user-3`);
    await expect.element(accessForm()).toBeVisible();
    await choose("Ada Admin");
    await expect.poll(() => currentPath(router)).toBe(`${MEMBERS}?member=user-2`);
    await settle();
    expect(dialog("Leave without saving?").elements()).toEqual([]);
  });

  test("makes a reset link to copy", async () => {
    installFakeApi();
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    renderApp(MEMBERS);
    await choose("Ada Admin");

    await page.getByRole("button", { name: "Make a reset link for Ada Admin" }).click();
    const reset = dialog("A reset link for Ada Admin");
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
  });

  test("removing a member with unsaved access edits leaves without asking", async () => {
    installFakeApi();
    const router = renderApp(`${MEMBERS}?member=user-3`);
    await accessForm()
      .getByRole("radio", { name: /^Marketing/ })
      .click();
    await page.getByRole("button", { name: "Remove Mia Member" }).click();
    await dialog("Remove Mia Member?").getByRole("button", { name: "Remove" }).click();
    // Mia was last: the one before her is chosen.
    await expect.poll(() => currentPath(router)).toBe(`${MEMBERS}?member=user-2`);
    await settle();
    expect(dialog("Leave without saving?").elements()).toEqual([]);
  });

  test("an admin opening the owner's page can act on nothing there, and says why", async () => {
    installFakeApi({ access: ADMIN_ACCESS, membersYou: "user-2" });
    renderApp(MEMBERS);
    await expect
      .element(page.getByRole("row").filter({ hasText: "Ada Admin" }))
      .toMatchTextContent(/You/);

    await choose("Test Owner");
    await expect
      .element(
        page.getByText(
          "The owner has access to everything. Nobody else changes the owner's access, makes their reset link, or removes them.",
        ),
      )
      .toBeVisible();
    for (const name of [
      "Make Test Owner the owner",
      "Remove Test Owner",
      "Make a reset link for Test Owner",
    ]) {
      await expect.element(page.getByRole("button", { name })).not.toBeInTheDocument();
    }
    await expect.element(accessForm()).not.toBeInTheDocument();
  });

  test("hands over ownership after the password, refusing a wrong one", async () => {
    installFakeApi();
    renderApp(MEMBERS);
    await choose("Ada Admin");
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
    await expect.poll(() => rowsOf("Members")[0]?.[1]).toBe("Admin");
    // Ada is the owner now: nobody acts on her here, the old owner included.
    await expect
      .element(page.getByText("The owner has access to everything.", { exact: false }))
      .toBeVisible();
    for (const name of ["Remove Ada Admin", "Make Ada Admin the owner"]) {
      await expect.element(page.getByRole("button", { name })).not.toBeInTheDocument();
    }
  });

  test("a link to someone not on the list says so", async () => {
    installFakeApi();
    renderApp(`${MEMBERS}?member=user-9`);
    await expect
      .element(page.getByRole("heading", { name: "Nobody here has this link" }))
      .toBeVisible();
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
});

for (const [width, height] of [
  [390, 844],
  [1440, 900],
] as const) {
  const narrow = width < 1024;
  describe(`at ${width} wide`, () => {
    test("choosing someone else, or leaving, with unsaved access asks first", async () => {
      await page.viewport(width, height);
      const api = installFakeApi();
      const router = renderApp(`${MEMBERS}?member=user-3`);
      await accessForm()
        .getByRole("radio", { name: /^Engineering/ })
        .click();

      if (narrow) await page.getByRole("link", { name: "All members" }).click();
      else await choose("Ada Admin");
      const ask = dialog("Leave without saving?");
      await expect.element(ask).toBeVisible();
      await ask.getByRole("button", { name: "Stay on this page" }).click();
      await expect.element(ask).not.toBeInTheDocument();
      expect(currentPath(router)).toBe(`${MEMBERS}?member=user-3`);
      await expect.element(accessForm().getByRole("radio", { name: /^Engineering/ })).toBeChecked();

      if (narrow) await page.getByRole("button", { name: "Open menu" }).click();
      await page
        .getByRole("navigation", { name: "Instance" })
        .getByRole("link", { name: "Projects" })
        .click();
      await expect.element(ask).toBeVisible();
      await ask.getByRole("button", { name: "Leave and discard" }).click();
      await expect.poll(() => currentPath(router)).toBe("/projects");
      expect(api.bodies).toEqual([]);
    });

    test("removing someone chooses the next one, moves focus there, says so once, and the notice clears", async () => {
      await page.viewport(width, height);
      const api = installFakeApi();
      const router = renderApp(`${MEMBERS}?member=user-2`);

      await page.getByRole("button", { name: "Remove Ada Admin" }).click();
      await dialog("Remove Ada Admin?").getByRole("button", { name: "Remove" }).click();
      await expect.poll(() => currentPath(router)).toBe(`${MEMBERS}?member=user-3`);
      expect(api.members.members.map((member) => member.id)).toEqual(["user-1", "user-3"]);
      // One live region, always there, says it.
      const notice = page.getByRole("status").filter({ hasText: "Ada Admin was removed." });
      await expect.element(notice).toBeVisible();
      expect(document.querySelectorAll("[data-slot=members-notice]")).toHaveLength(1);
      await expect.element(page.getByText("ada@example.com")).not.toBeInTheDocument();
      // Focus is on the person chosen next: their row, or on a phone their page's heading.
      await expect
        .poll(() =>
          narrow
            ? document.activeElement?.textContent
            : document.activeElement?.getAttribute("data-person"),
        )
        .toBe(narrow ? "Mia Member" : "user-3");

      await chooseFromAnywhere("Test Owner", narrow);
      await expect.poll(() => currentPath(router)).toBe(`${MEMBERS}?member=user-1`);
      await expect.element(notice).not.toBeInTheDocument();
      if (narrow) await page.getByRole("link", { name: "All members" }).click();
      else await page.getByRole("link", { name: "Mia Member" }).click();
      await settle();
      expect(document.querySelector("[data-slot=members-notice]")?.textContent).toBe("");
    });

    test("revoking the last invitation moves focus to its list's heading, and says so", async () => {
      await page.viewport(width, height);
      installFakeApi();
      const router = renderApp(`${MEMBERS}?invitation=invite-1`);
      await page.getByRole("button", { name: "Make a new link for zoe@example.com" }).click();
      const renew = dialog("A new link for zoe@example.com");
      await renew.getByRole("button", { name: "Make a new link" }).click();
      await expect.element(renew.getByText(/renewed-invite-token/)).toBeVisible();
      await renew.getByRole("button", { name: "Done" }).click();

      await page.getByRole("button", { name: "Revoke the invitation of zoe@example.com" }).click();
      await dialog("Revoke the invitation of zoe@example.com?")
        .getByRole("button", { name: "Revoke" })
        .click();
      await expect.poll(() => currentPath(router)).toBe(MEMBERS);
      await expect.element(page.getByText("No pending invitations.")).toBeVisible();
      await expect
        .element(
          page
            .getByRole("status")
            .filter({ hasText: "The invitation of zoe@example.com was revoked." }),
        )
        .toBeVisible();
      await expect.poll(() => document.activeElement?.textContent).toBe("Pending invitations");
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
  test("at 390 the list and a person's page take the screen in turn", async () => {
    await page.viewport(390, 844);
    installFakeApi();
    const router = renderApp(MEMBERS);

    await expect.element(page.getByRole("table", { name: "Members" })).toBeVisible();
    // The person's page has the last sign-in; the list leaves it out on a phone.
    expect(rowsOf("Members")[2]).toEqual([
      "Mia Membermia@example.com",
      "Member: Viewer, all projects",
    ]);
    expectFits(390);

    await choose("Mia Member");
    await expect.element(page.getByRole("heading", { name: "Mia Member" })).toBeVisible();
    await expect.poll(listHidden).toBe(true);
    await expect.element(accessForm()).toBeVisible();
    // The way back is not marked as the current page.
    await expect
      .element(page.getByRole("link", { name: "All members" }))
      .not.toHaveAttribute("aria-current");
    expectFits(390);

    await page.getByRole("link", { name: "All members" }).click();
    await expect.poll(() => currentPath(router)).toBe(MEMBERS);
    await expect.element(page.getByRole("table", { name: "Members" })).toBeVisible();
  });

  test("turning a tablet across 64rem keeps unsaved access, an open link, and a typed password", async () => {
    await page.viewport(768, 1024);
    installFakeApi();
    renderApp(`${MEMBERS}?member=user-3`);
    await accessForm()
      .getByRole("radio", { name: /^Engineering/ })
      .click();
    await expect.element(accessStatus()).toHaveTextContent("Unsaved changes");

    // The one-time reset link, open while the screen turns to landscape.
    await page.getByRole("button", { name: "Make a reset link for Mia Member" }).click();
    const reset = dialog("A reset link for Mia Member");
    await reset.getByRole("button", { name: "Make the link" }).click();
    await expect.element(reset.getByText(/reset-password#token=reset-token/)).toBeVisible();
    await page.viewport(1024, 768);
    // The open dialog hides the page from the accessibility tree: the list is checked by its style.
    await expect.poll(listHidden).toBe(false);
    await settle();
    await expect.element(reset.getByText(/reset-password#token=reset-token/)).toBeVisible();
    await reset.getByRole("button", { name: "Done" }).click();

    // The access edits are still there, still unsaved, and leaving would still ask.
    await expect.element(accessForm().getByRole("radio", { name: /^Engineering/ })).toBeChecked();
    await expect.element(accessStatus()).toHaveTextContent("Unsaved changes");

    // A half-typed password survives turning back to portrait.
    await page.getByRole("button", { name: "Make Mia Member the owner" }).click();
    const hand = dialog("Make Mia Member the owner?");
    await hand.getByLabelText("Your password").fill("half typed");
    await page.viewport(768, 1024);
    await expect.poll(listHidden).toBe(true);
    await settle();
    await expect.element(hand.getByLabelText("Your password")).toHaveValue("half typed");
    await hand.getByRole("button", { name: "Cancel" }).click();
    await expect.element(accessForm().getByRole("radio", { name: /^Engineering/ })).toBeChecked();
  });

  test("at 1440 the chosen person sits beside the list, and both fit", async () => {
    await page.viewport(1440, 900);
    installFakeApi();
    renderApp(`${MEMBERS}?member=user-3`);

    await expect.element(page.getByRole("heading", { name: "Mia Member" })).toBeVisible();
    await expect.element(page.getByRole("table", { name: "Members" })).toBeVisible();
    const list = document.querySelector("[data-slot=members-list]")?.getBoundingClientRect();
    const detail = document.querySelector("[data-slot=members-detail]")?.getBoundingClientRect();
    expect(list !== undefined && detail !== undefined && list.right <= detail.left + 1).toBe(true);
    expectFits(1440);
    // The Save bar sits at the foot of the screen while the form is in view.
    const bar = document.querySelector("[data-slot=save-bar]");
    expect(bar === null ? "" : getComputedStyle(bar).position).toBe("sticky");
  });
});
