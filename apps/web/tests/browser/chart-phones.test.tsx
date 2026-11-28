import { describe, expect, test } from "vite-plus/test";
import { page } from "vite-plus/test/browser/context";

import { barPoint, dragAcross, plotPoint, tapAt, tooltipOf } from "./chart-pointer.ts";
import { fakeChecks, installFakeApi, ORDERS_SHAPE, PROJECT } from "./fake-api.ts";
import { renderApp } from "./render.tsx";

/**
 * The charts on a phone, 390 pixels wide, read with a finger: a tap opens the tooltip and a
 * drag moves it, with no hover; the tooltip stays on the screen; and no chart page scrolls
 * sideways (docs/design-system.md, "Charts").
 */

const P = `/projects/${PROJECT.id}`;
const [SHOP] = fakeChecks();

/** The tooltip's box lies inside the screen's width. */
function expectOnScreen(chart: Element) {
  const box = tooltipOf(chart)?.getBoundingClientRect();
  expect(box?.left).toBeGreaterThanOrEqual(0);
  expect(box?.right).toBeLessThanOrEqual(390);
}

describe("a line chart on a phone", () => {
  test("a tap opens the tooltip, and a drag moves it from day to day", async () => {
    await page.viewport(390, 844);
    installFakeApi();
    renderApp(`${P}/web-analytics`);
    await expect
      .element(page.getByRole("slider", { name: "Visitors per day" }))
      .toBeInTheDocument();
    const chart = document.querySelector("[data-slot=day-chart]");
    if (chart === null) throw new Error("The chart is missing");
    expect(tooltipOf(chart)).toBeNull();

    // The first of seven days, then the last, under the finger.
    await tapAt(chart, plotPoint(chart, 0));
    await expect.poll(() => tooltipOf(chart)?.textContent).toMatch(/^Tue 10 Nov120Visitors/);
    expectOnScreen(chart);

    dragAcross(chart, [0.1, 0.5, 1]);
    await expect
      .poll(() => tooltipOf(chart)?.textContent)
      .toMatch(/^Mon 16 Nov \(partial\)70Visitors/);
    expectOnScreen(chart);
  });
});

describe("a bar chart on a phone", () => {
  test("a tap shows a bar's counts, a second tap narrows the period, and a drag moves between bars", async () => {
    await page.viewport(390, 844);
    installFakeApi();
    const router = renderApp(`${P}/logs`);
    await expect
      .element(page.getByRole("slider", { name: "Records per 2 hours, by severity" }))
      .toBeInTheDocument();
    const chart = document.querySelector("[data-slot=stacked-bar-chart]");
    if (chart === null) throw new Error("The chart is missing");

    // The 13th bucket of 84: 11 November, from midnight. The tap only shows it.
    await tapAt(chart, barPoint(chart, 12, 84));
    await expect
      .poll(() => tooltipOf(chart)?.textContent)
      .toMatch(/^Wed 11 Nov 2026, 00:00 to 02:00.*In allTap again to show this day$/);
    expectOnScreen(chart);
    expect(router.state.location.search).toEqual({});

    dragAcross(chart, [0.5, (83 + 0.5) / 84]);
    await expect
      .poll(() => tooltipOf(chart)?.textContent)
      .toMatch(/^Mon 16 Nov 2026, 22:00 to Tue 17 Nov 2026, 00:00/);
    expectOnScreen(chart);

    // Two taps on one bar choose it.
    await tapAt(chart, barPoint(chart, 12, 84));
    expect(router.state.location.search).toEqual({});
    await tapAt(chart, barPoint(chart, 12, 84));
    await expect
      .poll(() => router.state.location.search)
      .toEqual({ from: "2026-11-11", to: "2026-11-11" });
  });
});

describe("the chart pages on a phone", () => {
  const pages: [string, string][] = [
    ["Overview", P],
    ["Web analytics", `${P}/web-analytics`],
    ["Speed", `${P}/speed`],
    ["a product event", `${P}/product/events/signup`],
    [
      "a funnel",
      `${P}/product/funnel?steps=${encodeURIComponent(
        JSON.stringify([
          { type: "page", path: "/pricing" },
          { type: "event", name: "signup" },
        ]),
      )}`,
    ],
    ["Traces", `${P}/traces`],
    ["Logs", `${P}/logs`],
    ["Metrics", `${P}/metrics`],
    [
      "a metric",
      `${P}/metrics/${encodeURIComponent("http.server.request.duration")}?kind=histogram`,
    ],
    ["Active users", `${P}/product/active-users`],
    ["Services", `${P}/services`],
    ["a service", `${P}/services/web`],
    ["Databases", `${P}/databases`],
    ["a query shape", `${P}/databases/${ORDERS_SHAPE.id}`],
    ["a host", `${P}/hosts/web-1`],
    ["AI", `${P}/ai`],
    ["an uptime check", `${P}/uptime/${SHOP?.id ?? ""}`],
  ];
  test.each(pages)("%s fits 390 pixels, its charts included", async (_, path) => {
    await page.viewport(390, 844);
    installFakeApi();
    renderApp(path);
    await expect
      .poll(() => document.querySelectorAll(".recharts-surface").length)
      .toBeGreaterThan(0);
    const content = document.querySelector("[data-slot=app-content]");
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
    expect(content?.scrollWidth).toBeLessThanOrEqual(content?.clientWidth ?? 0);
    for (const chart of document.querySelectorAll("[data-slot=chart]")) {
      expect(chart.getBoundingClientRect().right).toBeLessThanOrEqual(390);
    }
  });
});
