import { afterEach, describe, expect, test } from "vite-plus/test";
import { page } from "vite-plus/test/browser/context";

import {
  ERROR_FINGERPRINTS,
  FAKE_TRACE_ID,
  installFakeApi,
  memberAccess,
  PROJECT,
} from "./fake-api.ts";
import { renderApp } from "./render.tsx";

/* The header's Docs link (app-header.tsx), from the map in lib/docs.ts. */

const DOCS = "https://docs.ottertrail.app";
const docsLink = (topic: string) =>
  page.getByRole("link", { name: `${topic} docs (opens in a new tab)`, exact: true });

/** The header's links that leave for the docs site. */
const docsLinks = () =>
  [...document.querySelectorAll<HTMLAnchorElement>("header a")].filter((link) =>
    link.href.startsWith(DOCS),
  );

afterEach(async () => {
  await page.viewport(1280, 900);
});

describe("at 1440 wide", () => {
  test("a report links to its page, in a new tab that is not told where it came from", async () => {
    await page.viewport(1440, 900);
    installFakeApi();
    renderApp(`/projects/${PROJECT.id}/web-analytics`);

    const link = docsLink("Web analytics");
    await expect.element(link).toBeVisible();
    await expect.element(link).toHaveAttribute("href", `${DOCS}/web-analytics/reports/`);
    await expect.element(link).toHaveAttribute("target", "_blank");
    await expect.element(link).toHaveAttribute("rel", "noopener noreferrer");
    await expect.element(link).toHaveTextContent("Docs");
    // Before the sidebar's shortcut, at the header's end.
    const hint = page.getByText("sidebar", { exact: true });
    await expect.element(hint).toBeVisible();
    expect(link.element().getBoundingClientRect().right).toBeLessThan(
      hint.element().getBoundingClientRect().left,
    );
  });

  test("a list and a detail page link to their own pages", async () => {
    await page.viewport(1440, 900);
    installFakeApi();
    renderApp(`/projects/${PROJECT.id}/errors`);
    await expect.element(docsLink("Errors")).toHaveAttribute("href", `${DOCS}/errors/resolving/`);

    renderApp(`/projects/${PROJECT.id}/errors/${ERROR_FINGERPRINTS.typeError}`);
    await expect
      .element(docsLink("Error"))
      .toHaveAttribute("href", `${DOCS}/errors/resolving/#the-groups-page`);
  });

  test("a trace's page links to the section on a trace", async () => {
    installFakeApi();
    renderApp(`/projects/${PROJECT.id}/traces/${FAKE_TRACE_ID}`);
    await expect
      .element(docsLink("Trace"))
      .toHaveAttribute("href", `${DOCS}/monitoring/traces/#a-trace`);
  });

  test("the instance's Settings link to the tab's page, and follow the tab chosen", async () => {
    installFakeApi();
    renderApp("/settings");
    await expect
      .element(docsLink("Instance settings"))
      .toHaveAttribute("href", `${DOCS}/introduction/instances-and-projects/#the-instance`);

    await page.getByRole("tab", { name: "Storage" }).click();
    await expect
      .element(docsLink("Storage settings"))
      .toHaveAttribute("href", `${DOCS}/self-hosting/storage/`);
    expect(docsLinks()).toHaveLength(1);
  });

  test("a project's Settings tab with a page of its own links to it", async () => {
    installFakeApi();
    renderApp(`/projects/${PROJECT.id}/settings?tab=spam`);
    await expect
      .element(docsLink("Spam and bots settings"))
      .toHaveAttribute("href", `${DOCS}/web-analytics/spam-and-bots/#the-spam-and-bots-tab`);
  });

  test("a screen without a docs page shows no link", async () => {
    installFakeApi({ access: memberAccess({}) });
    renderApp(`/projects/${PROJECT.id}`);
    await expect.element(page.getByText("You don't have access")).toBeVisible();
    expect(docsLinks()).toEqual([]);
  });
});

describe("at 390 wide", () => {
  test("shows the icon only, keeping the link's name", async () => {
    await page.viewport(390, 844);
    installFakeApi();
    renderApp(`/projects/${PROJECT.id}/web-analytics`);

    const link = docsLink("Web analytics");
    await expect.element(link).toBeVisible();
    const word = link.getByText("Docs");
    // The word is there for no one but screen readers, which read the name anyway.
    expect(word.element().getBoundingClientRect().width).toBeLessThanOrEqual(1);
    const box = link.element().getBoundingClientRect();
    expect(box.width).toBe(28);
    expect(box.height).toBe(28);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
  });
});
