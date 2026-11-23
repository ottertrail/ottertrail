import { describe, expect, test } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser/context";

import { rangeCovering } from "@/features/users/format";

import { fakeAi, fakeAiReport, noAiCalls } from "./fake-ai.ts";
import {
  type FakeApi,
  fakeUser,
  fakeUsers,
  installFakeApi,
  memberAccess,
  PROJECT,
} from "./fake-api.ts";
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
    // The row links to the user's page in this environment; a plain click shows them beside it.
    const row = page
      .getByRole("region", { name: "Users, list" })
      .getByRole("link", { name: "user-1", exact: true });
    await expect.element(row).toHaveAttribute("href", `${USERS}/user-1?env=staging`);
    await row.click();
    await expect
      .poll(() => router.state.location.search)
      .toEqual({ env: "staging", user: "user-1" });
    expect(router.state.location.pathname).toBe(USERS);
  });

  test("shows a user's first seen beside the list, where the list no longer has it", async () => {
    installFakeApi({
      user: (userId, query) => {
        const answer = fakeUser("ada", query);
        return answer instanceof Response
          ? answer
          : {
              ...answer,
              user: { ...answer.user, userId, firstSeenAt: "2026-11-01T02:00:00.000Z" },
            };
      },
    });
    renderApp(`${USERS}?user=user-1`);
    const detail = page.getByRole("region", { name: "Users, selected" });
    const term = detail.getByText("First seen", { exact: true });
    await expect.element(term).toBeVisible();
    expect(term.element().nextElementSibling?.textContent).toBe("1 Nov 2026, 10:00");
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
    expect(items[1]?.textContent).toContain("Firefox, Linux; Munich, Germany; release 1.4.2");
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

  test("shows an event from the site's server without a page", async () => {
    installFakeApi({
      user: (userId, query) => {
        const found = fakeUser(userId, query);
        if (found instanceof Response) return found;
        const [first] = found.activity;
        if (first === undefined) return found;
        return {
          ...found,
          activity: [{ ...first, name: "invoice_paid", path: "" }],
          hasMore: false,
        };
      },
    });
    renderApp(`${USERS}/ada`);

    const item = page.getByRole("listitem").filter({ hasText: "invoice_paid" });
    await expect.element(item).toBeVisible();
    expect(item.element().textContent).not.toContain(" on ");
  });

  test("links an error to its page, with its type and message", async () => {
    installFakeApi({
      user: (userId, query) => {
        const found = fakeUser(userId, query);
        if (found instanceof Response) return found;
        const [first] = found.activity;
        if (first === undefined) return found;
        return {
          ...found,
          activity: [
            {
              ...first,
              // Today: the error's page opens on today.
              occurredAt: new Date().toISOString(),
              name: "error",
              path: "/checkout",
              error: {
                type: "TypeError",
                message: "Cannot read properties of undefined (reading 'id')",
                fingerprint: "1-0123456789abcdef0123",
              },
            },
          ],
          hasMore: false,
        };
      },
    });
    const router = renderApp(`${USERS}/ada?env=staging`);

    const link = page.getByRole("link", {
      name: "TypeError: Cannot read properties of undefined (reading 'id')",
    });
    await expect.element(link).toBeVisible();
    await expect
      .element(page.getByRole("listitem").filter({ hasText: "TypeError" }))
      .toMatchTextContent(/on \/checkout/);

    await link.click();

    await expect
      .poll(() => router.state.location.pathname)
      .toBe(`/projects/${PROJECT.id}/errors/1-0123456789abcdef0123`);
    expect(router.state.location.search).toEqual({ period: "today", env: "staging" });
  });

  test("links an error to the shortest period that still shows it", () => {
    const today = "2026-11-17";
    expect(rangeCovering("2026-11-17", today)).toEqual({ period: "today" });
    expect(rangeCovering("2026-11-11", today)).toEqual({ period: "7d" });
    expect(rangeCovering("2026-11-10", today)).toEqual({ period: "30d" });
    expect(rangeCovering("2026-08-20", today)).toEqual({ period: "90d" });
    expect(rangeCovering("2025-11-18", today)).toEqual({ period: "12m" });
    expect(rangeCovering("2025-06-01", today)).toEqual({ from: "2025-06-01", to: "2026-05-31" });
  });

  test("says when no event has the user ID", async () => {
    installFakeApi();
    renderApp(`${USERS}/${encodeURIComponent("nobody/else")}`);

    await expect.element(page.getByText("No events from this user")).toBeVisible();
    await expect.element(page.getByRole("link", { name: "See all users" })).toBeVisible();
  });
});

