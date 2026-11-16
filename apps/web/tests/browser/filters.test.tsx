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

/** The query of the page's latest analytics request, such as { period: "7d", country: "DE" }. */
function lastQuery(api: FakeApi): Record<string, string> {
  const path = api.requests.findLast((request) => request.includes("/analytics?")) ?? "";
  return Object.fromEntries(new URLSearchParams(path.slice(path.indexOf("?") + 1)));
}

const addressQuery = (router: ReturnType<typeof renderApp>) => router.state.location.search;
const currentHref = (router: ReturnType<typeof renderApp>) => router.state.location.href;

/** The active filters as their chips read, such as ["Country: Germany"]. */
function chips(): string[] {
  const list = document.querySelector("ul[aria-label=Filters]");
  return [...(list?.querySelectorAll("li") ?? [])].map((item) => item.textContent);
}

describe("filters", () => {
  test("a row filters the whole page to its visits", async () => {
    const api = installFakeApi();
    const router = renderApp(ANALYTICS);

    await page.getByRole("link", { name: "Filter by Country: Germany" }).click();

    await expect.poll(() => addressQuery(router)).toEqual({ country: "DE" });
    await expect.poll(() => lastQuery(api)).toEqual({ period: "7d", country: "DE" });
    await expect.poll(chips).toEqual(["Country: Germany"]);
  });

  test("a page from Top pages filters to the visits that viewed it", async () => {
    const api = installFakeApi();
    const router = renderApp(ANALYTICS);

    await page.getByRole("link", { name: "Filter by Page: /pricing" }).click();

    await expect.poll(() => addressQuery(router)).toEqual({ page: "/pricing" });
    await expect.poll(() => lastQuery(api)).toEqual({ period: "7d", page: "/pricing" });
  });

  test("an Unknown row filters to visits where the value is unknown", async () => {
    const api = installFakeApi();
    const router = renderApp(ANALYTICS);

    await page.getByRole("link", { name: "Filter by Country: Unknown" }).click();

    await expect.poll(() => addressQuery(router)).toEqual({ country: "" });
    await expect.poll(() => lastQuery(api)).toEqual({ period: "7d", country: "" });
    await expect.poll(chips).toEqual(["Country: Unknown"]);
  });

  test("filters combine, and each can be removed, or all at once", async () => {
    const api = installFakeApi();
    const router = renderApp(`${ANALYTICS}?country=DE&source=google.com`);

    await expect.poll(chips).toEqual(["Source: google.com", "Country: Germany"]);
    expect(lastQuery(api)).toEqual({ period: "7d", source: "google.com", country: "DE" });

    await page.getByRole("link", { name: "Remove the filter Source: google.com" }).click();
    await expect.poll(() => addressQuery(router)).toEqual({ country: "DE" });
    await expect.poll(chips).toEqual(["Country: Germany"]);

    await page.getByRole("link", { name: "Clear filters" }).click();
    await expect.poll(() => addressQuery(router)).toEqual({});
    await expect.poll(() => lastQuery(api)).toEqual({ period: "7d" });
    await expect.element(page.getByRole("list", { name: "Filters" })).not.toBeInTheDocument();
  });

  test("a new period keeps the filters", async () => {
    const api = installFakeApi();
    const router = renderApp(`${ANALYTICS}?country=DE`);

    await page.getByRole("combobox", { name: "Period" }).click();
    await page.getByRole("option", { name: "Last 30 days" }).click();

    await expect.poll(() => addressQuery(router)).toEqual({ period: "30d", country: "DE" });
    await expect.poll(() => lastQuery(api)).toEqual({ period: "30d", country: "DE" });
  });

  test("a value the address bar reads as a number stays text", async () => {
    const api = installFakeApi();
    renderApp(`${ANALYTICS}?city=2024`);

    await expect.poll(chips).toEqual(["City: 2024"]);
    expect(lastQuery(api)).toEqual({ period: "7d", city: "2024" });
  });

  test("keeps a hand-written value exactly, even one that looks like a number", async () => {
    const api = installFakeApi();
    renderApp(`${ANALYTICS}?utmCampaign=2024.10&city=1e3&os=12345678901234567890`);

    await expect
      .poll(chips)
      .toEqual(["Campaign: 2024.10", "City: 1e3", "Operating system: 12345678901234567890"]);
    expect(lastQuery(api)).toEqual({
      period: "7d",
      utmCampaign: "2024.10",
      city: "1e3",
      os: "12345678901234567890",
    });
  });

  test("a value that looks like a number survives the app's own links", async () => {
    const api = installFakeApi();
    const router = renderApp(`${ANALYTICS}?city=2024`);

    await page.getByRole("combobox", { name: "Period" }).click();
    await page.getByRole("option", { name: "Last 30 days" }).click();

    await expect.poll(() => lastQuery(api)).toEqual({ period: "30d", city: "2024" });
    expect(currentHref(router)).toBe(`${ANALYTICS}?period=30d&city=%222024%22`);
    await expect.poll(chips).toEqual(["City: 2024"]);
  });

  test("ignores a value it cannot use, instead of sending it", async () => {
    const api = installFakeApi();
    const object = encodeURIComponent(JSON.stringify({ a: 1 }));
    renderApp(
      `${ANALYTICS}?country=${object}&page=/${"a".repeat(2048)}&region=%00&source=google.com`,
    );

    await expect.poll(chips).toEqual(["Source: google.com"]);
    expect(lastQuery(api)).toEqual({ period: "7d", source: "google.com" });
  });

  test("says when no visit matches, with a way to clear the filters", async () => {
    const api = installFakeApi({
      analytics: (_id, _period, query) =>
        query.has("country") ? emptyAnalytics() : analyticsFixture(),
    });
    const router = renderApp(`${ANALYTICS}?country=FR`);

    await expect.element(page.getByText("No visits match these filters")).toBeVisible();
    await page.getByRole("main").getByRole("link", { name: "Clear filters" }).last().click();

    await expect.poll(() => addressQuery(router)).toEqual({});
    await expect.poll(() => lastQuery(api)).toEqual({ period: "7d" });
    await expect.element(page.getByRole("heading", { name: "Visitors per day" })).toBeVisible();
  });
});
