import { describe, expect, test } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser/context";

import { installFakeApi, memberAccess, PROJECT } from "./fake-api.ts";
import { renderApp } from "./render.tsx";

const USERS = `/projects/${PROJECT.id}/users`;

const dialog = () => page.getByRole("dialog", { name: "Delete the data of ada?" });
const notice = (text: string) => page.getByRole("note").filter({ hasText: text });
/** The list's row of a user. */
const row = (id: string) =>
  [...document.querySelectorAll("tbody tr")].find(
    (tr) => tr.querySelector("td a")?.textContent === id,
  );

describe("deleting a user's data", () => {
  test("the dialog says what goes and what stays; Cancel and Esc change nothing", async () => {
    const api = installFakeApi();
    const router = renderApp(`${USERS}/ada`);

    const open = page.getByRole("button", { name: "Delete data" });
    await open.click();
    await expect.element(dialog()).toBeVisible();
    const said = dialog().element().textContent;
    expect(said).toContain(
      "events, errors, session replays, AI calls, and the traces and logs that carry the ID. This cannot be undone.",
    );
    expect(said).toContain(
      "Stop your app from sending events for this user first. Events sent after the deletion are stored again.",
    );
    expect(said).toContain("Backups keep the data until they expire.");
    expect(dialog().element().contains(document.activeElement)).toBe(true);

    await dialog().getByRole("button", { name: "Cancel" }).click();
    await expect.element(dialog()).not.toBeInTheDocument();
    await expect.poll(() => document.activeElement).toBe(open.element());

    await open.click();
    await expect.element(dialog()).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await expect.element(dialog()).not.toBeInTheDocument();

    expect(api.userDeletions).toEqual([]);
    expect(router.state.location.pathname).toBe(`${USERS}/ada`);
  });

  test("confirming starts it and goes back to the list, which says it is pending", async () => {
    const api = installFakeApi();
    const router = renderApp(`${USERS}/ada`);

    await page.getByRole("button", { name: "Delete data" }).click();
    await dialog().getByRole("button", { name: "Delete data" }).click();

    await expect.poll(() => router.state.location.pathname).toBe(USERS);
    expect(api.userDeletions).toEqual(["ada"]);
    await expect.element(notice("Deleting the data of 1 user")).toBeVisible();
    expect(notice("Deleting the data of 1 user").element().textContent).toContain(
      "ada. It takes about a minute.",
    );
  });

  test("from the list's detail pane, it closes the pane", async () => {
    await page.viewport(1440, 900);
    const api = installFakeApi();
    const router = renderApp(`${USERS}?user=ada`);
    const pane = page.getByRole("region", { name: "Users, selected" });

    await pane.getByRole("button", { name: "Delete data" }).click();
    await dialog().getByRole("button", { name: "Delete data" }).click();

    await expect.poll(() => router.state.location.search).toEqual({});
    expect(api.userDeletions).toEqual(["ada"]);
    await expect.element(notice("Deleting the data of 1 user")).toBeVisible();
  });

  test("a refusal shows in the dialog, which stays open", async () => {
    installFakeApi({
      userDeletionRefusal: new Response(
        JSON.stringify({
          error: "too_many_pending",
          message: "1,000 deletions are waiting. Try again once they are done.",
        }),
        { status: 429, headers: { "content-type": "application/json" } },
      ),
    });
    renderApp(`${USERS}/ada`);

    await page.getByRole("button", { name: "Delete data" }).click();
    await dialog().getByRole("button", { name: "Delete data" }).click();
    await expect
      .element(dialog().getByRole("alert"))
      .toHaveTextContent("1,000 deletions are waiting. Try again once they are done.");
  });

  test("a pending deletion shows on the user's page, without the action", async () => {
    installFakeApi({ userDeletions: ["ada"] });
    renderApp(`${USERS}/ada`);

    await expect.element(notice("Deleting this user's data")).toBeVisible();
    expect(page.getByRole("button", { name: "Delete data" }).query()).toBeNull();
  });

  test("pending deletions show above the list, and on their rows", async () => {
    installFakeApi({ userDeletions: ["ada", "user-2"] });
    renderApp(USERS);

    await expect.element(notice("Deleting the data of 2 users")).toBeVisible();
    expect(notice("Deleting the data of 2 users").element().textContent).toContain(
      "ada, user-2. It takes about a minute.",
    );
    await expect.poll(() => row("user-2")?.textContent).toContain("Deleting");
    expect(row("user-1")?.textContent).not.toContain("Deleting");
  });

  test("only the owner and admins see the action", async () => {
    installFakeApi({ access: memberAccess({ users: "view", replays: "view" }) });
    renderApp(`${USERS}/ada`);
    await expect.element(page.getByText("First seen")).toBeVisible();
    expect(page.getByRole("button", { name: "Delete data" }).query()).toBeNull();
  });
});
