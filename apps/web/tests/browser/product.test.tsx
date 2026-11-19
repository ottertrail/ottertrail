import { describe, expect, test } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser/context";

import {
  type FakeApi,
  fakeProductEvents,
  installFakeApi,
  json,
  PROJECT,
  productEventsFixture,
  retentionFixture,
} from "./fake-api.ts";
import { renderApp } from "./render.tsx";

const PRODUCT = `/projects/${PROJECT.id}/product`;
const EVENTS = `${PRODUCT}/events`;
const SIGNUP = `${EVENTS}/signup`;
const FUNNEL = `${PRODUCT}/funnel`;
const RETENTION = `${PRODUCT}/retention`;

/** The query of the latest request to a path ending in `path`. */
function lastQuery(api: FakeApi, path: string): Record<string, string> {
  const request = api.requests.findLast((item) => item.split("?")[0]?.endsWith(path)) ?? "";
  const at = request.indexOf("?");
  return at === -1 ? {} : Object.fromEntries(new URLSearchParams(request.slice(at + 1)));
}

/** Requests for a funnel's counts (not for the saved funnels). */
const funnelRequests = (api: FakeApi) =>
  api.requests.filter((request) => request.split("?")[0]?.endsWith("/funnel"));

/** The rows of a table, as their cells' text (header cells included). */
const tableRows = (name: string) =>
  [...page.getByRole("table", { name }).element().querySelectorAll("tbody tr")].map((row) =>
    [...row.querySelectorAll("th, td")].map((cell) => cell.textContent),
  );

/** A figure of the event's stats, by its label. */
function stat(label: string) {
  const item = [...document.querySelectorAll("dl > div")].find(
    (element) => element.querySelector("dt")?.textContent === label,
  );
  return item?.querySelector("dd")?.textContent;
}

const sidebarLink = () =>
  page.getByRole("navigation", { name: "Project" }).getByRole("link", {
    name: "Product analytics",
  });

const step = (number: number) => page.getByRole("group", { name: `Step ${number}` });

