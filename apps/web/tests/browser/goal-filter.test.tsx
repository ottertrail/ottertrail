import { afterEach, describe, expect, test } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser/context";

import {
  analyticsFixture,
  type FakeApi,
  fakeGoals,
  installFakeApi,
  PROJECT,
  withGoal,
} from "./fake-api.ts";
import { renderApp } from "./render.tsx";

/*
 * The goal filter of Web analytics (docs/web-analytics.md, "The goal
 * filter"): a goal adds converted visitors to every list without
 * narrowing the visits. The API's numbers are tested in
 * apps/api/tests/goal-filter.test.ts.
 */

const ANALYTICS = `/projects/${PROJECT.id}/web-analytics`;
const [SAW_PRICING, TEAM_SIGNUP] = fakeGoals();

afterEach(async () => {
  await page.viewport(1280, 900);
});

function lastQuery(api: FakeApi, path = "/analytics"): Record<string, string> {
  const request = api.requests.findLast((item) => item.split("?")[0]?.endsWith(path)) ?? "";
  return Object.fromEntries(new URLSearchParams(request.slice(request.indexOf("?") + 1)));
}

const addressQuery = (router: ReturnType<typeof renderApp>) => router.state.location.search;

function chips(): string[] {
  const list = document.querySelector("ul[aria-label=Filters]");
  return [...(list?.querySelectorAll("li") ?? [])].map((item) => item.textContent);
}

function stat(label: string) {
  const item = [...document.querySelectorAll("dl > div")].find(
    (element) => element.querySelector("dt")?.textContent === label,
  );
  return item?.querySelector("dd")?.firstChild?.textContent;
}

const statLabels = () =>
  [...document.querySelectorAll("section[aria-label=Summary] dt")].map((term) => term.textContent);

/** A list's rows: each cell's text without its phone label, the bar left out. */
const listRows = (name: string) =>
  [...page.getByRole("table", { name }).element().querySelectorAll("tbody tr")].map((row) =>
    [...row.querySelectorAll("td")]
      .filter((cell) => cell.querySelector("[data-slot=breakdown-bar]") === null)
      .map((cell) =>
        [...cell.childNodes]
          .filter(
            (node) => !(node instanceof Element && node.matches("[data-slot=breakdown-label]")),
          )
          .map((node) => node.textContent)
          .join(""),
      ),
  );

const headings = (name: string) =>
  [...page.getByRole("table", { name }).element().querySelectorAll("thead th")].map(
    (cell) => cell.textContent,
  );

