import { describe, expect, test } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser/context";

import { analyticsFixture, fakeErrors, fakeTraces, installFakeApi, PROJECT } from "./fake-api.ts";
import { renderApp } from "./render.tsx";

/*
 * Cut-off text on real screens shows in full in a tooltip (TruncatedText,
 * docs/design-system.md "Truncated text"), never in a native title.
 */

const tooltip = () => document.querySelector<HTMLElement>("[data-slot=tooltip-content]");
const tooltipText = () => tooltip()?.textContent ?? null;

describe("cut-off text in a tooltip", () => {
  test("the Projects list's allowed sites: one hostname per line", async () => {
    await page.viewport(1440, 900);
    const hosts = [
      "demo-shop.example",
      "www.demo-shop.example",
      "staging.demo-shop.example",
      "preview.demo-shop.example",
    ];
    installFakeApi({ projects: [{ ...PROJECT, allowedHostnames: hosts }] });
    renderApp("/projects");
    const cell = page.getByText(hosts.join(", "));
    await expect.element(cell).toBeVisible();
    const element = cell.element() as HTMLElement;
    expect(element.hasAttribute("title")).toBe(false);
    // Cut off, it takes a tab stop, and its tooltip lists each hostname on its own line.
    await expect.poll(() => element.getAttribute("tabindex")).toBe("0");
    await cell.hover();
    await expect.poll(tooltip).not.toBeNull();
    const lines = [...(tooltip()?.querySelectorAll("span > span") ?? [])];
    expect(lines.map((line) => line.textContent)).toEqual(hosts);
    const tops = lines.map((line) => line.getBoundingClientRect().top);
    expect(new Set(tops).size).toBe(hosts.length);
  });

  test("a breakdown table's path: the filter link's hover and focus show it", async () => {
    await page.viewport(1440, 900);
    const path = `/blog/${"a-very-long-article-slug-".repeat(5)}final`;
    installFakeApi({
      analytics: (_projectId, _period, _query, api) => {
        const analytics = analyticsFixture({ goals: api.goals });
        return {
          ...analytics,
          pages: [
            { path, pageviews: 900, visitors: 700, avgEngagedMs: 20_000 },
            ...analytics.pages,
          ],
        };
      },
    });
    renderApp(`/projects/${PROJECT.id}/web-analytics`);
    const link = page.getByRole("link", { name: `Filter by Page: ${path}`, exact: true });
    await expect.element(link).toBeVisible();
    // The name's link is the only tab stop: the cut-off text around it adds none.
    const name = link.element().closest<HTMLElement>("[data-truncated-text]");
    expect(name).not.toBeNull();
    expect(name?.getAttribute("tabindex")).toBeNull();
    expect(name?.hasAttribute("title")).toBe(false);
    // The link runs on under the ellipsis: the pointer goes to the part that shows.
    await userEvent.hover(name ?? document.body);
    await expect.poll(tooltipText).toBe(path);
    await page.getByRole("heading", { name: "Pages" }).hover();
    await expect.poll(tooltip).toBeNull();

    // On keyboard focus too.
    await userEvent.keyboard("{Shift}");
    (link.element() as HTMLElement).focus();
    await expect.poll(tooltipText).toBe(path);
  });

  test("a workbench row's title: the row's link is the trigger", async () => {
    await page.viewport(1440, 900);
    const long = `POST /api/v1/${"organizations/{organizationId}/".repeat(4)}charge`;
    installFakeApi({
      traces: (query) => {
        const list = fakeTraces(query);
        return {
          ...list,
          traces: list.traces.map((trace, i) => (i === 0 ? { ...trace, name: long } : trace)),
        };
      },
    });
    renderApp(`/projects/${PROJECT.id}/traces`);
    const link = page.getByRole("link", { name: long }).first();
    await expect.element(link).toBeVisible();
    const element = link.element() as HTMLElement;
    expect(element.hasAttribute("title")).toBe(false);
    expect(element.getAttribute("tabindex")).toBeNull();
    await link.hover();
    await expect.poll(tooltipText).toBe(long);
  });

  test("an error's message, clamped to two lines in the errors list", async () => {
    await page.viewport(1440, 900);
    const message =
      `Cannot read properties of undefined (reading 'id') ${"while rendering the checkout summary for a returning customer ".repeat(4)}`.trim();
    installFakeApi({
      errors: (query, api) => {
        const list = fakeErrors(query, api);
        return {
          ...list,
          groups: list.groups.map((group, i) => (i === 0 ? { ...group, message } : group)),
        };
      },
    });
    renderApp(`/projects/${PROJECT.id}/errors`);
    const link = page.getByRole("link", { name: `TypeError: ${message}`, exact: true });
    await expect.element(link).toBeVisible();
    const element = link.element() as HTMLElement;
    expect(element.hasAttribute("title")).toBe(false);
    // Clamped, not cut to one line: two lines of it show.
    expect(element.getBoundingClientRect().height).toBeGreaterThan(30);
    await link.hover();
    await expect.poll(tooltipText).toBe(`TypeError: ${message}`);
  });
});
