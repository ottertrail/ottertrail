import { afterEach, describe, expect, test } from "vite-plus/test";
import { commands, page } from "vite-plus/test/browser/context";

import { NOW_TIMING } from "../../src/lib/now-api.ts";
import { barPoint, tapAt, tooltipOf } from "./chart-pointer.ts";
import { fakeNow, installFakeApi, json, nobodyNow, PROJECT } from "./fake-api.ts";
import { currentPath, renderApp } from "./render.tsx";

/*
 * Right now (docs/web-analytics.md, "Right now"): the indicator on the Web
 * analytics page, the view of its own, and the Overview's widget, all on
 * one query polled every 15 seconds while the tab shows.
 */

const ANALYTICS = `/projects/${PROJECT.id}/web-analytics`;
const NOW = `${ANALYTICS}/now`;
const OVERVIEW = `/projects/${PROJECT.id}/overview`;

const indicator = () => page.getByRole("link", { name: /visitors? now$/ });
const nowRequests = (api: { requests: string[] }) =>
  api.requests.filter((path) => path.includes("/analytics/now"));

/** A cell's text, without the label a stacked breakdown row shows on a phone. */
function cellText(cell: HTMLTableCellElement): string {
  const label = cell.querySelector("[data-slot=breakdown-label]")?.textContent ?? "";
  const text = cell.textContent ?? "";
  return text.startsWith(label) ? text.slice(label.length) : text;
}

/** Each body row of a table as its cells' text, leaving out the bar's cell. */
function tableRows(caption: string): string[][] {
  const table = [...document.querySelectorAll("table")].find(
    (item) => item.caption?.textContent === caption,
  );
  return [...(table?.tBodies[0]?.rows ?? [])].map((row) =>
    [...row.cells]
      .filter((cell) => cell.querySelector("[data-slot=breakdown-bar]") === null)
      .map(cellText),
  );
}

/** The figure under a strip's label. */
function figure(label: string): string | null | undefined {
  const term = [...document.querySelectorAll("dt")].find((dt) => dt.textContent === label);
  return term?.nextElementSibling?.textContent;
}

const PAGES = "Pages visitors were on in the last 30 minutes, most visitors first";
const SOURCES = "Where the last 30 minutes' visits came from, most visitors first";
const COUNTRIES = "Where the last 30 minutes' visitors are, most visitors first";

function expectNoSidewaysScroll(width: number) {
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
}

async function emulateReducedMotion(reduce: boolean) {
  const command: unknown = Reflect.get(commands, "emulateReducedMotion");
  if (typeof command !== "function") {
    throw new TypeError("The emulateReducedMotion command is missing from vite.config.ts");
  }
  await command.call(commands, reduce);
}

afterEach(() => {
  NOW_TIMING.refreshMs = 15_000;
});

describe("the indicator on Web analytics", () => {
  test("shows the visitors now with a green dot, and opens Right now", async () => {
    await page.viewport(1440, 900);
    const api = installFakeApi();
    const router = renderApp(ANALYTICS);
    await expect.element(indicator()).toHaveTextContent("3 visitors now");
    const dot = indicator().element().querySelector("[data-slot=live-dot]");
    expect(dot?.getAttribute("data-live")).toBe("true");
    // It sits in the title row, beside the page's title.
    const header = document.querySelector("[data-slot=page-header]");
    expect(header?.contains(indicator().element())).toBe(true);
    expect(nowRequests(api)).toEqual([`/api/projects/${PROJECT.id}/analytics/now`]);

    await indicator().click();
    await expect.poll(() => currentPath(router)).toBe(NOW);
    await expect.element(page.getByRole("heading", { level: 1, name: "Right now" })).toBeVisible();
    // The view reads the answer the indicator already has.
    expect(nowRequests(api)).toHaveLength(1);
    // Web analytics stays the chosen item of the menu.
    const menu = page.getByRole("navigation", { name: "Project" });
    await expect
      .element(menu.getByRole("link", { name: "Web analytics" }))
      .toHaveAttribute("data-active");
  });

  test("says no visitors now, with a grey dot", async () => {
    installFakeApi({ now: nobodyNow });
    renderApp(ANALYTICS);
    await expect.element(indicator()).toHaveTextContent("No visitors now");
    const dot = indicator().element().querySelector("[data-slot=live-dot]");
    expect(dot?.getAttribute("data-live")).toBe("false");
  });

  test("counts the environment shown, and keeps it on the way to Right now", async () => {
    const api = installFakeApi();
    const router = renderApp(`${ANALYTICS}?env=staging`);
    await expect.element(indicator()).toBeVisible();
    expect(nowRequests(api)).toEqual([
      `/api/projects/${PROJECT.id}/analytics/now?environment=staging`,
    ]);
    await indicator().click();
    await expect.poll(() => currentPath(router)).toBe(`${NOW}?env=staging`);
    await expect.element(page.getByText("staging", { exact: true })).toBeVisible();
    // The way back keeps it too.
    document.querySelector<HTMLElement>("[data-slot=page-back]")?.click();
    await expect.poll(() => currentPath(router)).toBe(`${ANALYTICS}?env=staging`);
  });

  test("pulses only for those who allow motion", async () => {
    installFakeApi();
    renderApp(ANALYTICS);
    await expect.element(indicator()).toBeVisible();
    const dot = () => indicator().element().querySelector("[data-slot=live-dot]");
    expect(getComputedStyle(dot() ?? document.body).animationName).toBe("pulse");
    await emulateReducedMotion(true);
    try {
      await expect.poll(() => getComputedStyle(dot() ?? document.body).animationName).toBe("none");
    } finally {
      await emulateReducedMotion(false);
    }
  });
});