const UNVERIFIED = "User IDs on this project aren't verified, so any page could send any ID.";
/** The notice as the owner and admins see it, with its link. */
const UNVERIFIED_LINKED = `${UNVERIFIED} Require signed IDs`;
const notices = () => document.querySelectorAll('[role="note"]');

/** The fake API, with the project requiring signed user IDs. */
const signedOnly = () =>
  installFakeApi({
    users: (query) => ({ ...fakeUsers(query), signedUserIdsRequired: true }),
    user: (userId, query) => {
      const answer = fakeUser(userId, query);
      return answer instanceof Response ? answer : { ...answer, signedUserIdsRequired: true };
    },
  });

describe("the notice that user IDs are unverified", () => {
  test("shows on the list and links the owner to the setting", async () => {
    installFakeApi();
    const router = renderApp(USERS);

    await expect.element(page.getByRole("note")).toHaveTextContent(UNVERIFIED_LINKED);
    await page.getByRole("note").getByRole("link", { name: "Require signed IDs" }).click();
    await expect
      .poll(() => router.state.location.pathname)
      .toBe(`/projects/${PROJECT.id}/settings`);
    expect(router.state.location.search).toEqual({ tab: "server" });
  });

  test("shows a member no link, since they cannot change settings", async () => {
    installFakeApi({ access: memberAccess({ users: "view" }) });
    renderApp(USERS);

    await expect.element(page.getByRole("note")).toHaveTextContent(UNVERIFIED);
    expect(page.getByRole("note").getByRole("link").query()).toBeNull();
  });

  test("shows on a user's page", async () => {
    installFakeApi();
    renderApp(`${USERS}/ada`);
    await expect.element(page.getByRole("note")).toHaveTextContent(UNVERIFIED_LINKED);
  });

  test("shows once with a user chosen in the list", async () => {
    await page.viewport(1440, 900);
    installFakeApi({ user: (_userId, query) => fakeUser("ada", query) });
    renderApp(`${USERS}?user=user-1`);
    await expect
      .element(page.getByRole("region", { name: "Users, selected" }).getByText("First seen"))
      .toBeVisible();
    expect(notices()).toHaveLength(1);
  });

  test("shows while no user is known yet", async () => {
    installFakeApi({ users: (query) => ({ ...fakeUsers(query), users: [], hasMore: false }) });
    renderApp(USERS);

    await expect.element(page.getByText("No known users yet")).toBeVisible();
    await expect.element(page.getByRole("note")).toHaveTextContent(UNVERIFIED_LINKED);
  });

  test("is not shown while the project requires signed IDs", async () => {
    signedOnly();
    renderApp(USERS);
    await expect.poll(() => listedUsers().length).toBe(50);
    expect(notices()).toHaveLength(0);
  });

  test("is not shown on a user's page while the project requires signed IDs", async () => {
    signedOnly();
    renderApp(`${USERS}/ada`);
    await expect.element(page.getByRole("list", { name: /^Activity on/ }).first()).toBeVisible();
    expect(notices()).toHaveLength(0);
  });

  test.each([USERS, `${USERS}/ada`])("fits at 390 wide on %s", async (path) => {
    await page.viewport(390, 844);
    installFakeApi();
    renderApp(path);
    await expect.element(page.getByRole("note")).toBeVisible();
    await expect.element(page.getByRole("link", { name: "Require signed IDs" })).toBeVisible();
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
  });
});

/** The user page's requests to the AI report. */
const aiRequests = (api: FakeApi) =>
  api.requests.filter((request) => request.split("?")[0]?.endsWith(`/${PROJECT.id}/ai`));

const section = () => page.getByRole("region", { name: "AI in the last 30 days" });
/** The section's figures, each its label and value. */
const strip = () => document.querySelector('dl[aria-label="The user\'s AI usage"]');

