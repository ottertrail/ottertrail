import { describe, expect, test } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser/context";

import type { Analytics } from "../../src/lib/analytics-api.ts";
import { analyticsFixture, installFakeApi, PROJECT, withGoal, withView } from "./fake-api.ts";
import { currentPath, renderApp } from "./render.tsx";

const ANALYTICS = `/projects/${PROJECT.id}/web-analytics`;
const API = `/api/projects/${PROJECT.id}/analytics`;

const analyticsRequests = (api: { requests: string[] }) =>
  api.requests.filter((request) => request.startsWith(`${API}?`));

/** Today by the hour: 00:00 to 15:00, the current hour partial. */
function hourlyToday(): Analytics {
  const week = analyticsFixture();
  return {
    ...week,
    firstDay: "2026-11-16",
    lastDay: "2026-11-16",
    interval: "hour",
    intervals: ["hour"],
    chart: Array.from({ length: 16 }, (_, hour) => ({
      start: `2026-11-16T${String(hour).padStart(2, "0")}:00`,
      end: "2026-11-16",
      partial: hour === 15,
      visitors: 10 + hour,
      visits: 11 + hour,
      pageviews: 20 + hour,
      previous: { visitors: 8 + hour, visits: 9 + hour, pageviews: 18 + hour },
    })),
  };
}

describe("the range picker", () => {
  test("offers the Web analytics ranges, and the address keeps the one chosen", async () => {
    const api = installFakeApi();
    const router = renderApp(ANALYTICS);
    await page.getByRole("combobox", { name: "Period" }).click();
    const names = page
      .getByRole("option")
      .elements()
      .map((option) => option.textContent);
    expect(names).toEqual([
      "Today",
      "Yesterday",
      "Last 24 hours",
      "Last 7 days",
      "Last 30 days",
      "Month to date",
      "Last 90 days",
      "Year to date",
      "Last 12 months",
      "All time",
      "Custom range…",
    ]);

    await page.getByRole("option", { name: "Last 24 hours" }).click();
    await expect.poll(() => currentPath(router)).toBe(`${ANALYTICS}?period=24h`);
    await expect.poll(() => analyticsRequests(api).at(-1)).toBe(`${API}?period=24h`);
  });

  test("a link with a new range opens it", async () => {
    const api = installFakeApi();
    renderApp(`${ANALYTICS}?period=ytd`);
    await expect
      .element(page.getByRole("combobox", { name: "Period" }))
      .toMatchTextContent(/^Year to date/);
    expect(analyticsRequests(api)).toEqual([`${API}?period=ytd`]);
  });

  test("All time has no comparison to choose", async () => {
    const api = installFakeApi();
    renderApp(`${ANALYTICS}?period=all&compare=year`);
    await expect
      .element(page.getByRole("combobox", { name: "Period" }))
      .toMatchTextContent(/^All time/);
    await expect
      .element(page.getByRole("combobox", { name: "Compare with" }))
      .not.toBeInTheDocument();
    expect(analyticsRequests(api)).toEqual([`${API}?period=all`]);
  });
});

describe("the chart's interval", () => {
  test("switches among the intervals that fit, and the address keeps it", async () => {
    const api = installFakeApi();
    const router = renderApp(ANALYTICS);
    const control = page.getByRole("group", { name: "Chart interval" });
    await expect.element(control).toBeVisible();
    expect(
      control
        .getByRole("button")
        .elements()
        .map((button) => button.textContent),
    ).toEqual(["Hour", "Day"]);
    await expect
      .element(control.getByRole("button", { name: "Day" }))
      .toHaveAttribute("aria-pressed", "true");

    await control.getByRole("button", { name: "Hour" }).click();
    await expect.poll(() => currentPath(router)).toBe(`${ANALYTICS}?interval=hour`);
    await expect.poll(() => analyticsRequests(api).at(-1)).toBe(`${API}?period=7d&interval=hour`);
  });

  test("another range drops the interval chosen for the last one", async () => {
    installFakeApi();
    const router = renderApp(`${ANALYTICS}?interval=hour`);
    await page.getByRole("combobox", { name: "Period" }).click();
    await page.getByRole("option", { name: "Last 90 days" }).click();
    await expect.poll(() => currentPath(router)).toBe(`${ANALYTICS}?period=90d`);
  });

  test("hours name their time of day, and the running hour says it is partial", async () => {
    installFakeApi({
      analytics: (_id, _period, query, api) =>
        withGoal(withView(hourlyToday(), query), query, api.goals),
    });
    renderApp(`${ANALYTICS}?period=today`);
    const chart = page.getByRole("slider", { name: "Visitors per hour" });
    await expect.element(chart).toBeInTheDocument();
    // One interval fits: no control.
    await expect
      .element(page.getByRole("group", { name: "Chart interval" }))
      .not.toBeInTheDocument();

    chart.element().focus();
    await expect
      .element(chart)
      .toHaveAttribute(
        "aria-valuetext",
        "Mon 16 Nov, 15:00 (partial): 25 Visitors, 23 Visitors, previous period, 26 Visits, 35 Pageviews",
      );
    await userEvent.keyboard("{Home}");
    await expect
      .poll(() => chart.element().getAttribute("aria-valuetext"))
      .toMatch(/^Mon 16 Nov, 00:00: 10 Visitors/);
  });
});

describe("the comparison", () => {
  test("draws the period before as a second line, named in a legend and in the tooltip", async () => {
    installFakeApi();
    renderApp(ANALYTICS);
    const lines = page.getByRole("list", { name: "Lines" });
    await expect.element(lines).toBeVisible();
    expect(
      lines
        .getByRole("listitem")
        .elements()
        .map((item) => item.textContent),
    ).toEqual(["This period", "Previous period"]);
    const dashed = document.querySelector("[data-slot=day-chart] path[stroke-dasharray='4 3']");
    expect(dashed).not.toBeNull();

    const chart = page.getByRole("slider", { name: "Visitors per day" });
    chart.element().focus();
    await userEvent.keyboard("{Home}");
    await expect
      .element(chart)
      .toHaveAttribute(
        "aria-valuetext",
        "Tue 10 Nov: 120 Visitors, 101 Visitors, previous period, 131 Visits, 290 Pageviews",
      );
  });

  test("the same period last year: the address and the request keep it", async () => {
    const api = installFakeApi();
    const router = renderApp(ANALYTICS);
    await page.getByRole("combobox", { name: "Compare with" }).click();
    await page.getByRole("option", { name: "Same period last year" }).click();

    await expect.poll(() => currentPath(router)).toBe(`${ANALYTICS}?compare=year`);
    await expect.poll(() => analyticsRequests(api).at(-1)).toBe(`${API}?period=7d&compare=year`);
    await expect
      .element(page.getByRole("list", { name: "Lines" }))
      .toHaveTextContent("This periodSame period last year");
    await expect.element(page.getByText(/^Changes compare with 10 to 16 Nov 2025/)).toBeVisible();
  });

  test("off: one line, and the figures without changes", async () => {
    const api = installFakeApi();
    renderApp(`${ANALYTICS}?compare=off`);
    await expect
      .element(page.getByRole("slider", { name: "Visitors per day" }))
      .toBeInTheDocument();
    expect(analyticsRequests(api)).toEqual([`${API}?period=7d&compare=off`]);
    await expect.element(page.getByRole("list", { name: "Lines" })).not.toBeInTheDocument();
    expect(document.querySelector("[data-slot=day-chart] path[stroke-dasharray='4 3']")).toBeNull();
    expect(page.getByText(/Changes compare with/).elements()).toEqual([]);
  });
});
