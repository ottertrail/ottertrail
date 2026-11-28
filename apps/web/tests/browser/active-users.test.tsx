import { afterEach, describe, expect, test } from "vite-plus/test";
import { page } from "vite-plus/test/browser/context";

import {
  ACTIVE_DAYS,
  activeUsersFixture,
  type FakeApi,
  installFakeApi,
  json,
  PROJECT,
} from "./fake-api.ts";
import { renderApp } from "./render.tsx";

const PRODUCT = `/projects/${PROJECT.id}/product`;
const ACTIVE = `${PRODUCT}/active-users`;
const CHART_TABLE = "Active users and stickiness";
const LIFECYCLE_TABLE = "New, returning, and resurrected users";

const lastQuery = (api: FakeApi) => {
  const request = api.requests.findLast((item) => item.split("?")[0]?.endsWith("/active-users"));
  const at = request?.indexOf("?") ?? -1;
  return request === undefined || at === -1
    ? {}
    : Object.fromEntries(new URLSearchParams(request.slice(at + 1)));
};

const rows = (name: string) =>
  [...page.getByRole("table", { name }).element().querySelectorAll("tbody tr")].map((row) =>
    [...row.querySelectorAll("th, td")].map((cell) => cell.textContent),
  );

/** The summary's figures: each label and its value. */
const figures = () =>
  [...document.querySelectorAll("[data-slot=stat]")].map((stat) => [
    stat.querySelector("dt")?.textContent,
    stat.querySelector("dd")?.textContent,
  ]);

const DAYS = [
  "Tue 10 Nov",
  "Wed 11 Nov",
  "Thu 12 Nov",
  "Fri 13 Nov",
  "Sat 14 Nov",
  "Sun 15 Nov",
  "Mon 16 Nov",
];

afterEach(async () => {
  await page.viewport(1280, 900);
});