describe("a user's AI usage", () => {
  test("their calls, estimated cost, tokens, failures, and latency, and what cost the most", async () => {
    const api = installFakeApi();
    renderApp(`${USERS}/ada?env=staging`);

    await expect.element(section()).toBeVisible();
    expect(new URLSearchParams(aiRequests(api).at(-1)?.split("?")[1])).toEqual(
      new URLSearchParams({ period: "30d", environment: "staging", user: "ada" }),
    );
    expect(
      [...(strip()?.querySelectorAll("[data-slot=stat]") ?? [])].map((stat) => [
        stat.querySelector("dt")?.textContent,
        stat.querySelector("dd")?.textContent,
      ]),
    ).toEqual([
      ["Calls", "310"],
      ["Estimated cost (USD)", "$1.71"],
      ["Input tokens", "410K"],
      ["Output tokens", "98K"],
      ["Failed", "1.9%"],
      ["95th percentile", "4.98 s"],
    ]);
    const names = (title: string) =>
      [
        ...section()
          .getByRole("region", { name: title })
          .element()
          .querySelectorAll("tbody tr td:first-child"),
      ].map((cell) => cell.textContent);
    expect(names("Models")).toEqual(["claude-sonnet-4-6", "gpt-5-mini", "acme-support-ft-2026-10"]);
    expect(names("Features")).toEqual(["support-chat", "summarize-ticket", "Unlabeled"]);
    await expect
      .element(
        section().getByText(
          "Cost is an estimate from token counts and model prices. 4 calls had no price and are not in it.",
        ),
      )
      .toBeVisible();
    await expect
      .element(section().getByRole("link", { name: "AI page" }))
      .toHaveAttribute("href", `/projects/${PROJECT.id}/ai?period=30d&env=staging`);
    // Their calls, one by one, on the calls list filtered to them.
    await expect
      .element(section().getByRole("link", { name: "AI calls" }))
      .toHaveAttribute("href", `/projects/${PROJECT.id}/ai/calls?period=30d&env=staging&user=ada`);
  });

  test("one line when they made no AI call in the period", async () => {
    installFakeApi({
      ai: {
        ...fakeAi(),
        report: (query, users) =>
          fakeAiReport(
            new URLSearchParams({ ...Object.fromEntries(query), user: "someone-else" }),
            users,
          ),
      },
    });
    renderApp(`${USERS}/ada`);

    await expect
      .element(section().getByText("No AI calls from this user in the last 30 days."))
      .toBeVisible();
    expect(strip()).toBeNull();
  });

  test("nothing for a project that has never had an AI call", async () => {
    const api = installFakeApi({ ai: { ...fakeAi(), report: noAiCalls } });
    renderApp(`${USERS}/ada`);

    await expect.element(page.getByRole("list", { name: /^Activity on/ }).first()).toBeVisible();
    await expect.poll(() => aiRequests(api).length).toBeGreaterThan(0);
    expect(section().query()).toBeNull();
    expect(document.querySelector("main")?.textContent).not.toMatch(/\bAI\b/);
  });

  test("nothing, and no request, without the AI area, even with monitoring", async () => {
    const api = installFakeApi({ access: memberAccess({ users: "view", monitoring: "view" }) });
    renderApp(`${USERS}/ada`);

    await expect.element(page.getByRole("list", { name: /^Activity on/ }).first()).toBeVisible();
    expect(section().query()).toBeNull();
    expect(aiRequests(api)).toEqual([]);
  });

  test("shows with the AI and Users areas, without monitoring", async () => {
    installFakeApi({ access: memberAccess({ users: "view", ai: "view" }) });
    renderApp(`${USERS}/ada`);

    await expect.element(section().getByRole("link", { name: "AI page" })).toBeVisible();
  });

  test("says when it could not load, and retries", async () => {
    let fail = true;
    installFakeApi({
      ai: {
        ...fakeAi(),
        report: (query, users) =>
          fail
            ? new Response(
                JSON.stringify({ error: "unavailable", message: "ClickHouse is not answering." }),
                {
                  status: 503,
                  headers: { "Content-Type": "application/json" },
                },
              )
            : fakeAiReport(query, users),
      },
    });
    renderApp(`${USERS}/ada`);

    await expect.element(section().getByText("The AI usage could not load")).toBeVisible();
    fail = false;
    await section().getByRole("button", { name: "Retry" }).click();
    await expect.element(section().getByText("$1.71")).toBeVisible();
  });

  test.each([
    [390, 844],
    [1440, 900],
  ])("fits at %i wide", async (width, height) => {
    await page.viewport(width, height);
    installFakeApi();
    renderApp(`${USERS}/ada`);
    await expect.element(section().getByText("$1.71")).toBeVisible();
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    for (const stat of strip()?.querySelectorAll("[data-slot=stat] dd") ?? []) {
      expect(stat.scrollWidth).toBeLessThanOrEqual(stat.clientWidth);
    }
  });

  test("fits beside the list at 1440 wide", async () => {
    await page.viewport(1440, 900);
    installFakeApi();
    renderApp(`${USERS}?user=ada`);
    const pane = page.getByRole("region", { name: "Users, selected" });
    await expect
      .element(pane.getByRole("region", { name: "AI in the last 30 days" }).getByText("$1.71"))
      .toBeVisible();
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(1440);
    for (const stat of strip()?.querySelectorAll("[data-slot=stat] dd") ?? []) {
      expect(stat.scrollWidth).toBeLessThanOrEqual(stat.clientWidth);
    }
  });
});
