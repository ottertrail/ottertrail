import { describe, expect, test } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser/context";

import { type FakeApi, fakeUsers, installFakeApi, PROJECT } from "./fake-api.ts";
import { renderApp } from "./render.tsx";

const USERS = `/projects/${PROJECT.id}/users`;

/** The query of the latest request to `path`, such as { search: "ada" }. */
function lastQuery(api: FakeApi, path: string): Record<string, string> {
  const request = api.requests.findLast((item) => item.split("?")[0]?.endsWith(path)) ?? "";
  const at = request.indexOf("?");
  return at === -1 ? {} : Object.fromEntries(new URLSearchParams(request.slice(at + 1)));
}

/** How many events a user's page lists. */
const activityCount = () => document.querySelectorAll("ol > li").length;

/** The user IDs the table lists, in order. */
const listedUsers = () =>
  [...document.querySelectorAll("tbody tr td:first-child")].map((cell) => cell.textContent);

describe("the users page", () => {
  test("opens from the sidebar and lists users, most recently seen first", async () => {
    installFakeApi();
    const router = renderApp(`/projects/${PROJECT.id}/web-analytics`);

    await page.getByRole("link", { name: "Users" }).click();

    await expect.poll(() => router.state.location.pathname).toBe(USERS);
    await expect.poll(() => listedUsers().length).toBe(50);
    expect(listedUsers().slice(0, 2)).toEqual(["user-1", "user-2"]);
    const firstRow = document.querySelector("tbody tr");
    expect([...(firstRow?.querySelectorAll("td") ?? [])].map((cell) => cell.textContent)).toEqual([
      "user-1",
      expect.stringMatching(/ago|yesterday|just now/),
      "1 Nov 2026",
      "120",
    ]);
  });

  test("loads more, and searches by ID", async () => {
    const api = installFakeApi();
    renderApp(USERS);
    await expect.poll(() => listedUsers().length).toBe(50);

    await page.getByRole("button", { name: "Load more" }).click();
    await expect.poll(() => listedUsers().length).toBe(100);
    expect(lastQuery(api, "/users")).toEqual({ offset: "50" });

    await userEvent.type(page.getByLabelText("Search by user ID"), "user-11");
    await expect.poll(() => lastQuery(api, "/users")).toEqual({ search: "user-11" });
    await expect
      .poll(listedUsers)
      .toEqual([
        "user-11",
        "user-110",
        "user-111",
        "user-112",
        "user-113",
        "user-114",
        "user-115",
        "user-116",
        "user-117",
        "user-118",
        "user-119",
      ]);
  });

  test("says how to name users while there are none", async () => {
    installFakeApi({ users: (query) => ({ ...fakeUsers(query), users: [], hasMore: false }) });
    renderApp(USERS);

    await expect.element(page.getByText("No known users yet")).toBeVisible();
    await expect.element(page.getByText(/data-user-id="42"/)).toBeVisible();
    expect(document.querySelector("[aria-label='Search by user ID']")).toBeNull();
  });

  test("shows one environment, and keeps it in the links to users", async () => {
    const api = installFakeApi({
      users: (query) => ({
        ...fakeUsers(query),
        environments: ["production", "staging"],
        environment: query.get("environment") ?? "production",
      }),
    });
    const router = renderApp(`${USERS}?env=staging`);

    await expect.poll(() => lastQuery(api, "/users")).toEqual({ environment: "staging" });
    await expect
      .element(page.getByRole("combobox", { name: "Environment" }))
      .toMatchTextContent(/staging/);
    await page.getByRole("link", { name: "user-1", exact: true }).click();
    await expect.poll(() => router.state.location.search).toEqual({ env: "staging" });
    expect(router.state.location.pathname).toBe(`${USERS}/user-1`);
  });
});

describe("a user's page", () => {
  test("shows when they were seen and what they did, by day, newest first", async () => {
    installFakeApi();
    renderApp(`${USERS}/ada`);

    await expect.element(page.getByRole("heading", { name: "ada" })).toBeVisible();
    await expect
      .element(page.getByText("Times in Asia/Singapore.", { exact: false }))
      .toBeVisible();
    const today = page.getByRole("list", { name: "Activity on Monday, 16 November 2026" });
    await expect.element(today).toBeVisible();
    const items = [...(today.element().querySelectorAll(":scope > li") ?? [])];
    // 16:00 in Singapore is 08:00 UTC.
    expect(items[0]?.textContent).toContain("16:00");
    expect(items[0]?.textContent).toContain("Viewed /page-0");
    expect(items[1]?.textContent).toContain("signup on /signup");
    expect(items[1]?.textContent).toContain("plan: free");
    expect(items[1]?.textContent).toContain("Firefox · Linux · Munich, Germany · 1.4.2");
  });

  test("loads older activity from where the page ends", async () => {
    const api = installFakeApi();
    renderApp(`${USERS}/ada`);
    await expect.element(page.getByRole("heading", { name: "ada" })).toBeVisible();
    await expect.poll(activityCount).toBe(100);

    await page.getByRole("button", { name: "Load more" }).click();

    await expect.poll(activityCount).toBe(150);
    expect(lastQuery(api, "/users/ada")).toMatchObject({
      beforeId: "00000000-0000-4000-8000-000000000099",
    });
  });

  test("says when no event has the user ID", async () => {
    installFakeApi();
    renderApp(`${USERS}/${encodeURIComponent("nobody/else")}`);

    await expect.element(page.getByText("No events from this user")).toBeVisible();
    await expect.element(page.getByRole("link", { name: "See all users" })).toBeVisible();
  });
});