describe("the goal filter", () => {
  test("a Goals row sets the goal: a chip, four figures, and conversions in every list", async () => {
    const api = installFakeApi();
    const router = renderApp(ANALYTICS);

    await page.getByRole("link", { name: "Filter by Goal: Team signup" }).click();

    await expect.poll(() => addressQuery(router)).toEqual({ goal: TEAM_SIGNUP?.id });
    await expect.poll(() => lastQuery(api)).toEqual({ period: "7d", goal: TEAM_SIGNUP?.id });
    await expect.poll(chips).toEqual(["Goal: Team signup"]);
    await expect.poll(statLabels).toEqual(["Visitors", "Converted", "Conversion rate", "Events"]);
    // The visits stay as they are; the goal adds its conversions.
    expect([stat("Visitors"), stat("Converted"), stat("Conversion rate"), stat("Events")]).toEqual([
      "765",
      "40",
      "5.2%",
      "44",
    ]);
    await expect.element(page.getByText(/your server's events have no visitor/i)).toBeVisible();

    for (const name of [
      "Top pages, most converted first",
      "Sources, most converted first",
      "Countries, most converted first",
      "Devices, most converted first",
      "Releases, most converted first",
    ]) {
      expect(headings(name).slice(-3)).toEqual(["Visitors", "Converted", "Rate"]);
    }
    const sources = listRows("Sources, most converted first");
    // Most converted first, each with its rate.
    const converted = sources.map((row) => Number(row[2]));
    expect(converted).toEqual(converted.toSorted((a, b) => b - a));
    for (const [, visitors, count, rate] of sources) {
      const share = (Number(count) / Number(visitors)) * 100;
      expect(rate).toBe(share < 10 ? `${share.toFixed(1)}%` : `${Math.round(share)}%`);
    }
    // Custom events keep their own figures.
    expect(headings("Custom events, most visitors first").slice(-2)).toEqual([
      "Visitors",
      "Events",
    ]);
    // The Goals table marks it.
    const goals = page.getByRole("table", { name: "Goals, in the order added" });
    await expect.element(goals.getByText("Selected")).toBeVisible();
    expect(goals.getByText("Selected").elements()).toHaveLength(1);
  });

  test("the chart shows converted visitors per day while a goal is set", async () => {
    installFakeApi();
    renderApp(`${ANALYTICS}?goal=${SAW_PRICING?.id}`);

    await expect.element(page.getByRole("heading", { name: "Converted per day" })).toBeVisible();
    await expect
      .element(page.getByRole("tab", { name: "Converted" }))
      .toHaveAttribute("aria-selected", "true");
    await page.getByRole("tab", { name: "Visits" }).click();
    await expect.element(page.getByRole("heading", { name: "Visits per day" })).toBeVisible();
  });

  test("a Custom events row makes the event the goal, and links to its page", async () => {
    const api = installFakeApi();
    const router = renderApp(`${ANALYTICS}?country=DE`);

    await page.getByRole("link", { name: "Filter by Goal: signup" }).click();

    // It stacks with the other filters.
    await expect.poll(() => addressQuery(router)).toEqual({ country: "DE", goalEvent: "signup" });
    await expect
      .poll(() => lastQuery(api))
      .toEqual({ period: "7d", country: "DE", goalEvent: "signup" });
    await expect.poll(chips).toEqual(["Goal: signup", "Country: Germany"]);
    const events = page.getByRole("table", { name: "Custom events, most visitors first" });
    await expect.element(events.getByText("Goal", { exact: true })).toBeVisible();

    await page.getByRole("link", { name: "Open the signup event" }).click();
    await expect
      .poll(() => router.state.location.pathname)
      .toBe(`/projects/${PROJECT.id}/product/events/signup`);
  });

  test("its chip removes it and keeps the other filters; Clear filters removes all", async () => {
    installFakeApi();
    const router = renderApp(`${ANALYTICS}?country=DE&goal=${TEAM_SIGNUP?.id}`);

    await expect.poll(chips).toEqual(["Goal: Team signup", "Country: Germany"]);
    await page.getByRole("link", { name: "Remove the filter Goal: Team signup" }).click();
    await expect.poll(() => addressQuery(router)).toEqual({ country: "DE" });
    await expect.poll(statLabels).toContain("Bounce rate");

    await page.getByRole("link", { name: "Filter by Goal: Team signup" }).click();
    await expect.poll(chips).toEqual(["Goal: Team signup", "Country: Germany"]);
    await page.getByRole("link", { name: "Clear filters" }).click();
    await expect.poll(() => addressQuery(router)).toEqual({});
  });

  test("the Goal picker lists the saved goals and the period's custom events", async () => {
    const api = installFakeApi();
    const router = renderApp(ANALYTICS);

    await page.getByRole("combobox", { name: "Goal" }).click();
    const options = page
      .getByRole("option")
      .elements()
      .map((item) => item.textContent);
    expect(options).toEqual(["No goal", "Saw pricing", "Team signup", "signup"]);
    await page.getByRole("option", { name: "Saw pricing" }).click();

    await expect.poll(() => addressQuery(router)).toEqual({ goal: SAW_PRICING?.id });
    await expect.poll(() => lastQuery(api)).toEqual({ period: "7d", goal: SAW_PRICING?.id });
    await expect.poll(chips).toEqual(["Goal: Saw pricing"]);

    await page.getByRole("combobox", { name: "Goal" }).click();
    await page.getByRole("option", { name: "No goal" }).click();
    await expect.poll(() => addressQuery(router)).toEqual({});
  });

  test("a deleted goal in a link says so, with a way to remove it", async () => {
    installFakeApi();
    const router = renderApp(`${ANALYTICS}?goal=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa9`);

    await expect.element(page.getByText(/This goal does not exist/)).toBeVisible();
    await page.getByRole("link", { name: "Remove the goal" }).click();
    await expect.poll(() => addressQuery(router)).toEqual({});
    await expect.poll(statLabels).toContain("Visits");
  });

  test("an address value the API would refuse is no goal", async () => {
    const api = installFakeApi();
    renderApp(`${ANALYTICS}?goal=signup&goalEvent=pageview`);

    await expect.poll(statLabels).toContain("Bounce rate");
    expect(lastQuery(api)).toEqual({ period: "7d" });
    expect(chips()).toEqual([]);
  });

  test("Show all keeps the goal and shows the three figures", async () => {
    // Ten sources: a full list, which may have more.
    const fixture = analyticsFixture();
    const sources = Array.from({ length: 10 }, (_, i) => ({
      value: `source-${i + 1}`,
      visitors: 300 - i,
      visits: 310 - i,
      bounceRate: 0.4,
    }));
    const api = installFakeApi({
      analytics: (_projectId, _period, query, fake) =>
        withGoal(
          { ...fixture, breakdowns: { ...fixture.breakdowns, source: sources } },
          query,
          fake.goals,
        ),
    });
    renderApp(`${ANALYTICS}?goal=${TEAM_SIGNUP?.id}`);

    await page.getByRole("button", { name: "Show all sources" }).click();
    const dialog = page.getByRole("dialog");
    await expect.element(dialog.getByRole("table")).toBeVisible();
    expect(lastQuery(api, "/analytics/list")).toMatchObject({
      report: "source",
      goal: TEAM_SIGNUP?.id,
    });
    expect(
      [...dialog.element().querySelectorAll("thead th")].map((cell) => cell.textContent),
    ).toEqual(["Source", "Visitors", "Converted", "Rate"]);
    const [first] = dialog.element().querySelectorAll("tbody tr");
    expect(
      [...(first?.querySelectorAll("td") ?? [])].slice(1).map((cell) => cell.textContent),
    ).toEqual(["500", "50", "10%"]);
    await userEvent.keyboard("{Escape}");
  });

  test("at 1440 wide, a row's Visitors, Converted, and Rate sit beside its name", async () => {
    const { figures, labels } = await firstCountry(1440);
    expect(figures).toHaveLength(4);
    const tops = figures.map((cell) => Math.round(cell.getBoundingClientRect().top));
    expect(new Set(tops).size).toBe(1);
    expect(labels.map((label) => getComputedStyle(label).display)).toEqual([
      "none",
      "none",
      "none",
    ]);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(1440);
  });

  test("at 390 wide, a row stacks Visitors, Converted, and Rate on lines of their own", async () => {
    const { figures, labels } = await firstCountry(390);
    expect(figures).toHaveLength(4);
    expect(labels.map((label) => label.textContent)).toEqual(["Visitors", "Converted", "Rate"]);
    expect(labels.map((label) => getComputedStyle(label).display)).not.toContain("none");
    const tops = figures.slice(1).map((cell) => cell.getBoundingClientRect().top);
    expect(new Set(tops).size).toBe(3);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
  });
});

/** The first Countries row with a goal at `width`: its name and figure cells, and their labels. */
async function firstCountry(width: number) {
  await page.viewport(width, 900);
  installFakeApi();
  renderApp(`${ANALYTICS}?goal=${TEAM_SIGNUP?.id}`);
  const countries = page.getByRole("table", { name: "Countries, most converted first" });
  await expect.element(countries).toBeVisible();
  await expect.poll(chips).toEqual(["Goal: Team signup"]);
  const [row] = countries.element().querySelectorAll("tbody tr");
  if (row === undefined) throw new Error("No country row");
  return {
    // The name, then the three figures; the bar's cell is left out.
    figures: [...row.querySelectorAll("td")].filter(
      (cell) => cell.querySelector("[data-slot=breakdown-bar]") === null,
    ),
    labels: [...row.querySelectorAll("[data-slot=breakdown-label]")],
  };
}
