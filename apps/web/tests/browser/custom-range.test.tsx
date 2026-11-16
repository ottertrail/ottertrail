import { describe, expect, test } from "vite-plus/test";
import { page } from "vite-plus/test/browser/context";

import {
  analyticsFixture,
  type FakeApi,
  installFakeApi,
  OTHER_PROJECT,
  PROJECT,
} from "./fake-api.ts";
import { renderApp } from "./render.tsx";

const ANALYTICS = `/projects/${PROJECT.id}/web-analytics`;

/** The query of the page's latest request to `path`, such as { from: "…", to: "…" }. */
function lastQuery(api: FakeApi, path = "/analytics?"): Record<string, string> {
  const request = api.requests.findLast((item) => item.includes(path)) ?? "";
  return Object.fromEntries(new URLSearchParams(request.slice(request.indexOf("?") + 1)));
}
const addressQuery = (router: ReturnType<typeof renderApp>) => router.state.location.search;

describe("a custom range", () => {
  test("is read from the address and sent instead of a period", async () => {
    const api = installFakeApi();
    renderApp(`${ANALYTICS}?from=2026-10-01&to=2026-10-31&country=DE`);

    await expect
      .poll(() => lastQuery(api))
      .toEqual({ from: "2026-10-01", to: "2026-10-31", country: "DE" });
    await expect
      .element(page.getByRole("combobox", { name: "Period" }))
      .toMatchTextContent(/^Custom range/);
  });

  test("is chosen in a dialog that starts from the page's days, and keeps the filters", async () => {
    const api = installFakeApi();
    const router = renderApp(`${ANALYTICS}?country=DE`);
    await expect.element(page.getByText("10–16 Nov 2026 · Asia/Singapore")).toBeVisible();

    await page.getByRole("combobox", { name: "Period" }).click();
    await page.getByRole("option", { name: "Custom range…" }).click();

    await expect.element(page.getByRole("dialog", { name: "Custom range" })).toBeVisible();
    await expect.element(page.getByLabelText("First day")).toHaveValue("2026-11-10");
    await expect.element(page.getByLabelText("Last day")).toHaveValue("2026-11-16");
    await page.getByLabelText("First day").fill("2026-10-01");
    await page.getByLabelText("Last day").fill("2026-10-31");
    await page.getByRole("button", { name: "Show these days" }).click();

    await expect
      .poll(() => addressQuery(router))
      .toEqual({ from: "2026-10-01", to: "2026-10-31", country: "DE" });
    await expect
      .poll(() => lastQuery(api))
      .toEqual({ from: "2026-10-01", to: "2026-10-31", country: "DE" });
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  });

  test("refuses days the API would refuse", async () => {
    installFakeApi();
    renderApp(ANALYTICS);
    await page.getByRole("combobox", { name: "Period" }).click();
    await page.getByRole("option", { name: "Custom range…" }).click();
    const apply = page.getByRole("button", { name: "Show these days" });

    await page.getByLabelText("First day").fill("2026-11-16");
    await page.getByLabelText("Last day").fill("2026-11-01");
    await expect.element(page.getByText("The last day is before the first.")).toBeVisible();
    await expect.element(apply).toBeDisabled();

    await page.getByLabelText("First day").fill("2025-01-01");
    await page.getByLabelText("Last day").fill("2026-11-16");
    await expect.element(page.getByText("A range covers at most 366 days.")).toBeVisible();
    await expect.element(apply).toBeDisabled();
  });

  test("Cancel keeps the period", async () => {
    installFakeApi();
    const router = renderApp(`${ANALYTICS}?period=30d`);
    await page.getByRole("combobox", { name: "Period" }).click();
    await page.getByRole("option", { name: "Custom range…" }).click();

    await page.getByRole("button", { name: "Cancel" }).click();

    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    expect(addressQuery(router)).toEqual({ period: "30d" });
    await expect
      .element(page.getByRole("combobox", { name: "Period" }))
      .toMatchTextContent(/^Last 30 days/);
  });

  test("a preset period replaces it", async () => {
    const api = installFakeApi();
    const router = renderApp(`${ANALYTICS}?from=2026-10-01&to=2026-10-31`);

    await page.getByRole("combobox", { name: "Period" }).click();
    await page.getByRole("option", { name: "Last 90 days" }).click();

    await expect.poll(() => addressQuery(router)).toEqual({ period: "90d" });
    await expect.poll(() => lastQuery(api)).toEqual({ period: "90d" });
  });

  test("days the API would refuse in the address fall back to the last 7 days", async () => {
    const api = installFakeApi();
    renderApp(`${ANALYTICS}?from=2026-02-30&to=2026-03-05`);

    await expect.poll(() => lastQuery(api)).toEqual({ period: "7d" });
    await expect
      .element(page.getByRole("combobox", { name: "Period" }))
      .toMatchTextContent(/^Last 7 days/);
  });

  test("Show all and the project switcher keep it", async () => {
    const api = installFakeApi({
      projects: [PROJECT, OTHER_PROJECT],
      analytics: () =>
        analyticsFixture({
          pages: Array.from({ length: 10 }, (_, i) => ({
            path: `/page-${i + 1}`,
            pageviews: 90 - i,
            visitors: 50 - i,
            avgEngagedMs: null,
          })),
        }),
    });
    const router = renderApp(`${ANALYTICS}?from=2026-10-01&to=2026-10-31`);

    await page.getByRole("button", { name: "Show all top pages" }).click();
    await expect
      .poll(() => lastQuery(api, "/analytics/list?"))
      .toMatchObject({ from: "2026-10-01", to: "2026-10-31", report: "pages" });
    await page.getByRole("button", { name: "Close" }).click();

    await page.getByRole("button", { name: "Project: Main site. Switch project" }).click();
    await page.getByRole("menuitem", { name: "Docs" }).click();
    await expect.poll(() => addressQuery(router)).toEqual({ from: "2026-10-01", to: "2026-10-31" });
    expect(router.state.location.pathname).toBe(`/projects/${OTHER_PROJECT.id}/web-analytics`);
  });
});
