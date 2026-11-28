import { describe, expect, test } from "vite-plus/test";
import { page } from "vite-plus/test/browser/context";

import { type FakeApi, installFakeApi, PROJECT } from "./fake-api.ts";
import { renderApp } from "./render.tsx";

/** Yesterday, Month to date, and Year to date outside Web analytics (docs/dashboard.md). */

const P = `/projects/${PROJECT.id}`;

const SHARED = [
  "Today",
  "Yesterday",
  "Last 7 days",
  "Last 30 days",
  "Month to date",
  "Last 90 days",
  "Year to date",
  "Last 12 months",
  "Custom range…",
];

function lastQuery(api: FakeApi, path: string): Record<string, string> | undefined {
  const request = api.requests.findLast((item) => item.split("?")[0]?.endsWith(path));
  if (request === undefined) return undefined;
  const at = request.indexOf("?");
  return at === -1 ? {} : Object.fromEntries(new URLSearchParams(request.slice(at + 1)));
}

const options = () =>
  page
    .getByRole("option")
    .elements()
    .map((option) => option.textContent);

const period = () => page.getByRole("combobox", { name: "Period" });

describe("the shared period picker", () => {
  test.each([
    { name: "Errors", path: "/errors", api: "/errors" },
    { name: "Events", path: "/product/events", api: "/events" },
    { name: "AI usage", path: "/ai", api: "/ai" },
    { name: "Heatmaps", path: "/heatmaps", api: "/heatmaps/pages" },
  ])("$name offers the three periods, keeps one in the address, and asks for it", async (page_) => {
    const api = installFakeApi();
    const router = renderApp(`${P}${page_.path}`);
    await expect.element(period()).toBeVisible();
    await period().click();
    await expect.poll(options).toEqual(SHARED);
    await page.getByRole("option", { name: "Month to date" }).click();
    await expect.poll(() => router.state.location.search).toMatchObject({ period: "mtd" });
    await expect.poll(() => lastQuery(api, page_.api)).toMatchObject({ period: "mtd" });
    await expect.element(period()).toMatchTextContent(/^Month to date/);
  });

  test("an address with Year to date or Yesterday opens on it", async () => {
    const api = installFakeApi();
    renderApp(`${P}/errors?period=ytd`);
    await expect.element(period()).toMatchTextContent(/^Year to date/);
    expect(lastQuery(api, "/errors")).toMatchObject({ period: "ytd" });
  });

  test("Retention offers Year to date, and opens a shorter period on Last 90 days", async () => {
    const api = installFakeApi();
    renderApp(`${P}/product/retention?period=mtd`);
    await expect.element(period()).toMatchTextContent(/^Last 90 days/);
    expect(lastQuery(api, "/retention")).toEqual({ period: "90d" });
    await period().click();
    await expect.poll(options).not.toContain("Yesterday");
    expect(options()).not.toContain("Month to date");
    expect(options()).toContain("Year to date");
  });
});

describe("the Overview", () => {
  test("offers Yesterday and Month to date, not Year to date, and its links keep the period", async () => {
    const api = installFakeApi();
    const router = renderApp(`${P}/overview`);
    await period().click();
    await expect
      .poll(options)
      .toEqual(["Today", "Yesterday", "Last 7 days", "Last 30 days", "Month to date"]);
    await page.getByRole("option", { name: "Month to date" }).click();
    await expect.poll(() => router.state.location.search).toMatchObject({ period: "mtd" });
    await expect
      .poll(() => api.requests.filter((path) => path.includes("/overview/traffic?period=mtd")))
      .toHaveLength(1);
    await expect
      .element(
        page
          .getByRole("region", { name: "AI cost" })
          .getByRole("link", { name: "AI", exact: true }),
      )
      .toHaveAttribute("href", `${P}/ai?period=mtd`);
  });

  test("an address with Year to date opens the default period", async () => {
    const api = installFakeApi();
    renderApp(`${P}/overview?period=ytd`);
    await expect.element(period()).toMatchTextContent(/^Last 7 days/);
    await expect
      .poll(() => api.requests.some((path) => path.includes("/overview/traffic?period=7d")))
      .toBe(true);
  });
});

describe("links from Web analytics", () => {
  test("a heatmap keeps Month to date as the period", async () => {
    installFakeApi();
    const router = renderApp(`${P}/web-analytics?period=mtd`);
    await page.getByRole("link", { name: "Heatmap of /pricing" }).click();
    await expect.poll(() => router.state.location.pathname).toBe(`${P}/heatmaps`);
    expect(router.state.location.search).toMatchObject({ period: "mtd", path: "/pricing" });
  });

  test("an event's page keeps Yesterday as the period", async () => {
    installFakeApi();
    const router = renderApp(`${P}/web-analytics?period=yesterday`);
    await page.getByRole("link", { name: "Open the signup event" }).click();
    await expect.poll(() => router.state.location.pathname).toBe(`${P}/product/events/signup`);
    expect(router.state.location.search).toMatchObject({ period: "yesterday" });
  });
});
