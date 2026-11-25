import { describe, expect, test } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser/context";

import {
  type FakeApi,
  fakeFunnel,
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

/**
 * The rows of a table, as their cells' text (header cells included). A
 * breakdown's bar cell has no text and is left out.
 */
const tableRows = (name: string) =>
  [...page.getByRole("table", { name }).element().querySelectorAll("tbody tr")].map((row) =>
    [...row.querySelectorAll("th, td")]
      .filter((cell) => cell.querySelector("[data-slot=breakdown-bar]") === null)
      .map((cell) => cell.textContent),
  );

/** A figure of the event's stats, by its label. */
function stat(label: string) {
  const item = [...document.querySelectorAll("dl > div")].find(
    (element) => element.querySelector("dt")?.textContent === label,
  );
  return item?.querySelector("dd")?.textContent;
}

/** A figure of the funnel's stats, by its label: its value, then its change, if any. */
function statParts(label: string) {
  const item = [...document.querySelectorAll("dl > div")].find(
    (element) => element.querySelector("dt")?.textContent === label,
  );
  return [...(item?.querySelectorAll("dd") ?? [])].map((dd) => dd.textContent);
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

const newFunnelDialog = () => page.getByRole("dialog", { name: "New funnel" });
const editDialog = () => page.getByRole("dialog", { name: "Edit the funnel's steps" });

/** Opens New funnel from the list, once it is there. */
async function newFunnel() {
  await page.getByRole("button", { name: "New funnel" }).click();
  await expect.element(newFunnelDialog()).toBeVisible();
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
    await expect.element(page.getByRole("heading", { name: "signup", level: 1 })).toBeVisible();
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

  test("an event's sources: its visit's source and campaign, with the page's filters", async () => {
    const api = installFakeApi();
    renderApp(`${SIGNUP}?p.plan=team`);

    const source = "Source: the most frequent values of the events' visits";
    await expect.element(page.getByRole("table", { name: source })).toBeVisible();
    expect(lastQuery(api, "/events/signup/sources")).toEqual({ period: "7d", "p.plan": "team" });
    // Named as the Analytics page names them; a server's events are Unknown.
    expect(tableRows(source)).toEqual([
      ["Direct / none", "52"],
      ["google.com", "41"],
      ["newsletter", "25"],
      ["news.ycombinator.com", "14"],
      ["Unknown", "8"],
    ]);
    expect(tableRows("Campaign: the most frequent values of the events' visits")).toEqual([
      ["No campaign", "107"],
      ["launch-week", "25"],
      ["Unknown", "8"],
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

    await expect.element(page.getByRole("heading", { name: "Project not found" })).toBeVisible();
  });
});

describe("the funnel", () => {
  test("without saved funnels, offers an example, shown at once", async () => {
    const api = installFakeApi({ savedFunnels: [] });
    const router = renderApp(FUNNEL);

    await expect.element(page.getByText("No funnels yet")).toBeVisible();
    await expect.element(page.getByText(/such as the page \/ then the event signup/)).toBeVisible();
    expect(funnelRequests(api)).toEqual([]);

    await page.getByRole("button", { name: "Try this example" }).click();

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
    await expect.element(page.getByRole("heading", { name: "Unsaved funnel" })).toBeVisible();
    await expect
      .element(page.getByText("/ → signup · Visitors, within 1 day", { exact: true }))
      .toBeVisible();
    // The editor shows the example's steps.
    await page.getByRole("button", { name: "Edit steps" }).click();
    await expect.element(step(1).getByRole("textbox", { name: "Path" })).toHaveValue("/");
    await expect
      .element(step(2).getByRole("combobox", { name: "Event name" }))
      .toHaveValue("signup");
  });

  test("the editor builds the steps: add, a filter, a page, reorder, remove", async () => {
    const api = installFakeApi();
    const router = renderApp(FUNNEL);
    await newFunnel();
    await expect.element(step(2)).toBeVisible();
    await expect
      .element(step(1).getByRole("combobox", { name: "Event name" }))
      .toHaveAttribute("placeholder", "For example, signup");

    await step(1).getByRole("combobox", { name: "Event name" }).fill("signup");
    await step(1).getByRole("button", { name: "Add a property filter" }).click();
    await expect
      .element(step(1).getByRole("textbox", { name: "Property" }))
      .toHaveAttribute("placeholder", "For example, plan");
    await expect
      .element(step(1).getByRole("textbox", { name: "Value" }))
      .toHaveAttribute("placeholder", "For example, team");
    await step(1).getByRole("textbox", { name: "Property" }).fill("plan");
    await step(1).getByRole("textbox", { name: "Value" }).fill("team");
    await choose("Step 2 type", "Page");
    await expect
      .element(step(2).getByRole("textbox", { name: "Path" }))
      .toHaveAttribute("placeholder", "For example, /pricing or /docs/*");
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

    await expect.element(newFunnelDialog()).not.toBeInTheDocument();
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
    const router = renderApp(FUNNEL);
    await newFunnel();
    await step(1).getByRole("combobox", { name: "Event name" }).fill("signup");

    await page.getByRole("button", { name: "Show funnel" }).click();

    // The dialog stays open, with the steps to correct.
    await expect
      .element(newFunnelDialog().getByRole("alert"))
      .toMatchTextContent(/Some steps are incomplete/);
    await expect
      .element(step(2).getByRole("combobox", { name: "Event name" }))
      .toHaveAttribute("aria-invalid", "true");
    await expect.element(step(2).getByText("Name the event.")).toBeVisible();
    expect(funnelRequests(api)).toEqual([]);
    expect(router.state.location.search).toEqual({});
  });

  test("catches two steps in a row that one event could both be, before asking", async () => {
    const api = installFakeApi();
    renderApp(FUNNEL);
    await newFunnel();
    await step(1).getByRole("combobox", { name: "Event name" }).fill("signup");
    await step(2).getByRole("combobox", { name: "Event name" }).fill("signup");

    await page.getByRole("button", { name: "Show funnel" }).click();

    await expect
      .element(step(2).getByText(/One event could count for both this step and the previous one/))
      .toBeVisible();
    await expect.element(newFunnelDialog()).toBeVisible();
    expect(funnelRequests(api)).toEqual([]);
  });

  test("windows over a day need users; switching to users unlocks them", async () => {
    const api = installFakeApi();
    const steps = '[{"type":"event","name":"signup"},{"type":"event","name":"purchase"}]';
    const router = renderApp(`${FUNNEL}?steps=${encodeURIComponent(steps)}`);
    await expect.poll(() => lastQuery(api, "/funnel").count).toBe("visitors");
    await page.getByRole("button", { name: "Edit steps" }).click();
    await expect
      .element(editDialog().getByText(/Windows longer than a day need Users/))
      .toBeVisible();

    await page.getByRole("combobox", { name: "Conversion window" }).click();
    await expect
      .element(page.getByRole("option", { name: "7 days" }))
      .toHaveAttribute("data-disabled");
    await expect
      .element(page.getByRole("option", { name: "1 hour" }))
      .not.toHaveAttribute("data-disabled");
    await userEvent.keyboard("{Escape}");
    await expect.element(editDialog()).toBeVisible();

    await choose("Count by", "Users");
    await choose("Conversion window", "7 days");
    // Nothing applies until Show funnel.
    expect(router.state.location.search).toEqual({ steps: JSON.parse(steps) as unknown });
    await page.getByRole("button", { name: "Show funnel" }).click();

    await expect
      .poll(() => router.state.location.search)
      .toMatchObject({ count: "users", window: 604_800 });
    await expect
      .poll(() => lastQuery(api, "/funnel"))
      .toMatchObject({ count: "users", window: "604800" });
    await expect
      .element(page.getByText("signup → purchase · Users, within 7 days", { exact: true }))
      .toBeVisible();

    // Back to visitors: the window shortens to a day, which they allow.
    await page.getByRole("button", { name: "Edit steps" }).click();
    await choose("Count by", "Visitors");
    await expect
      .element(page.getByRole("combobox", { name: "Conversion window" }))
      .toMatchTextContent(/1 day/);
    await page.getByRole("button", { name: "Show funnel" }).click();
    await expect
      .poll(() => router.state.location.search)
      .toEqual({
        steps: JSON.parse(steps) as unknown,
      });
    await expect
      .element(page.getByText("signup → purchase · Visitors, within 1 day", { exact: true }))
      .toBeVisible();
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
    // Each count with its change from the period before (800, 400, 100), and,
    // counted by users, who stopped there or converted; the median time from
    // the step before arrives in its own request.
    await expect
      .poll(() => tableRows(table))
      .toEqual([
        [
          "1.Event signup where plan = team",
          "1,00025%Up 25% from 800",
          "100%",
          "–",
          "–",
          "580 dropped off",
        ],
        [
          "2.Page /pricing",
          "4205%Up 5% from 400",
          "42%",
          "42%",
          "4 minp75 15 min",
          "294 dropped off",
        ],
        [
          "3.Event purchase",
          "12626%Up 26% from 100",
          "13%",
          "30%",
          "2 h 10 minp75 1 day 2 h",
          "126 converted",
        ],
      ]);
    await expect
      .element(
        page.getByText("126 of 1,000 users who did step 1 went on to step 3.", { exact: true }),
      )
      .toBeVisible();
    await expect
      .element(page.getByText("10 to 16 Nov 2026, counted by users, within 1 hour of step 1"))
      .toBeVisible();
    await expect
      .element(
        page.getByText("signup where plan = team → /pricing → purchase · Users, within 1 hour", {
          exact: true,
        }),
      )
      .toBeVisible();
    // The definitions it counts by, folded away until asked for.
    const notes = page.getByText("How the funnel counts", { exact: true });
    await expect
      .element(page.getByText(/Other events between steps are allowed/))
      .not.toBeVisible();
    await notes.click();
    await expect.element(page.getByText(/Other events between steps are allowed/)).toBeVisible();
    await expect.element(page.getByText(/Step 1 must occur in the selected period/)).toBeVisible();
    await expect.element(page.getByText(/Their IDs change daily/)).toBeVisible();
  });

  test("compares the conversion and the counts with the period before", async () => {
    installFakeApi();
    const steps = '[{"type":"event","name":"signup"},{"type":"event","name":"purchase"}]';
    renderApp(`${FUNNEL}?steps=${encodeURIComponent(steps)}`);

    await expect.element(page.getByText(/Changes compare with 3 to 9 Nov 2026\./)).toBeVisible();
    // 42% now, 50% before: a share changes in points.
    expect(statParts("Overall conversion")).toEqual(["42%", "8 ptsDown 8 points from 50%"]);
    expect(statParts("Visitors at step 1")).toEqual(["1,000", "25%Up 25% from 800"]);
    expect(statParts("Visitors at step 2")).toEqual(["420", "5%Up 5% from 400"]);
  });

  test("says when the period before has no one to compare with", async () => {
    installFakeApi({
      funnel: (query) => {
        const funnel = fakeFunnel(query);
        if (funnel instanceof Response || funnel.previous === undefined) return funnel;
        return { ...funnel, previous: { ...funnel.previous, reached: [0, 0] } };
      },
    });
    const steps = '[{"type":"event","name":"signup"},{"type":"event","name":"purchase"}]';
    renderApp(`${FUNNEL}?steps=${encodeURIComponent(steps)}`);

    await expect
      .element(page.getByText(/No visitors did step 1 in 3 to 9 Nov 2026 to compare with\./))
      .toBeVisible();
    // No percentage from nothing: "New", as the other comparisons say it.
    for (const label of ["Overall conversion", "Visitors at step 1", "Visitors at step 2"]) {
      expect(statParts(label)[1]).toBe("NewNew: none in the period before");
    }
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

/** A cohort's cell in the retention table, by its text. */
const cohortCell = (text: string) =>
  [...document.querySelectorAll("tbody tr:not([data-average]) td")].find(
    (item) => item.textContent === text,
  );

describe("retention", () => {
  const TABLE = "Weekly retention of signed-in users, by the week of their first event";
  const NOT_OVER = "* (this week is not over)";
  /** As tableRows, with a row's name as shown: the short or the full date, not both. */
  const retentionRows = () =>
    [...page.getByRole("table", { name: TABLE }).element().querySelectorAll("tbody tr")].map(
      (row) =>
        [...row.querySelectorAll<HTMLElement>("th, td")].map((cell) =>
          cell.tagName === "TH" ? cell.innerText : cell.textContent,
        ),
    );

  test("shows the average, then each cohort's share per week, shaded, with the current week marked", async () => {
    installFakeApi();
    renderApp(RETENTION);

    await expect.element(page.getByRole("table", { name: TABLE })).toBeVisible();
    const headings = [
      ...page.getByRole("table", { name: TABLE }).element().querySelectorAll("thead th"),
    ].map((cell) => cell.textContent);
    expect(headings).toEqual(["First week", "Users", "Week 0", "Week 1", "Week 2", "Week 3"]);
    expect(retentionRows()).toEqual([
      // Pooled over the cohorts that finished each week: 30 of 65, 12 of 40.
      ["Average", "83", "100%", "46%", "30%", "–No cohort has finished this week"],
      ["26 Oct 2026", "40", "100%", "50%", "30%", `25%${NOT_OVER}`],
      ["2 Nov 2026", "25", "100%", "40%", `0%${NOT_OVER}`, "Not begun"],
      ["9 Nov 2026", "10", "100%", `40%${NOT_OVER}`, "Not begun", "Not begun"],
      ["16 Nov 2026", "8", `100%${NOT_OVER}`, "Not begun", "Not begun", "Not begun"],
    ]);

    const average = [...document.querySelectorAll("tr[data-average] td")];
    expect(average[2]?.getAttribute("title")).toBe(
      "30 of 65 users, in the cohorts that finished this week",
    );
    expect(cohortCell("50%")?.getAttribute("title")).toBe("20 of 40 users");
    expect(cohortCell(`25%${NOT_OVER}`)?.getAttribute("title")).toBe(
      "10 of 40 users so far: this week is not over",
    );
    expect(document.querySelectorAll("td[data-current=true]")).toHaveLength(4);
    expect(cohortCell(`25%${NOT_OVER}`)?.className).toMatch(/\bitalic\b/);
    // Fixed steps: 45% and up the top one, 30 to 44% the sixth, 20 to 29% the fifth.
    expect(cohortCell("50%")?.className).toMatch(/\bbg-seq-7\b/);
    expect(cohortCell("50%")?.className).toMatch(/\btext-on-seq-7\b/);
    expect(cohortCell("40%")?.className).toMatch(/\bbg-seq-6\b/);
    expect(cohortCell(`25%${NOT_OVER}`)?.className).toMatch(/\bbg-seq-5\b/);
    expect(average[2]?.className).toMatch(/\bbg-seq-7\b/);
    // Week 0 is everyone: never shaded. Nor is 0%.
    for (const cell of document.querySelectorAll("tbody tr > td:nth-of-type(2)")) {
      expect(cell.className).not.toMatch(/bg-seq/);
    }
    expect(cohortCell(`0%${NOT_OVER}`)?.className).not.toMatch(/bg-seq/);
    await expect
      .element(
        page.getByText(
          "This week is not over. Its share can still increase, and the average leaves it out.",
          { exact: false },
        ),
      )
      .toBeVisible();

    const legend = page.getByRole("list", { name: "Share of the cohort:" });
    expect(
      legend
        .getByRole("listitem")
        .elements()
        .map((item) => item.textContent),
    ).toEqual([
      "0%",
      "1%1 to 4%",
      "5%5 to 9%",
      "10%10 to 14%",
      "15%15 to 19%",
      "20%20 to 29%",
      "30%30 to 44%",
      "45%45% or more",
    ]);
  });

  test("the notes are collapsed, and open on request", async () => {
    installFakeApi();
    renderApp(RETENTION);

    const summary = page.getByText("How retention counts");
    await expect.element(summary).toBeVisible();
    await expect.element(page.getByText(/Only signed-in users count/)).not.toBeVisible();
    await summary.click();
    await expect.element(page.getByText(/Only signed-in users count/)).toBeVisible();
    await expect.element(page.getByText(/The average adds up the cohorts/)).toBeVisible();
    await expect
      .element(page.getByText(/Weeks start on Monday/))
      .toMatchTextContent(/Asia\/Singapore/);
  });

  test("opens on the last 90 days, and offers no period shorter than 4 weeks", async () => {
    const api = installFakeApi();
    const router = renderApp(`${RETENTION}?period=7d`);

    const period = page.getByRole("combobox", { name: "Period" });
    await expect.element(period).toMatchTextContent(/^Last 90 days/);
    expect(lastQuery(api, "/retention")).toEqual({ period: "90d" });
    await period.click();
    await expect
      .poll(() =>
        page
          .getByRole("option")
          .elements()
          .map((option) => option.textContent),
      )
      .toEqual(["Last 30 days", "Last 90 days", "Last 12 months", "Custom range…"]);
    await page.getByRole("option", { name: "Last 30 days" }).click();
    await expect.poll(() => router.state.location.search).toEqual({ period: "30d" });
    await expect.poll(() => lastQuery(api, "/retention")).toEqual({ period: "30d" });
    await expect.element(period).toMatchTextContent(/^Last 30 days/);
  });

  test("on a phone: short dates, and weeks 1 and 2 in view without scrolling", async () => {
    await page.viewport(390, 844);
    installFakeApi();
    renderApp(RETENTION);

    await expect.element(page.getByRole("table", { name: TABLE })).toBeVisible();
    expect(retentionRows().map((row) => row[0])).toEqual([
      "Average",
      "26 Oct",
      "2 Nov",
      "9 Nov",
      "16 Nov",
    ]);
    const table = page.getByRole("table", { name: TABLE }).element();
    const scroller = table.closest("[data-slot=table-container]");
    if (scroller === null) throw new Error("The table has no scroller");
    expect(scroller.scrollLeft).toBe(0);
    const right = scroller.getBoundingClientRect().right;
    const week2 = [...table.querySelectorAll("thead th")].find(
      (cell) => cell.textContent === "Week 2",
    );
    expect(week2?.getBoundingClientRect().right).toBeLessThanOrEqual(right);
    expect(right).toBeLessThanOrEqual(390);
  });

  test("explains how to name signed-in users when the project has none", async () => {
    installFakeApi({
      retention: () => retentionFixture({ cohorts: [], average: [], identifiesUsers: false }),
    });
    renderApp(RETENTION);

    await expect.element(page.getByText("No signed-in users yet")).toBeVisible();
    await expect.element(page.getByText("data-user-id", { exact: true })).toBeVisible();
    await expect
      .element(page.getByText("window.ottertrail.identify(id)", { exact: true }))
      .toBeVisible();
    await expect
      .element(page.getByRole("link", { name: /How to name signed-in users/ }))
      .toHaveAttribute("href", "https://docs.ottertrail.app/users/naming-users/");
    expect(page.getByText("How retention counts").elements()).toHaveLength(0);
  });

  test("an empty period says so, and offers the last 12 months", async () => {
    const api = installFakeApi({
      retention: (query) =>
        query.get("period") === "12m"
          ? retentionFixture()
          : retentionFixture({ cohorts: [], average: [], identifiesUsers: true }),
    });
    const router = renderApp(RETENTION);

    await expect.element(page.getByText("No new signed-in users in this period")).toBeVisible();
    await expect
      .element(page.getByText("No signed-in user was first seen from 10 to 16 Nov 2026."))
      .toBeVisible();
    expect(page.getByText("data-user-id", { exact: true }).elements()).toHaveLength(0);
    expect(page.getByText("How retention counts").elements()).toHaveLength(0);

    await page.getByRole("button", { name: "Show the last 12 months" }).click();
    await expect.poll(() => router.state.location.search).toEqual({ period: "12m" });
    await expect.poll(() => lastQuery(api, "/retention")).toEqual({ period: "12m" });
    await expect.element(page.getByRole("table", { name: TABLE })).toBeVisible();
  });

  test("an empty longest period offers nothing longer", async () => {
    installFakeApi({
      retention: () => retentionFixture({ cohorts: [], average: [], identifiesUsers: true }),
    });
    renderApp(`${RETENTION}?period=12m&env=staging`);

    await expect
      .element(page.getByText(/No signed-in user was first seen in staging from/))
      .toBeVisible();
    expect(page.getByRole("button", { name: "Show the last 12 months" }).elements()).toHaveLength(
      0,
    );
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
    await expect.element(page.getByRole("heading", { name: "Project not found" })).toBeVisible();
  });
});
