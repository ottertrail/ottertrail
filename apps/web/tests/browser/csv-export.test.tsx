import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser/context";

import { analyticsFixture, fakeCsvExport, installFakeApi, json, PROJECT } from "./fake-api.ts";
import { renderApp } from "./render.tsx";

/*
 * The Web analytics page's CSV exports (docs/web-analytics.md, "CSV
 * export"): Download CSV in Show all, and Export in the title row.
 */

const ANALYTICS = `/projects/${PROJECT.id}/web-analytics`;

/** The page's analytics with 10 top pages: a full list, which Show all opens. */
const fullPages = () =>
  analyticsFixture({
    pages: Array.from({ length: 10 }, (_, i) => ({
      path: `/page-${i + 1}`,
      pageviews: 900 - i,
      visitors: 500 - i,
      avgEngagedMs: null,
    })),
  });

/** The files the page saved: each link's name and its file's text. */
let saved: { name: string; text: Promise<string> }[] = [];

beforeEach(async () => {
  await page.viewport(1280, 900);
  saved = [];
  const blobs = new Map<string, Blob>();
  vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
    const href = `blob:test/${blobs.size}`;
    if (blob instanceof Blob) blobs.set(href, blob);
    return href;
  });
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
  // Saves nothing to disk: records what would be.
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    const blob = blobs.get(this.href);
    saved.push({ name: this.download, text: blob?.text() ?? Promise.resolve("") });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** The query of the latest export request of `part`. */
function exportQuery(requests: readonly string[], part: string): Record<string, string> {
  const path = requests.findLast((request) => request.includes(`/analytics/export/${part}?`)) ?? "";
  return Object.fromEntries(new URLSearchParams(path.slice(path.indexOf("?") + 1)));
}

describe("Show all's Download CSV", () => {
  test("downloads the whole list with the page's range, filters, goal, and search", async () => {
    const api = installFakeApi({ analytics: fullPages });
    renderApp(`${ANALYTICS}?period=30d&country=DE&goalEvent=signed_up`);
    await page.getByRole("button", { name: "Show all top pages" }).click();
    await page.getByRole("searchbox", { name: "Search pages: top pages" }).fill("pricing");
    // The file holds the rows the list shows, once the search has settled.
    await expect
      .poll(() =>
        api.requests.some(
          (path) => path.includes("/analytics/list?") && path.includes("search=pricing"),
        ),
      )
      .toBe(true);

    await page.getByRole("button", { name: "Download pages: top pages as CSV" }).click();

    await expect.poll(() => saved.map((file) => file.name)).toEqual(["demo-pages.csv"]);
    expect(await saved[0]?.text).toBe('"Name","Visitors"\r\n"/pricing",3\r\n');
    expect(exportQuery(api.requests, "list")).toEqual({
      period: "30d",
      country: "DE",
      goalEvent: "signed_up",
      report: "pages",
      search: "pricing",
    });
  });

  test("says when the file holds the first rows only", async () => {
    installFakeApi({
      analytics: fullPages,
      csvExport: (part, query) => {
        const response = fakeCsvExport(part, query);
        response.headers.set("x-export-cut", "10000");
        return response;
      },
    });
    renderApp(ANALYTICS);
    await page.getByRole("button", { name: "Show all top pages" }).click();
    await page.getByRole("button", { name: "Download pages: top pages as CSV" }).click();

    await expect
      .element(
        page.getByText("The list has more than 10,000 rows, so the file holds the first 10,000."),
      )
      .toBeVisible();
  });

  test("shows a refusal as the API words it, and saves nothing", async () => {
    installFakeApi({
      analytics: fullPages,
      csvExport: () =>
        json({ error: "reports_busy", message: "Dashboard pages reached the query limit." }, 503),
    });
    renderApp(ANALYTICS);
    await page.getByRole("button", { name: "Show all top pages" }).click();
    await page.getByRole("button", { name: "Download pages: top pages as CSV" }).click();

    const alert = page.getByRole("dialog").getByRole("alert");
    await expect.element(alert).toMatchTextContent(/The file could not download/);
    await expect.element(alert).toMatchTextContent(/Dashboard pages reached the query limit\./);
    expect(saved).toEqual([]);
  });

  test("fits a phone, 390 wide, with its words still its name", async () => {
    await page.viewport(390, 844);
    installFakeApi({ analytics: fullPages });
    renderApp(ANALYTICS);
    await page.getByRole("button", { name: "Show all top pages" }).click();
    const button = page.getByRole("button", { name: "Download pages: top pages as CSV" });
    await expect.element(button).toBeVisible();
    const dialog = document.querySelector("[role=dialog]");
    expect(dialog?.scrollWidth).toBeLessThanOrEqual(dialog?.clientWidth ?? 0);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
  });
});

describe("the page's Export", () => {
  test("downloads the summary and the chart with the chart's view", async () => {
    const api = installFakeApi();
    renderApp(`${ANALYTICS}?period=30d&interval=week&compare=year&page=%2Fpricing`);

    await page.getByRole("button", { name: "Export" }).click();
    await page.getByRole("button", { name: "Summary" }).click();
    await expect.poll(() => saved.map((file) => file.name)).toEqual(["demo-summary.csv"]);
    expect(exportQuery(api.requests, "summary")).toEqual({
      period: "30d",
      interval: "week",
      compare: "year",
      page: "/pricing",
    });

    await page.getByRole("button", { name: "Chart" }).click();
    await expect
      .poll(() => saved.map((file) => file.name))
      .toEqual(["demo-summary.csv", "demo-chart.csv"]);
    expect(exportQuery(api.requests, "chart")).toMatchObject({ interval: "week", compare: "year" });
  });

  test("shows a refusal in its popover", async () => {
    installFakeApi({
      csvExport: () =>
        json({ error: "rate_limited", message: "Too many requests. Try again in a minute." }, 429),
    });
    renderApp(ANALYTICS);
    await page.getByRole("button", { name: "Export" }).click();
    await page.getByRole("button", { name: "Chart" }).click();

    await expect
      .element(page.getByRole("alert"))
      .toMatchTextContent(/Too many requests\. Try again in a minute\./);
    expect(saved).toEqual([]);
  });

  test("fits a phone, 390 wide", async () => {
    await page.viewport(390, 844);
    installFakeApi();
    renderApp(ANALYTICS);
    await page.getByRole("button", { name: "Export" }).click();
    await expect.element(page.getByRole("button", { name: "Summary" })).toBeVisible();
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
  });
});
