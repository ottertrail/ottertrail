import { afterEach, describe, expect, test } from "vite-plus/test";
import { page } from "vite-plus/test/browser/context";

import { analyticsFixture, installFakeApi, PROJECT } from "./fake-api.ts";
import { currentPath, renderApp } from "./render.tsx";

/*
 * Web analytics as a report (docs/design-system.md, "Report (Console)"):
 * the pinned filter bar, the strip of figures, and the breakdowns' views.
 * analytics-page.test.tsx and filters.test.tsx cover the numbers and filters.
 */

const ANALYTICS = `/projects/${PROJECT.id}/web-analytics`;

afterEach(async () => {
  await page.viewport(1280, 900);
});

/** The report's filter bar: a <search> landmark. */
const filterBar = () => {
  const bar = document.querySelector("search[aria-label='Period, environment, and filters']");
  if (!(bar instanceof HTMLElement)) throw new Error("The filter bar is missing");
  return page.elementLocator(bar);
};

describe("the web analytics report", () => {
  test("its filter bar holds the period, the filters, and the days with their timezone", async () => {
    installFakeApi();
    renderApp(ANALYTICS);

    await expect.element(page.getByRole("combobox", { name: "Period" })).toBeVisible();
    await expect.element(filterBar().getByRole("combobox", { name: "Period" })).toBeVisible();
    // One environment: no picker.
    expect(filterBar().getByRole("combobox", { name: "Environment" }).elements()).toEqual([]);
    await expect
      .element(
        filterBar().getByText("No filters. Add one, or select a name in a table to filter by it."),
      )
      .toBeVisible();
    await expect.element(filterBar().getByText("10 to 16 Nov 2026", { exact: true })).toBeVisible();
    await expect.element(filterBar().getByText("Asia/Singapore", { exact: true })).toBeVisible();
    // Pinned under the header while the report scrolls.
    expect(getComputedStyle(filterBar().element()).position).toBe("sticky");
  });

  test("shows the environment picker once there are two, and the filters with a way out", async () => {
    installFakeApi({
      analytics: () => ({ ...analyticsFixture(), environments: ["production", "staging"] }),
    });
    const router = renderApp(`${ANALYTICS}?country=DE`);

    await expect.element(page.getByRole("combobox", { name: "Period" })).toBeVisible();
    await expect.element(filterBar().getByRole("combobox", { name: "Environment" })).toBeVisible();
    await expect
      .element(filterBar().getByRole("list", { name: "Filters" }))
      .toHaveTextContent("Country is Germany");
    await filterBar().getByRole("link", { name: "Clear filters" }).click();
    await expect.poll(() => currentPath(router)).toBe(ANALYTICS);
  });

  test("each breakdown switches its view with a toggle group, one view shown at a time", async () => {
    installFakeApi();
    renderApp(ANALYTICS);

    for (const [title, views] of [
      ["Pages", ["Top pages", "Entry", "Exit", "Hostnames"]],
      ["Sources", ["Sources", "Channels"]],
      ["Campaigns", ["Campaign", "Source", "Medium", "Term", "Content"]],
      ["Locations", ["Countries", "Regions", "Cities"]],
      ["Devices", ["Devices", "Browsers", "Systems"]],
    ] as const) {
      const group = page.getByRole("group", { name: `Which ${title.toLowerCase()} to list` });
      await expect.element(group).toBeVisible();
      const buttons = group.getByRole("button").elements();
      expect(buttons.map((button) => button.textContent)).toEqual(views);
      expect(buttons.map((button) => button.getAttribute("aria-pressed"))).toEqual(
        views.map((_, index) => (index === 0 ? "true" : "false")),
      );
    }
    // Releases and custom events have one list each: no toggle.
    for (const title of ["Releases", "Custom events"]) {
      await expect.element(page.getByRole("heading", { name: title })).toBeVisible();
      expect(
        page.getByRole("group", { name: `Which ${title.toLowerCase()} to list` }).elements(),
      ).toEqual([]);
    }

    const locations = page.getByRole("group", { name: "Which locations to list" });
    await locations.getByRole("button", { name: "Cities" }).click();
    await expect
      .element(page.getByRole("table", { name: "Cities, most visitors first" }))
      .toBeVisible();
    expect(page.getByRole("table", { name: "Countries, most visitors first" }).elements()).toEqual(
      [],
    );
  });

  test("the figures sit in one strip, each with its change from the period before", async () => {
    installFakeApi();
    renderApp(ANALYTICS);

    const strip = page.getByRole("region", { name: "Summary" });
    await expect.element(strip).toBeVisible();
    const labels = [...strip.element().querySelectorAll("dt")].map((dt) => dt.textContent);
    expect(labels).toEqual([
      "Visitors",
      "Visits",
      "Pageviews",
      "Views per visit",
      "Bounce rate",
      "Visit duration",
      "Time engaged",
    ]);
  });
});

