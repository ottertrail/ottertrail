import { describe, expect, test } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser/context";

import { analyticsFixture, type FakeApi, installFakeApi, PROJECT } from "./fake-api.ts";
import { renderApp } from "./render.tsx";

const ANALYTICS = `/projects/${PROJECT.id}/web-analytics`;

/** The page's analytics with 10 top pages: a full list, which may have more. */
const fullPages = () =>
  analyticsFixture({
    pages: Array.from({ length: 10 }, (_, i) => ({
      path: `/page-${i + 1}`,
      pageviews: 900 - i,
      visitors: 500 - i,
      avgEngagedMs: null,
    })),
  });

/** The query of the latest list request, such as { report: "pages", offset: "0" }. */
function lastListQuery(api: FakeApi): Record<string, string> {
  const path = api.requests.findLast((request) => request.includes("/analytics/list?")) ?? "";
  return Object.fromEntries(new URLSearchParams(path.slice(path.indexOf("?") + 1)));
}

/** The dialog's rows, by name. */
function dialogRows(): string[] {
  const dialog = document.querySelector("[role=dialog]");
  return [...(dialog?.querySelectorAll("tbody tr") ?? [])].map(
    (row) => row.querySelector("td")?.textContent ?? "",
  );
}

describe("show all", () => {
  test("is offered under a full list, not under a shorter one", async () => {
    installFakeApi({ analytics: fullPages });
    renderApp(ANALYTICS);

    await expect.element(page.getByRole("button", { name: "Show all top pages" })).toBeVisible();
    await page.getByRole("tab", { name: "Countries" }).click();
    await expect
      .element(page.getByRole("button", { name: "Show all countries" }))
      .not.toBeInTheDocument();
  });

  test("shows the list in full, 50 rows at a time", async () => {
    const api = installFakeApi({ analytics: fullPages });
    renderApp(ANALYTICS);

    await page.getByRole("button", { name: "Show all top pages" }).click();

    await expect.element(page.getByRole("dialog", { name: "Pages: Top pages" })).toBeVisible();
    await expect.poll(() => dialogRows().length).toBe(50);
    expect(lastListQuery(api)).toEqual({ period: "7d", report: "pages", offset: "0", limit: "50" });

    await page.getByRole("button", { name: "Load more" }).click();
    await expect.poll(() => dialogRows().length).toBe(100);
    expect(lastListQuery(api)).toMatchObject({ offset: "50" });

    await page.getByRole("button", { name: "Load more" }).click();
    await expect.poll(() => dialogRows().length).toBe(120);
    expect(dialogRows().at(-1)).toBe("/page-120");
    await expect.element(page.getByRole("button", { name: "Load more" })).not.toBeInTheDocument();
  });

  test("searches by name", async () => {
    const api = installFakeApi({ analytics: fullPages });
    renderApp(ANALYTICS);
    await page.getByRole("button", { name: "Show all top pages" }).click();
    await expect.poll(() => dialogRows().length).toBe(50);

    await page.getByRole("searchbox", { name: "Search pages: top pages" }).fill("page-11");

    await expect.poll(() => lastListQuery(api)).toMatchObject({ search: "page-11", offset: "0" });
    await expect
      .poll(dialogRows)
      .toEqual(["/page-11", ...Array.from({ length: 10 }, (_, i) => `/page-${110 + i}`)]);

    await page.getByRole("searchbox", { name: "Search pages: top pages" }).fill("nothing like it");
    await expect.element(page.getByText("Nothing matches “nothing like it”.")).toBeVisible();
  });

  test("a row filters the page by it, and closes the list", async () => {
    installFakeApi({ analytics: fullPages });
    const router = renderApp(ANALYTICS);
    await page.getByRole("button", { name: "Show all top pages" }).click();
    await expect.poll(() => dialogRows().length).toBe(50);

    await page.getByRole("link", { name: "Filter by Page: /page-42" }).click();

    await expect.poll(() => router.state.location.search).toEqual({ page: "/page-42" });
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  });

  test("uses the page's period and filters", async () => {
    const api = installFakeApi({ analytics: fullPages });
    renderApp(`${ANALYTICS}?period=30d&country=DE`);

    await page.getByRole("button", { name: "Show all top pages" }).click();

    await expect
      .poll(() => lastListQuery(api))
      .toMatchObject({ period: "30d", country: "DE", report: "pages" });
    await expect
      .element(page.getByText("Every row for this period and these filters, most visitors first."))
      .toBeVisible();
  });

  test("Escape closes it", async () => {
    installFakeApi({ analytics: fullPages });
    renderApp(ANALYTICS);
    await page.getByRole("button", { name: "Show all top pages" }).click();
    await expect.element(page.getByRole("dialog")).toBeVisible();

    await userEvent.keyboard("{Escape}");

    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  });
});
