import { afterEach, describe, expect, test } from "vite-plus/test";
import { page } from "vite-plus/test/browser/context";

import { installFakeApi } from "./fake-api.ts";
import { renderApp } from "./render.tsx";

/*
 * The design system's reference page renders the current blocks with
 * labelled sample content: the ones screen-patterns.test.tsx does not walk
 * through (the report chart, pinned columns, the missing value, key hints,
 * the toggle groups), and the page as a whole at 390 and 1440.
 */

const REFERENCE = "/design-system";

afterEach(async () => {
  await page.viewport(1280, 900);
});

describe("the reference page", () => {
  test("has every section and pattern, and says its content is sample data", async () => {
    installFakeApi();
    renderApp(REFERENCE);

    for (const name of [
      "Color",
      "Typography",
      "Shape and spacing",
      "Components",
      "Screen patterns",
    ]) {
      await expect.element(page.getByRole("heading", { level: 2, name })).toBeVisible();
    }
    await expect
      .element(page.getByText(/Every name, figure, and address in an example/))
      .toBeVisible();
    // Each block with made-up content says so.
    expect(page.getByText("Sample data", { exact: true }).elements().length).toBeGreaterThanOrEqual(
      9,
    );
    // The blocks themselves, by what they render.
    expect(document.querySelector("search[aria-label='Report filters']")).not.toBeNull();
    await expect.element(page.getByRole("region", { name: "Pages" })).toBeVisible();
    await expect
      .element(page.getByRole("region", { name: "Visitors per day", exact: true }))
      .toBeVisible();
    await expect.element(page.getByRole("tablist", { name: "Example settings" })).toBeVisible();
    await expect
      .element(page.getByRole("region", { name: "Example errors, summary" }))
      .toBeVisible();
  });

  test("the report chart switches its figure with a toggle group, and shows its numbers on request", async () => {
    installFakeApi();
    renderApp(REFERENCE);
    const chart = page.getByRole("region", { name: "Visitors per day", exact: true });
    const which = chart.getByRole("group", { name: "Which figure to chart" });
    await expect
      .element(which.getByRole("button", { name: "Visitors" }))
      .toHaveAttribute("aria-pressed", "true");

    await chart.getByRole("button", { name: "Show the numbers" }).click();
    const numbers = chart.getByRole("table", { name: "Visitors per day, sample data" });
    await expect.element(numbers).toBeVisible();
    await expect.element(numbers.getByRole("cell", { name: "154" })).toBeVisible();

    await which.getByRole("button", { name: "Pageviews" }).click();
    const pageviews = page.getByRole("region", { name: "Pageviews per day", exact: true });
    await expect.element(pageviews).toBeVisible();
    await expect
      .element(pageviews.getByRole("button", { name: "Pageviews" }))
      .toHaveAttribute("aria-pressed", "true");
    await expect.element(pageviews.getByRole("cell", { name: "386" })).toBeVisible();
    await pageviews.getByRole("button", { name: "Hide the numbers" }).click();
    await expect.element(pageviews.getByRole("table")).not.toBeInTheDocument();
  });

  test("a missing value shows the dash and reads out what is missing", async () => {
    installFakeApi();
    renderApp(REFERENCE);
    const hosts = page.getByRole("table", { name: "Sample hosts, with a scroll hint on a phone" });
    const missing = hosts.getByRole("cell", { name: "Not sent" });
    await expect.element(missing).toBeVisible();
    expect(missing.element().querySelector("[aria-hidden=true]")?.textContent).toBe("–");
  });

  test("key hints name each key, and the status toggle group says which list it shows", async () => {
    installFakeApi();
    renderApp(REFERENCE);
    const hints = page.getByRole("list", { name: "Key hints" });
    await expect.element(hints).toMatchTextContent(/^jk\s*move through a list/);
    expect(hints.element().querySelectorAll("[data-slot=kbd]").length).toBe(6);

    const which = page.getByRole("group", { name: "Which errors to list" });
    await which.getByRole("button", { name: "Resolved" }).click();
    await expect
      .element(which.getByRole("button", { name: "Resolved" }))
      .toHaveAttribute("aria-pressed", "true");
    await expect
      .element(which.getByRole("button", { name: "Unresolved" }))
      .toHaveAttribute("aria-pressed", "false");
    await expect.element(page.getByText("Only resolved errors are listed.")).toBeVisible();
  });
});

describe("the reference page fits", () => {
  test("at 390 nothing scrolls sideways but the sample table, whose host and action stay pinned", async () => {
    await page.viewport(390, 844);
    installFakeApi();
    renderApp(REFERENCE);
    const hosts = page.getByRole("table", { name: "Sample hosts, with a scroll hint on a phone" });
    await expect.element(hosts).toBeInTheDocument();

    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
    const content = document.querySelector("[data-slot=app-content]");
    expect(content?.scrollWidth).toBeLessThanOrEqual(content?.clientWidth ?? 0);
    const container = hosts.element().closest<HTMLElement>("[data-slot=table-container]");
    expect(container?.scrollWidth ?? 0).toBeGreaterThan(container?.clientWidth ?? 0);
    const first = hosts.getByRole("cell", { name: "web-1" }).element();
    expect(getComputedStyle(first).position).toBe("sticky");
    const action = hosts
      .getByRole("button", { name: "Add an alert rule for web-1" })
      .element()
      .closest("td");
    expect(action === null ? "" : getComputedStyle(action).position).toBe("sticky");
    await expect
      .poll(() => container?.parentElement?.querySelector("[data-slot=scroll-hint]") ?? null)
      .not.toBeNull();
  });

  test("at 1440 the sample table fits, and nothing scrolls sideways", async () => {
    await page.viewport(1440, 900);
    installFakeApi();
    renderApp(REFERENCE);
    const hosts = page.getByRole("table", { name: "Sample hosts, with a scroll hint on a phone" });
    await expect.element(hosts).toBeVisible();

    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(1440);
    const content = document.querySelector("[data-slot=app-content]");
    expect(content?.scrollWidth).toBeLessThanOrEqual(content?.clientWidth ?? 0);
    const container = hosts.element().closest<HTMLElement>("[data-slot=table-container]");
    expect(container?.scrollWidth).toBeLessThanOrEqual(container?.clientWidth ?? 0);
  });
});