/** Nothing in the content panel or the page scrolls sideways. */
function expectNoSidewaysScroll(width: number) {
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
  const content = document.querySelector("[data-slot=app-content]");
  expect(content?.scrollWidth).toBeLessThanOrEqual(content?.clientWidth ?? 0);
}

const topPages = () => page.getByRole("table", { name: "Top pages, most visitors first" });

describe("the web analytics report fits", () => {
  test("at 390 wide: the bar scrolls away, and each breakdown row stacks", async () => {
    await page.viewport(390, 844);
    installFakeApi();
    renderApp(ANALYTICS);

    await expect.element(topPages()).toBeVisible();
    expectNoSidewaysScroll(390);
    expect(getComputedStyle(filterBar().element()).position).not.toBe("sticky");
    expect(getComputedStyle(topPages().element()).display).toBe("block");
    // Each row labels its figures.
    expect(topPages().element().querySelector("tbody tr")?.textContent).toContain("Views");
  });

  test("at 1440 wide: the bar is pinned, and three breakdowns sit side by side", async () => {
    await page.viewport(1440, 900);
    installFakeApi();
    renderApp(ANALYTICS);

    await expect.element(topPages()).toBeVisible();
    expectNoSidewaysScroll(1440);
    expect(getComputedStyle(filterBar().element()).position).toBe("sticky");
    const tops = ["Pages", "Sources", "Campaigns"].map((title) =>
      Math.round(
        page.getByRole("heading", { name: title, exact: true }).element().getBoundingClientRect()
          .top,
      ),
    );
    // Campaigns' five toggles wrap under its title, which then sits a little higher.
    const [pages = 0, ...others] = tops;
    for (const top of others) expect(Math.abs(top - pages)).toBeLessThan(16);
  });
});

/** A figure's change line: what it shows; null when it has none. */
function changeShown(label: string): string | null {
  const term = [...document.querySelectorAll("dt")].find((dt) => dt.textContent === label);
  const line = term?.nextElementSibling?.nextElementSibling;
  return line ? (line.querySelector("span[aria-hidden=true]")?.textContent ?? "") : null;
}

describe("the change rule's minimum", () => {
  test("rests the per-visit figures on visits: few visits, no change, though pageviews have one", async () => {
    const week = analyticsFixture();
    installFakeApi({
      analytics: () => ({
        ...week,
        summary: { ...week.summary, visitors: 9, visits: 12, pageviews: 40 },
        previous: {
          ...week.previous,
          summary: { ...week.previous.summary, visitors: 8, visits: 10, pageviews: 30 },
        },
      }),
    });
    renderApp(ANALYTICS);
    await expect.element(page.getByRole("region", { name: "Summary" })).toBeVisible();

    // 40 and 30 pageviews reach the minimum of 20: the change shows.
    expect(changeShown("Pageviews")).toBe("33%");
    // Visits under 20 in both periods: nothing that rests on them shows a change.
    for (const label of [
      "Visitors",
      "Visits",
      "Views per visit",
      "Bounce rate",
      "Visit duration",
    ]) {
      expect({ label, change: changeShown(label) }).toEqual({ label, change: null });
    }
  });
});