describe("active users", () => {
  test("the tab sits after Retention and keeps the period and environment", async () => {
    const api = installFakeApi();
    const router = renderApp(`${PRODUCT}/events?period=30d&env=staging`);
    const tabs = page.getByRole("navigation", { name: "Product analytics reports" });
    await expect
      .poll(() =>
        tabs
          .getByRole("link")
          .elements()
          .map((link) => link.textContent),
      )
      .toEqual(["Events", "Funnel", "Retention", "Active users"]);

    await tabs.getByRole("link", { name: "Active users" }).click();
    await expect.poll(() => router.state.location.pathname).toBe(ACTIVE);
    expect(router.state.location.search).toEqual({ period: "30d", env: "staging" });
    await expect.poll(() => lastQuery(api)).toEqual({ period: "30d", environment: "staging" });
  });

  test.each([1440, 390])(
    "shows the summary, the chart, and the lifecycle at %i pixels",
    async (width) => {
      await page.viewport(width, 900);
      installFakeApi();
      renderApp(ACTIVE);

      await expect
        .element(page.getByRole("slider", { name: "Daily active users per day" }))
        .toBeInTheDocument();
      await expect
        .element(
          page.getByText(/^Counts signed-in users only\. For all visitors, see Web analytics\.$/),
        )
        .toBeVisible();
      await expect
        .element(
          page
            .getByText(/^Counts signed-in users only/)
            .getByRole("link", { name: "Web analytics" }),
        )
        .toHaveAttribute("href", `/projects/${PROJECT.id}/web-analytics`);
      // 248 users a day over 7 days; stickiness averages each day's DAU ÷ MAU, about 11.6%.
      expect(figures()).toEqual([
        ["Active users", "140"],
        ["Average DAU", "35.4"],
        ["WAU, last day", "126"],
        ["MAU, last day", "310"],
        ["Stickiness", "12%"],
      ]);
      await expect.element(page.getByText("Up 17% from 120")).toBeInTheDocument();
      await expect.element(page.getByText("Up 2 points from 10%")).toBeInTheDocument();
      await expect.element(page.getByText("Changes compare with 3 to 9 Nov 2026.")).toBeVisible();

      expect(document.querySelector("[data-slot=day-chart] .recharts-surface")).not.toBeNull();
      expect(
        document.querySelectorAll("[data-slot=stacked-bar-chart] path[data-part]").length,
      ).toBe(21);
      const content = document.querySelector("[data-slot=app-content]");
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
      expect(content?.scrollWidth).toBeLessThanOrEqual(content?.clientWidth ?? 0);
      for (const chart of document.querySelectorAll("[data-slot=chart]")) {
        expect(chart.getBoundingClientRect().right).toBeLessThanOrEqual(width);
      }
    },
  );

  test("switches the chart between DAU, WAU, and MAU, and shows its numbers", async () => {
    installFakeApi();
    renderApp(ACTIVE);

    await page.getByRole("button", { name: "WAU", exact: true }).click();
    await expect
      .element(page.getByRole("slider", { name: "Weekly active users per day" }))
      .toBeInTheDocument();
    await page.getByRole("button", { name: "MAU", exact: true }).click();
    await expect
      .element(page.getByRole("slider", { name: "Monthly active users per day" }))
      .toHaveAttribute("aria-valuetext", "Mon 16 Nov: 310 MAU, 13% stickiness");

    const chart = page.getByRole("region", { name: "Active users" });
    await chart.getByRole("button", { name: "Show the numbers" }).click();
    expect(rows(CHART_TABLE)).toEqual(
      DAYS.map((day, index) => {
        const dau = ACTIVE_DAYS.dau[index] ?? 0;
        const mau = ACTIVE_DAYS.mau[index] ?? 0;
        return [
          day,
          String(dau),
          String(ACTIVE_DAYS.wau[index]),
          String(mau),
          `${Math.round((dau / mau) * 100)}%`,
        ];
      }),
    );
  });

  test("each day's new, returning, and resurrected users add up to its DAU", async () => {
    installFakeApi();
    renderApp(ACTIVE);

    const chart = page.getByRole("region", { name: "New, returning, and resurrected" });
    await chart.getByRole("button", { name: "Show the numbers" }).click();
    const table = rows(LIFECYCLE_TABLE);
    expect(table.map((row) => row[0])).toEqual(DAYS);
    for (const [index, row] of table.entries()) {
      const [fresh, returning, resurrected, active] = row.slice(1).map(Number);
      expect((fresh ?? 0) + (returning ?? 0) + (resurrected ?? 0)).toBe(active);
      expect(active).toBe(ACTIVE_DAYS.dau[index]);
    }
    await expect
      .element(page.getByRole("slider", { name: "Active users per day, by lifecycle" }))
      .toHaveAttribute(
        "aria-valuetext",
        "Mon 16 Nov: 39 in all, Returning 33, Resurrected 2, New 4",
      );
  });

  test("shows weeks for a long period", async () => {
    installFakeApi({
      activeUsers: () =>
        activeUsersFixture({
          unit: "week",
          firstDay: "2026-08-19",
          lastDay: "2026-11-16",
          points: activeUsersFixture()
            .points.slice(0, 2)
            .map((point, index) => ({
              ...point,
              day: index === 0 ? "2026-11-02" : "2026-11-09",
              dau: 35.5,
            })),
        }),
    });
    renderApp(`${ACTIVE}?period=90d`);

    await expect
      .element(page.getByRole("slider", { name: "Daily active users per week" }))
      .toHaveAttribute("aria-valuetext", "Week of 9 Nov: 35.5 DAU, 15% stickiness");
    const chart = page.getByRole("region", { name: "Active users" });
    await chart.getByRole("button", { name: "Show the numbers" }).click();
    expect(rows(CHART_TABLE).map((row) => row.slice(0, 2))).toEqual([
      ["Week of 2 Nov", "35.5"],
      ["Week of 9 Nov", "35.5"],
    ]);
  });

  test("explains how to name users when the project has none", async () => {
    installFakeApi({
      activeUsers: () =>
        activeUsersFixture({
          summary: { users: 0, averageDaily: 0, weekly: 0, monthly: 0, stickiness: null },
          identifiesUsers: false,
        }),
    });
    renderApp(ACTIVE);

    await expect.element(page.getByText("No signed-in users yet")).toBeVisible();
    await expect
      .element(page.getByRole("link", { name: /How to name signed-in users/ }))
      .toHaveAttribute("href", "https://docs.ottertrail.app/users/naming-users/");
    expect(document.querySelector("[data-slot=stat-strip]")).toBeNull();
  });

  test("says so when nobody was active in the period", async () => {
    installFakeApi({
      activeUsers: () =>
        activeUsersFixture({
          environment: "staging",
          summary: { users: 0, averageDaily: 0, weekly: 0, monthly: 4, stickiness: 0 },
        }),
    });
    renderApp(`${ACTIVE}?env=staging`);

    await expect
      .element(page.getByText("No signed-in users were active in this period"))
      .toBeVisible();
    await expect
      .element(page.getByText("No signed-in user sent an event in staging from 10 to 16 Nov 2026."))
      .toBeVisible();
  });

  test("keeps the page when the report fails, with a retry", async () => {
    installFakeApi({ activeUsers: () => json({ message: "The database is down." }, 503) });
    renderApp(ACTIVE);

    await expect.element(page.getByText("The active users report could not load")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Retry" })).toBeVisible();
  });
});