describe("the Right now view", () => {
  test("at 1440: the figures, the minutes, and three lists side by side", async () => {
    await page.viewport(1440, 900);
    installFakeApi();
    renderApp(NOW);
    await expect.element(page.getByRole("heading", { name: "Visitors per minute" })).toBeVisible();
    expect(figure("Visitors now")).toBe("3");
    expect(figure("Visitors, last 30 minutes")).toBe("8");
    expect(figure("Pageviews, last 30 minutes")).toBe("25");
    expect(page.getByText("Asia/Singapore").elements()).toHaveLength(1);

    expect(tableRows(PAGES)).toEqual([
      ["/", "6", "9"],
      ["/pricing", "4", "7"],
      ["/blog/launch", "2", "4"],
      ["/signup", "2", "3"],
      ["/docs/getting-started", "1", "2"],
    ]);
    expect(tableRows(SOURCES)).toEqual([
      ["Direct / none", "4"],
      ["google.com", "3"],
      ["newsletter", "1"],
    ]);
    expect(tableRows(COUNTRIES)).toEqual([
      ["Germany", "4"],
      ["Singapore", "2"],
      ["Unknown", "2"],
    ]);
    const tops = ["Pages", "Sources", "Countries"].map((title) =>
      Math.round(
        page.getByRole("heading", { name: title, exact: true }).element().getBoundingClientRect()
          .top,
      ),
    );
    expect(new Set(tops).size).toBe(1);
    expectNoSidewaysScroll(1440);

    // A bar for each minute with visitors; pageviews a tab away; every minute in the table.
    const chart = document.querySelector("[data-slot=stacked-bar-chart]");
    await expect.poll(() => chart?.querySelectorAll("[data-part=visitors]").length).toBe(21);
    await page.getByRole("tab", { name: "Pageviews" }).click();
    await expect.element(page.getByRole("heading", { name: "Pageviews per minute" })).toBeVisible();
    await page.getByRole("button", { name: "Show the numbers" }).click();
    const minutes = page.getByRole("table", { name: "Visitors and pageviews per minute" });
    await expect.element(minutes).toBeVisible();
    expect(minutes.element().querySelectorAll("tbody tr")).toHaveLength(30);
  });

  test("a row's name opens today's Web analytics, filtered by it", async () => {
    installFakeApi();
    const router = renderApp(NOW);
    await page.getByRole("link", { name: "Filter by Source: google.com" }).click();
    await expect
      .poll(() => currentPath(router))
      .toBe(`${ANALYTICS}?period=today&source=google.com`);
  });

  test("at 390: each list row stacks, a tap reads a minute, and nothing scrolls sideways", async () => {
    await page.viewport(390, 844);
    installFakeApi();
    renderApp(NOW);
    const pages = page.getByRole("table", { name: PAGES });
    await expect.element(pages).toBeVisible();
    expect(getComputedStyle(pages.element()).display).toBe("block");
    expect(pages.element().querySelector("tbody tr")?.textContent).toContain("Views");
    expectNoSidewaysScroll(390);

    const chart = document.querySelector("[data-slot=stacked-bar-chart]");
    if (chart === null) throw new Error("No chart");
    await expect.poll(() => chart.querySelector(".recharts-wrapper")).not.toBeNull();
    await tapAt(chart, barPoint(chart, 29, 30));
    // The minute, then its visitors (the last minutes have one each).
    await expect
      .poll(() => tooltipOf(chart)?.textContent ?? "")
      .toMatch(/\d\d:\d\d to \d\d:\d\d1Visitors$/);
    expectNoSidewaysScroll(390);
  });

  test("with nobody there, says so in the chart's and the lists' place", async () => {
    installFakeApi({ now: nobodyNow });
    renderApp(NOW);
    await expect.element(page.getByRole("heading", { name: "Visitors per minute" })).toBeVisible();
    expect(figure("Visitors now")).toBe("0");
    expect(page.getByText("Nobody in the last 30 minutes.").elements()).toHaveLength(4);
  });

  test("a failed load says so, and Retry asks again", async () => {
    let failing = true;
    installFakeApi({
      now: (query) =>
        failing
          ? json({ error: "reports_busy", message: "The reports are busy. Try again." }, 503)
          : fakeNow(query),
    });
    renderApp(NOW);
    await expect.element(page.getByText("Right now could not load")).toBeVisible();
    failing = false;
    await page.getByRole("button", { name: "Retry" }).click();
    await expect.element(page.getByRole("table", { name: PAGES })).toBeVisible();
  });
});

