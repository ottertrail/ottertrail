import { describe, expect, test } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser/context";

import type { Analytics } from "../../src/lib/analytics-api.ts";
import {
  analyticsFixture,
  deferred,
  emptyAnalytics,
  installFakeApi,
  json,
  PROJECT,
} from "./fake-api.ts";
import { currentPath, renderApp } from "./render.tsx";

const ANALYTICS = `/projects/${PROJECT.id}/web-analytics`;

/** The figure under a summary label, such as "24%" under "Bounce rate". */
function summaryValue(label: string): string | null | undefined {
  const term = [...document.querySelectorAll("dt")].find((dt) => dt.textContent === label);
  return term?.nextElementSibling?.textContent;
}

/** Each body row of a table as its cells' text, such as ["Germany", "155", "160"]. */
function tableRows(caption: string): string[][] {
  const table = [...document.querySelectorAll("table")].find(
    (item) => item.caption?.textContent === caption,
  );
  return [...(table?.tBodies[0]?.rows ?? [])].map((row) =>
    [...row.cells].map((cell) => cell.textContent ?? ""),
  );
}

const analyticsRequests = (api: { requests: string[] }) =>
  api.requests.filter((path) => path.includes("/analytics"));

describe("the analytics page", () => {
  test("shows the period's numbers, days, and lists", async () => {
    const api = installFakeApi();
    renderApp(ANALYTICS);

    await expect.element(page.getByRole("heading", { name: "Visitors per day" })).toBeVisible();
    expect(analyticsRequests(api)).toEqual([`/api/projects/${PROJECT.id}/analytics?period=7d`]);
    await expect.element(page.getByText("10–16 Nov 2026 · Asia/Singapore")).toBeVisible();
    await expect
      .element(page.getByRole("combobox", { name: "Period" }))
      .toMatchTextContent(/^Last 7 days/);

    expect(summaryValue("Visitors")).toBe("765");
    expect(summaryValue("Pageviews")).toBe("1,820");
    expect(summaryValue("Views per visit")).toBe("2.2");
    expect(summaryValue("Bounce rate")).toBe("24%");
    expect(summaryValue("Visit duration")).toBe("4m 23s");
    expect(summaryValue("Time engaged")).toBe("1m 50s");

    expect(tableRows("Top pages, most visitors first")).toEqual([
      ["/", "322", "420"],
      ["/pricing", "201", "260"],
    ]);
    // Country codes become names, and a missing value is a row of its own.
    expect(tableRows("Countries, most visitors first")).toEqual([
      ["Germany", "155", "160"],
      ["Unknown", "125", "130"],
      ["Singapore", "90", "95"],
    ]);
    expect(tableRows("Devices, most visitors first")).toEqual([
      ["Desktop", "269", "290"],
      ["Mobile", "242", "250"],
    ]);
    expect(tableRows("Custom events, most visitors first")).toEqual([["signup", "127", "140"]]);
  });

  test("switches between the lists of a card", async () => {
    installFakeApi();
    renderApp(ANALYTICS);

    await page.getByRole("tab", { name: "Entry" }).click();
    expect(tableRows("Entry, most visitors first")).toEqual([
      ["/pricing", "210", "220"],
      ["/", "190", "200"],
    ]);
    await page.getByRole("tab", { name: "Campaigns" }).click();
    expect(tableRows("Campaigns, most visitors first")[0]).toEqual(["No campaign", "700", "760"]);
  });

  test("changes the period, keeping the old numbers dimmed until the new ones arrive", async () => {
    const month = deferred<Analytics>();
    const api = installFakeApi({
      analytics: (_id, period) => (period === "30d" ? month.promise : analyticsFixture()),
    });
    const router = renderApp(ANALYTICS);
    await expect.poll(() => summaryValue("Visitors")).toBe("765");

    await page.getByRole("combobox", { name: "Period" }).click();
    await page.getByRole("option", { name: "Last 30 days" }).click();

    await expect.poll(() => currentPath(router)).toBe(`${ANALYTICS}?period=30d`);
    await expect
      .poll(() => analyticsRequests(api).at(-1))
      .toBe(`/api/projects/${PROJECT.id}/analytics?period=30d`);
    const reports = document.querySelector("[data-refreshing]");
    await expect.poll(() => reports?.getAttribute("data-refreshing")).toBe("true");
    expect(reports?.getAttribute("aria-busy")).toBe("true");
    expect(summaryValue("Visitors")).toBe("765");

    month.resolve(
      analyticsFixture({
        firstDay: "2026-10-18",
        summary: { ...analyticsFixture().summary, visitors: 3210 },
      }),
    );
    await expect.poll(() => summaryValue("Visitors")).toBe("3,210");
    await expect.element(page.getByText("18 Oct – 16 Nov 2026 · Asia/Singapore")).toBeVisible();
    expect(document.querySelector("[data-refreshing]")?.getAttribute("data-refreshing")).toBe(
      "false",
    );
  });

  test("falls back to the last 7 days for an unknown period in the address", async () => {
    const api = installFakeApi();
    renderApp(`${ANALYTICS}?period=week`);

    await expect
      .element(page.getByRole("combobox", { name: "Period" }))
      .toMatchTextContent(/^Last 7 days/);
    expect(analyticsRequests(api)).toEqual([`/api/projects/${PROJECT.id}/analytics?period=7d`]);
  });
});