async function choose(combobox: string, option: string) {
  await page.getByRole("combobox", { name: combobox }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

describe("product events", () => {
  test("open from the sidebar, listed with their events, visitors, and users", async () => {
    const api = installFakeApi();
    const router = renderApp(`/projects/${PROJECT.id}/web-analytics`);

    await sidebarLink().click();

    await expect.poll(() => router.state.location.pathname).toBe(EVENTS);
    await expect
      .element(page.getByRole("table", { name: "Product events, most frequent first" }))
      .toBeVisible();
    expect(lastQuery(api, "/events")).toEqual({ period: "7d" });
    expect(tableRows("Product events, most frequent first")).toEqual([
      ["signup", "140", "127", "40"],
      ["purchase", "60", "50", "30"],
      ["invite_sent", "12", "0", "9"],
    ]);
    await expect.element(sidebarLink()).toHaveAttribute("data-active");
    await expect
      .element(
        page.getByRole("navigation", { name: "Product analytics reports" }).getByRole("link", {
          name: "Events",
        }),
      )
      .toHaveAttribute("aria-current", "page");
    await expect.element(page.getByText(/Visitors are daily visitor IDs/)).toBeVisible();
  });

  test("the product address alone opens the events, keeping the period", async () => {
    installFakeApi();
    const router = renderApp(`${PRODUCT}?period=30d`);

    await expect.poll(() => router.state.location.pathname).toBe(EVENTS);
    expect(router.state.location.search).toEqual({ period: "30d" });
  });

  test("the tabs keep the period and environment, and the sidebar stays active", async () => {
    const api = installFakeApi();
    const router = renderApp(`${EVENTS}?period=30d&env=staging`);
    const tabs = page.getByRole("navigation", { name: "Product analytics reports" });

    await tabs.getByRole("link", { name: "Retention" }).click();
    await expect.poll(() => router.state.location.pathname).toBe(RETENTION);
    expect(router.state.location.search).toEqual({ period: "30d", env: "staging" });
    await expect
      .poll(() => lastQuery(api, "/retention"))
      .toEqual({ period: "30d", environment: "staging" });
    await expect.element(sidebarLink()).toHaveAttribute("data-active");

    await tabs.getByRole("link", { name: "Funnel" }).click();
    await expect.poll(() => router.state.location.pathname).toBe(FUNNEL);
    expect(router.state.location.search).toEqual({ period: "30d", env: "staging" });
  });

  test("an event opens with its counts, its days, and its properties' values", async () => {
    const api = installFakeApi();
    const router = renderApp(`${EVENTS}?period=30d`);

    await page.getByRole("link", { name: "signup" }).click();

    await expect.poll(() => router.state.location.pathname).toBe(SIGNUP);
    expect(router.state.location.search).toEqual({ period: "30d" });
    await expect.element(page.getByRole("heading", { name: "signup", level: 2 })).toBeVisible();
    await expect.poll(() => stat("Events")).toBe("140");
    expect(lastQuery(api, "/events/signup")).toEqual({ period: "30d" });
    expect(stat("Visitors")).toBe("126");
    expect(stat("Users")).toBe("42");
    await expect.element(page.getByRole("slider", { name: "Events per day" })).toBeVisible();
    expect(tableRows("plan: its most frequent values")).toEqual([
      ["team", "80"],
      ["free", "60"],
    ]);
    expect(tableRows("seats: its most frequent values")).toEqual([
      ["3", "70"],
      ["5", "70"],
    ]);
    expect(tableRows("invited: its most frequent values")).toEqual([
      ["false", "105"],
      ["true", "35"],
    ]);
  });

  test("a value adds a filter to the address and the request; its chip removes it", async () => {
    const api = installFakeApi();
    const router = renderApp(SIGNUP);
    await expect.poll(() => stat("Events")).toBe("140");

    await page.getByRole("link", { name: "Filter by plan = team" }).click();

    await expect.poll(() => router.state.location.search).toEqual({ "p.plan": "team" });
    await expect
      .poll(() => lastQuery(api, "/events/signup"))
      .toEqual({
        period: "7d",
        "p.plan": "team",
      });
    await expect.poll(() => stat("Events")).toBe("80");
    // The filtered property lists its one value, which no longer filters.
    expect(tableRows("plan: its most frequent values")).toEqual([["team", "80"]]);
    await expect
      .element(page.getByRole("link", { name: "Filter by plan = free" }))
      .not.toBeInTheDocument();

    await page.getByRole("link", { name: "Filter by seats = 3" }).click();
    await expect
      .poll(() => router.state.location.search)
      .toEqual({ "p.plan": "team", "p.seats": "3" });
    await expect.poll(() => stat("Events")).toBe("40");

    await page.getByRole("button", { name: "Remove the filter plan = team" }).click();

    await expect.poll(() => router.state.location.search).toEqual({ "p.seats": "3" });
    await expect
      .poll(() => lastQuery(api, "/events/signup"))
      .toEqual({
        period: "7d",
        "p.seats": "3",
      });
    await expect.poll(() => stat("Events")).toBe("70");
  });

  test("reads filters from the address, a number as JSON writes it", async () => {
    const api = installFakeApi();
    renderApp(`${SIGNUP}?p.seats=3&p.invited=true`);

    await expect.poll(() => stat("Events")).toBe("35");
    expect(lastQuery(api, "/events/signup")).toEqual({
      period: "7d",
      "p.seats": "3",
      "p.invited": "true",
    });
    await expect
      .element(page.getByRole("button", { name: "Remove the filter seats = 3" }))
      .toBeVisible();
  });

  test("says so when no event matches the filters", async () => {
    installFakeApi();
    renderApp(`${SIGNUP}?p.plan=enterprise`);

    await expect
      .element(page.getByText("No signup event matches these filters in this period"))
      .toBeVisible();
    await expect
      .element(page.getByText("Remove a filter, or choose a longer period."))
      .toBeVisible();
  });

  test("explains how to send product events while there are none", async () => {
    installFakeApi({ productEvents: () => productEventsFixture({ events: [] }) });
    renderApp(EVENTS);

    await expect.element(page.getByText("No product events in this period")).toBeVisible();
    await expect
      .element(page.getByText('window.ottertrail?.track("signup", { plan: "team" });'))
      .toBeVisible();
    await expect.element(page.getByRole("button", { name: "Copy the example" })).toBeVisible();
    await expect.element(page.getByText("POST /api/server-events")).toBeVisible();
  });

  test("shows a failed load with a retry", async () => {
    let failing = true;
    installFakeApi({
      productEvents: (query) =>
        failing ? json({ message: "The database is down." }, 503) : fakeProductEvents(query),
    });
    renderApp(EVENTS);

    await expect.element(page.getByText("The events could not load")).toBeVisible();
    await expect.element(page.getByText("The database is down.")).toBeVisible();

    failing = false;
    await page.getByRole("button", { name: "Retry", exact: true }).click();

    await expect
      .element(page.getByRole("table", { name: "Product events, most frequent first" }))
      .toBeVisible();
    await expect.element(page.getByText("The events could not load")).not.toBeInTheDocument();
  });

  test("says when the project does not exist", async () => {
    installFakeApi({
      productEvents: () => json({ error: "not_found", message: "No project has this ID." }, 404),
    });
    renderApp(EVENTS);

    await expect.element(page.getByText("No such project")).toBeVisible();
  });
});

describe("the funnel", () => {
  test("starts with an example until two steps are shown", async () => {
    const api = installFakeApi();
    const router = renderApp(FUNNEL);

    await expect.element(page.getByText("Build a funnel")).toBeVisible();
    expect(funnelRequests(api)).toEqual([]);

    await page.getByRole("button", { name: "Use this example" }).click();

    await expect
      .poll(() => router.state.location.search)
      .toEqual({
        steps: [
          { type: "page", path: "/" },
          { type: "event", name: "signup" },
        ],
      });
    await expect
      .poll(() => lastQuery(api, "/funnel").steps)
      .toBe('[{"type":"page","path":"/"},{"type":"event","name":"signup"}]');
    // The editor shows the example's steps.
    await expect.element(step(1).getByRole("textbox", { name: "Path" })).toHaveValue("/");
    await expect
      .element(step(2).getByRole("combobox", { name: "Event name" }))
      .toHaveValue("signup");
  });

  test("the editor builds the steps: add, a filter, a page, reorder, remove", async () => {
    const api = installFakeApi();
    const router = renderApp(FUNNEL);
    await expect.element(step(2)).toBeVisible();

    await step(1).getByRole("combobox", { name: "Event name" }).fill("signup");
    await step(1).getByRole("button", { name: "Add a property filter" }).click();
    await step(1).getByRole("textbox", { name: "Property" }).fill("plan");
    await step(1).getByRole("textbox", { name: "Value" }).fill("team");
    await choose("Step 2 type", "Page");
    await step(2).getByRole("textbox", { name: "Path" }).fill("/pricing");
    await page.getByRole("button", { name: "Add a step" }).click();
    await step(3).getByRole("combobox", { name: "Event name" }).fill("purchase");
    await page.getByRole("button", { name: "Add a step" }).click();
    await step(4).getByRole("combobox", { name: "Event name" }).fill("invite_sent");

    // The page first, then the signup: move step 2 up.
    await page.getByRole("button", { name: "Move step 2 up" }).click();
    await expect.element(step(1).getByRole("textbox", { name: "Path" })).toHaveValue("/pricing");
    await page.getByRole("button", { name: "Remove step 4" }).click();
    await expect.element(step(4)).not.toBeInTheDocument();

    await page.getByRole("button", { name: "Show funnel" }).click();

    const steps = [
      { type: "page", path: "/pricing" },
      { type: "event", name: "signup", filter: { key: "plan", value: "team" } },
      { type: "event", name: "purchase" },
    ];
    await expect
      .poll(() => lastQuery(api, "/funnel"))
      .toEqual({
        period: "7d",
        steps: JSON.stringify(steps),
        count: "visitors",
        window: "86400",
      });
    expect(router.state.location.search).toEqual({ steps });
    // The address holds the JSON the API takes, as it is.
    expect(decodeURIComponent(router.state.location.searchStr)).toBe(
      `?steps=${JSON.stringify(steps)}`,
    );
  });

  test("says which steps are not complete instead of asking", async () => {
    const api = installFakeApi();
    renderApp(FUNNEL);
    await step(1).getByRole("combobox", { name: "Event name" }).fill("signup");

    await page.getByRole("button", { name: "Show funnel" }).click();

    await expect.element(page.getByRole("alert")).toMatchTextContent(/Some steps are incomplete/);
    await expect
      .element(step(2).getByRole("combobox", { name: "Event name" }))
      .toHaveAttribute("aria-invalid", "true");
    await expect.element(step(2).getByText("Name the event.")).toBeVisible();
    expect(funnelRequests(api)).toEqual([]);
  });

  test("catches two steps in a row that one event could both be, before asking", async () => {
    const api = installFakeApi();
    renderApp(FUNNEL);
    await step(1).getByRole("combobox", { name: "Event name" }).fill("signup");
    await step(2).getByRole("combobox", { name: "Event name" }).fill("signup");

    await page.getByRole("button", { name: "Show funnel" }).click();

    await expect
      .element(step(2).getByText(/One event could match both this step and the previous step/))
      .toBeVisible();
    expect(funnelRequests(api)).toEqual([]);
  });

  test("windows over a day need users; switching to users unlocks them", async () => {
    const api = installFakeApi();
    const steps = '[{"type":"event","name":"signup"},{"type":"event","name":"purchase"}]';
    const router = renderApp(`${FUNNEL}?steps=${encodeURIComponent(steps)}`);
    await expect.poll(() => lastQuery(api, "/funnel").count).toBe("visitors");
    await expect.element(page.getByText(/Windows longer than a day require Users/)).toBeVisible();

    await page.getByRole("combobox", { name: "Conversion window" }).click();
    await expect
      .element(page.getByRole("option", { name: "7 days" }))
      .toHaveAttribute("data-disabled");
    await expect
      .element(page.getByRole("option", { name: "1 hour" }))
      .not.toHaveAttribute("data-disabled");
    await userEvent.keyboard("{Escape}");

    await choose("Count by", "Users");
    await expect.poll(() => router.state.location.search).toMatchObject({ count: "users" });
    await choose("Conversion window", "7 days");

    await expect
      .poll(() => router.state.location.search)
      .toMatchObject({ count: "users", window: 604_800 });
    await expect
      .poll(() => lastQuery(api, "/funnel"))
      .toMatchObject({ count: "users", window: "604800" });

    // Back to visitors: the window shortens to a day, which they allow.
    await choose("Count by", "Visitors");
    await expect
      .poll(() => router.state.location.search)
      .toEqual({
        steps: JSON.parse(steps) as unknown,
      });
    // The first answer, still fresh in the cache.
    await expect
      .element(page.getByRole("combobox", { name: "Conversion window" }))
      .toMatchTextContent(/1 day/);
  });

  test("shows each step's people, its conversion from step 1 and the step before, and overall", async () => {
    installFakeApi();
    const steps = JSON.stringify([
      { type: "event", name: "signup", filter: { key: "plan", value: "team" } },
      { type: "page", path: "/pricing" },
      { type: "event", name: "purchase" },
    ]);
    renderApp(`${FUNNEL}?steps=${encodeURIComponent(steps)}&count=users&window=3600`);

    const table = "Funnel steps, with the users who reached each";
    await expect.element(page.getByRole("table", { name: table })).toBeVisible();
    expect(tableRows(table)).toEqual([
      ["1.Event signup where plan = team", "1,000", "100%", "–"],
      ["2.Page /pricing", "420", "42%", "42%"],
      ["3.Event purchase", "126", "13%", "30%"],
    ]);
    await expect
      .element(page.getByText("overall: 126 of 1,000 users who did step 1 went on to step 3."))
      .toBeVisible();
    await expect
      .element(page.getByText("10 to 16 Nov 2026, counted by users, within 1 hour of step 1"))
      .toBeVisible();
    await expect
      .element(page.getByRole("combobox", { name: "Count by" }))
      .toMatchTextContent(/Users/);
    await expect
      .element(page.getByRole("combobox", { name: "Conversion window" }))
      .toMatchTextContent(/1 hour/);
    // The definitions it counts by.
    await expect.element(page.getByText(/Other events between steps are allowed/)).toBeVisible();
    await expect.element(page.getByText(/Step 1 must occur in the selected period/)).toBeVisible();
    await expect.element(page.getByText(/Their IDs change daily/)).toBeVisible();
  });

  test("drops a window visitors cannot have from the address", async () => {
    const api = installFakeApi();
    const steps = '[{"type":"event","name":"signup"},{"type":"event","name":"purchase"}]';
    const router = renderApp(`${FUNNEL}?steps=${encodeURIComponent(steps)}&window=604800`);

    await expect.poll(() => lastQuery(api, "/funnel").window).toBe("86400");
    expect(router.state.location.search).not.toHaveProperty("window");
  });

  test("shows a failed load with a retry", async () => {
    installFakeApi({ funnel: () => json({ message: "The database is down." }, 503) });
    const steps = '[{"type":"event","name":"signup"},{"type":"event","name":"purchase"}]';
    renderApp(`${FUNNEL}?steps=${encodeURIComponent(steps)}`);

    await expect.element(page.getByText("The funnel could not load")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
  });
});

describe("retention", () => {
  test("shows each cohort's share per week, shaded, with the current week marked", async () => {
    const api = installFakeApi();
    renderApp(RETENTION);

    const table = "Weekly retention of signed-in users, by the week of their first event";
    await expect.element(page.getByRole("table", { name: table })).toBeVisible();
    expect(lastQuery(api, "/retention")).toEqual({ period: "7d" });
    const headings = [
      ...page.getByRole("table", { name: table }).element().querySelectorAll("thead th"),
    ].map((cell) => cell.textContent);
    expect(headings).toEqual(["First week", "Users", "Week 0", "Week 1", "Week 2", "Week 3"]);
    const notOver = "* (this week is not over)";
    expect(tableRows(table)).toEqual([
      ["26 Oct 2026", "40", "100%", "50%", "30%", `25%${notOver}`],
      ["2 Nov 2026", "25", "100%", "40%", `0%${notOver}`, "Not begun"],
      ["9 Nov 2026", "10", "100%", `40%${notOver}`, "Not begun", "Not begun"],
      ["16 Nov 2026", "8", `100%${notOver}`, "Not begun", "Not begun", "Not begun"],
    ]);

    const cells = [...document.querySelectorAll("tbody td")];
    const cell = (text: string) => cells.find((item) => item.textContent === text);
    expect(cell("50%")?.getAttribute("title")).toBe("20 of 40 users");
    expect(cell(`25%${notOver}`)?.getAttribute("title")).toBe(
      "10 of 40 users so far: this week is not over",
    );
    expect(document.querySelectorAll("td[data-current=true]")).toHaveLength(4);
    expect(cell(`25%${notOver}`)?.className).toMatch(/\bitalic\b/);
    // Shaded by share: 100% is the top step, 50% the third, 0% none.
    expect(cell("50%")?.className).toMatch(/\bbg-seq-3\b/);
    expect(cell(`0%${notOver}`)?.className).not.toMatch(/bg-seq/);
    await expect
      .element(
        page.getByText("This week is not over. Its share can still increase.", { exact: false }),
      )
      .toBeVisible();
    await expect.element(page.getByText(/Only signed-in users count/)).toBeVisible();
    await expect
      .element(page.getByText(/Weeks start on Monday/))
      .toMatchTextContent(/Asia\/Singapore/);
  });

  test("explains how to name signed-in users while there are no cohorts", async () => {
    installFakeApi({ retention: () => retentionFixture({ cohorts: [] }) });
    renderApp(RETENTION);

    await expect
      .element(page.getByText("No signed-in users first seen in this period"))
      .toBeVisible();
    await expect.element(page.getByText("data-user-id", { exact: true })).toBeVisible();
    await expect
      .element(page.getByText("window.ottertrail.identify(id)", { exact: true }))
      .toBeVisible();
  });

  test("shows a failed load, and an unknown project", async () => {
    installFakeApi({ retention: () => json({ message: "The database is down." }, 503) });
    renderApp(RETENTION);
    await expect.element(page.getByText("The retention report could not load")).toBeVisible();
  });

  test("says when the project does not exist", async () => {
    installFakeApi({
      retention: () => json({ error: "not_found", message: "No project has this ID." }, 404),
    });
    renderApp(RETENTION);
    await expect.element(page.getByText("No such project")).toBeVisible();
  });
});