describe("the Overview's Right now widget", () => {
  test("shows the count and the minutes, and links to the view", async () => {
    await page.viewport(1440, 900);
    const api = installFakeApi();
    const router = renderApp(OVERVIEW);
    const widget = page.getByRole("region", { name: "Right now" });
    await expect.element(widget.getByText("Visitors per minute")).toBeVisible();
    expect(widget.element().querySelector("dl")?.textContent).toBe("Visitors now3Last 30 minutes8");
    await expect.element(widget.getByText(/most, 2, at/)).toBeInTheDocument();
    // The widget's numbers come from Right now's route, not one of the overview's own.
    expect(nowRequests(api)).toHaveLength(1);
    expect(api.requests.some((path) => path.includes("/overview/now"))).toBe(false);

    await widget.getByRole("link", { name: "Pages and sources" }).click();
    await expect.poll(() => currentPath(router)).toBe(NOW);
  });

  test("is offered in Edit overview, and hidden it asks for nothing", async () => {
    const api = installFakeApi();
    renderApp(OVERVIEW);
    await expect.element(page.getByRole("region", { name: "Right now" })).toBeVisible();
    await page.getByRole("button", { name: "Edit overview" }).click();
    await page.getByRole("button", { name: "Hide Right now" }).click();
    await expect.poll(() => api.layout?.hidden).toEqual(["now"]);
    await page.getByRole("button", { name: "Done" }).click();
    NOW_TIMING.refreshMs = 100;
    const before = nowRequests(api).length;
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(nowRequests(api)).toHaveLength(before);
  });
});

describe("polling", () => {
  test("asks again on its interval, once for every reader, and not while the tab is hidden", async () => {
    let answered = 0;
    const api = installFakeApi({
      now: (query) => {
        answered += 1;
        return fakeNow(query, { visitors: answered });
      },
    });
    NOW_TIMING.refreshMs = 150;
    renderApp(NOW);
    // The strip, the chart, and the lists read one query: one request per poll.
    await expect.poll(() => answered).toBeGreaterThanOrEqual(3);
    expect(nowRequests(api)).toHaveLength(answered);
    await expect.poll(() => figure("Visitors now")).toBe(String(answered));

    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    window.dispatchEvent(new Event("visibilitychange"));
    try {
      const hidden = answered;
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(answered).toBe(hidden);
    } finally {
      Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
      window.dispatchEvent(new Event("visibilitychange"));
    }
    const shown = answered;
    await expect.poll(() => answered).toBeGreaterThan(shown);
  });
});