describe("the daily chart", () => {
  test("charts visitors, visits, or pageviews", async () => {
    installFakeApi();
    renderApp(ANALYTICS);
    await expect
      .element(page.getByRole("slider", { name: "Visitors per day" }))
      .toBeInTheDocument();

    await page.getByRole("tab", { name: "Pageviews" }).click();

    await expect.element(page.getByRole("heading", { name: "Pageviews per day" })).toBeVisible();
    await expect
      .element(page.getByRole("slider", { name: "Pageviews per day" }))
      .toBeInTheDocument();
  });

  test("reads out each day from the keyboard", async () => {
    installFakeApi();
    renderApp(ANALYTICS);
    const chart = page.getByRole("slider", { name: "Visitors per day" });
    await expect.element(chart).toBeInTheDocument();

    chart.element().focus();
    await expect.element(chart).toHaveFocus();
    await expect
      .element(chart)
      .toHaveAttribute("aria-valuetext", "Mon 16 Nov: 70 Visitors, 74 Visits, 169 Pageviews");

    await userEvent.keyboard("{ArrowLeft}");
    await expect
      .element(chart)
      .toHaveAttribute("aria-valuetext", "Sun 15 Nov: 103 Visitors, 110 Visits, 239 Pageviews");
    await userEvent.keyboard("{Home}");
    await expect
      .element(chart)
      .toHaveAttribute("aria-valuetext", "Tue 10 Nov: 120 Visitors, 131 Visits, 290 Pageviews");
    // The readout also shows on screen for the chosen day.
    await expect.element(page.getByText("Tue 10 Nov", { exact: true })).toBeVisible();
  });

  test("shows the nearest day's numbers under the pointer", async () => {
    installFakeApi();
    renderApp(ANALYTICS);
    await expect
      .element(page.getByRole("slider", { name: "Visitors per day" }))
      .toBeInTheDocument();
    const chart = document.querySelector("input[type=range]")?.parentElement;
    if (!(chart instanceof HTMLElement)) {
      throw new Error("The chart is missing");
    }

    // Near the right edge: the last day.
    await userEvent.hover(page.elementLocator(chart), {
      position: { x: chart.clientWidth - 20, y: 100 },
    });
    await expect.element(page.getByText("Mon 16 Nov", { exact: true })).toBeVisible();

    await userEvent.unhover(page.elementLocator(chart));
    await expect.element(page.getByText("Mon 16 Nov", { exact: true })).not.toBeInTheDocument();
  });

  test("shows the same numbers as a table", async () => {
    installFakeApi();
    renderApp(ANALYTICS);
    const toggle = page.getByRole("button", { name: "Show the numbers" });

    await toggle.click();

    await expect
      .element(page.getByRole("button", { name: "Hide the numbers" }))
      .toHaveAttribute("aria-expanded", "true");
    const rows = tableRows("Visitors, visits, and pageviews per day");
    expect(rows).toHaveLength(7);
    expect(rows[0]).toEqual(["Tue 10 Nov", "120", "131", "290"]);
  });

  test("draws no line for a single day", async () => {
    const week = analyticsFixture();
    installFakeApi({
      analytics: () => ({ ...week, firstDay: "2026-11-16", days: week.days.slice(-1) }),
    });
    renderApp(`${ANALYTICS}?period=today`);

    await expect.element(page.getByText(/A trend needs at least two days/)).toBeVisible();
    await expect.element(page.getByRole("slider")).not.toBeInTheDocument();
    await expect
      .element(page.getByRole("tablist", { name: "Metric to chart" }))
      .not.toBeInTheDocument();
  });
});

describe("when there is nothing to show", () => {
  test("asks to install the snippet when the project has never received events", async () => {
    installFakeApi({
      projects: [{ ...PROJECT, lastEventAt: null }],
      analytics: () => emptyAnalytics(),
    });
    renderApp(ANALYTICS);

    await expect.element(page.getByText("No events yet")).toBeVisible();
    await expect
      .element(page.getByRole("link", { name: "Install the snippet" }))
      .toHaveAttribute("href", `/projects/${PROJECT.id}/settings`);
  });

  test("offers a longer period when this one is empty", async () => {
    const api = installFakeApi({ analytics: () => emptyAnalytics() });
    const router = renderApp(ANALYTICS);

    await expect.element(page.getByText("Nothing in this period")).toBeVisible();
    await page.getByRole("link", { name: "Show the last 12 months" }).click();

    await expect.poll(() => currentPath(router)).toBe(`${ANALYTICS}?period=12m`);
    await expect
      .poll(() => analyticsRequests(api).at(-1))
      .toBe(`/api/projects/${PROJECT.id}/analytics?period=12m`);
  });

  test("says when the project does not exist", async () => {
    installFakeApi({
      analytics: () => json({ error: "not_found", message: "No such project" }, 404),
    });
    renderApp(ANALYTICS);

    await expect.element(page.getByText("No such project")).toBeVisible();
    await expect
      .element(page.getByRole("main").getByRole("link", { name: "All projects" }))
      .toBeVisible();
  });

  test("shows a failed load with a retry", async () => {
    let failing = true;
    installFakeApi({
      analytics: () =>
        failing ? json({ message: "The database is down." }, 503) : analyticsFixture(),
    });
    renderApp(ANALYTICS);

    await expect.element(page.getByText("The reports could not load")).toBeVisible();
    await expect.element(page.getByText("The database is down.")).toBeVisible();

    failing = false;
    await page.getByRole("button", { name: "Retry", exact: true }).click();

    await expect.poll(() => summaryValue("Visitors")).toBe("765");
    await expect.element(page.getByText("The reports could not load")).not.toBeInTheDocument();
  });
});
