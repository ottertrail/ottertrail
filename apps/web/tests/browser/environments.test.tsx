import { describe, expect, test } from "vite-plus/test";
import { page } from "vite-plus/test/browser/context";

import {
  analyticsFixture,
  emptyAnalytics,
  type FakeApi,
  installFakeApi,
  PROJECT,
} from "./fake-api.ts";
import { renderApp } from "./render.tsx";

const ANALYTICS = `/projects/${PROJECT.id}/web-analytics`;

/** The query of the latest request to `path`, such as { period: "7d", environment: "staging" }. */
function lastQuery(api: FakeApi, path = "/analytics?"): Record<string, string> {
  const request = api.requests.findLast((item) => item.includes(path)) ?? "";
  return Object.fromEntries(new URLSearchParams(request.slice(request.indexOf("?") + 1)));
}

const addressQuery = (router: ReturnType<typeof renderApp>) => router.state.location.search;

/** Each body row of a table as its cells' text. */
function tableRows(caption: string): string[][] {
  const table = [...document.querySelectorAll("table")].find(
    (item) => item.caption?.textContent === caption,
  );
  return [...(table?.tBodies[0]?.rows ?? [])].map((row) =>
    [...row.cells].map((cell) => cell.textContent ?? ""),
  );
}

/**
 * The fake API as a project with a staging site: environments as the API
 * lists them, and ten top pages, so the list offers "Show all".
 */
function withStaging() {
  return installFakeApi({
    analytics: (_id, _period, query) =>
      analyticsFixture({
        environment: query.get("environment") ?? "production",
        environments: ["production", "staging"],
        pages: Array.from({ length: 10 }, (_, i) => ({
          path: `/page-${i + 1}`,
          pageviews: 900 - i,
          visitors: 500 - i,
          avgEngagedMs: null,
        })),
      }),
  });
}

describe("environments", () => {
  test("offers no choice while the project has production alone", async () => {
    installFakeApi();
    renderApp(ANALYTICS);

    await expect.element(page.getByRole("heading", { name: "Visitors per day" })).toBeVisible();
    expect(document.querySelector("[aria-label=Environment]")).toBeNull();
  });

  test("switches to another environment, keeping the period and filters", async () => {
    const api = withStaging();
    const router = renderApp(`${ANALYTICS}?period=30d&country=DE`);

    await page.getByRole("combobox", { name: "Environment" }).click();
    await page.getByRole("option", { name: "staging" }).click();

    await expect
      .poll(() => addressQuery(router))
      .toEqual({ period: "30d", env: "staging", country: "DE" });
    await expect
      .poll(() => lastQuery(api))
      .toEqual({ period: "30d", environment: "staging", country: "DE" });
    await expect
      .element(page.getByRole("combobox", { name: "Environment" }))
      .toMatchTextContent(/staging/);
  });

  test("a filter, a new period, and Show all stay in the environment", async () => {
    const api = withStaging();
    const router = renderApp(`${ANALYTICS}?env=staging`);

    await page.getByRole("link", { name: "Filter by Country: Germany" }).click();
    await expect.poll(() => addressQuery(router)).toEqual({ env: "staging", country: "DE" });

    await page.getByRole("combobox", { name: "Period" }).click();
    await page.getByRole("option", { name: "Last 30 days" }).click();
    await expect
      .poll(() => lastQuery(api))
      .toEqual({ period: "30d", environment: "staging", country: "DE" });

    await page.getByRole("button", { name: "Show all top pages" }).click();
    await expect.poll(() => lastQuery(api, "/analytics/list?").environment).toBe("staging");
  });

  test("keeps the picker while another environment is shown, as a way back", async () => {
    // As if the API listed only the environment shown.
    installFakeApi({
      analytics: (_id, _period, query) => {
        const environment = query.get("environment") ?? "production";
        return analyticsFixture({ environment, environments: [environment] });
      },
    });
    renderApp(`${ANALYTICS}?env=staging`);

    await expect
      .element(page.getByRole("combobox", { name: "Environment" }))
      .toMatchTextContent(/staging/);
  });

  test("an empty period names its environment, and the way out", async () => {
    const api = installFakeApi({
      analytics: () => ({
        ...emptyAnalytics(),
        environment: "staging",
        environments: ["production", "staging"],
      }),
    });
    const router = renderApp(`${ANALYTICS}?env=staging`);

    await expect
      .element(
        page.getByText(
          "No pageviews or events arrived in staging in this period. Choose a longer one to see earlier data, or another environment.",
        ),
      )
      .toBeVisible();
    await page.getByRole("link", { name: "Show the last 12 months" }).click();
    await expect.poll(() => addressQuery(router)).toEqual({ period: "12m", env: "staging" });
    await expect.poll(() => lastQuery(api)).toEqual({ period: "12m", environment: "staging" });
  });

  test("an environment the API would refuse in the address shows production", async () => {
    const api = withStaging();
    renderApp(`${ANALYTICS}?env=${encodeURIComponent("my staging")}`);

    await expect.element(page.getByRole("heading", { name: "Visitors per day" })).toBeVisible();
    expect(lastQuery(api)).toEqual({ period: "7d" });
  });
});

describe("releases", () => {
  test("lists each release's visitors and visits, and filters by one", async () => {
    const api = installFakeApi();
    const router = renderApp(ANALYTICS);

    await expect
      .poll(() => tableRows("Releases, most visitors first"))
      .toEqual([
        ["1.4.2", "500", "540"],
        ["Unknown", "265", "284"],
      ]);
    await page.getByRole("link", { name: "Filter by Release: 1.4.2" }).click();
    await expect.poll(() => addressQuery(router)).toEqual({ release: "1.4.2" });
    await expect.poll(() => lastQuery(api)).toEqual({ period: "7d", release: "1.4.2" });
  });

  test("says how to name releases when no visit does", async () => {
    installFakeApi({
      analytics: () => {
        const fixture = analyticsFixture();
        return {
          ...fixture,
          breakdowns: {
            ...fixture.breakdowns,
            release: [{ value: null, visitors: 765, visits: 824, bounceRate: 0.24 }],
          },
        };
      },
    });
    renderApp(ANALYTICS);

    await expect.element(page.getByText(/No visit in this period names a release/)).toBeVisible();
  });
});
