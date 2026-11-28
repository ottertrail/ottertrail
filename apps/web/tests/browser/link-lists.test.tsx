import { afterEach, describe, expect, test } from "vite-plus/test";
import { page } from "vite-plus/test/browser/context";

import { analyticsFixture, type FakeApi, installFakeApi, PROJECT, withGoal } from "./fake-api.ts";
import { renderApp } from "./render.tsx";

/*
 * The Outbound links, File downloads, and Not found pages lists of Web
 * analytics (docs/web-analytics.md, "Links and not found pages"). The
 * API's numbers are tested in apps/api/tests/link-lists.test.ts.
 */

const ANALYTICS = `/projects/${PROJECT.id}/web-analytics`;

afterEach(async () => {
  await page.viewport(1280, 900);
});

function lastQuery(api: FakeApi): Record<string, string> {
  const request = api.requests.findLast((item) => item.split("?")[0]?.endsWith("/analytics")) ?? "";
  return Object.fromEntries(new URLSearchParams(request.slice(request.indexOf("?") + 1)));
}

/** A list's rows: each cell's text without its phone label, the bar left out. */
const listRows = (name: string) =>
  [...page.getByRole("table", { name }).element().querySelectorAll("tbody tr")].map((row) =>
    [...row.querySelectorAll("td")]
      .filter((cell) => cell.querySelector("[data-slot=breakdown-bar]") === null)
      .map((cell) =>
        [...cell.childNodes]
          .filter(
            (node) => !(node instanceof Element && node.matches("[data-slot=breakdown-label]")),
          )
          .map((node) => node.textContent)
          .join(""),
      ),
  );

const LISTS = {
  "Outbound links, most visitors first": [
    ["github.com/acme/shop-sdk", "42", "57"],
    ["status.acme.example/", "18", "21"],
    ["www.youtube.com/watch", "9", "9"],
  ],
  "File downloads, most visitors first": [
    ["acme.example/files/price-list.pdf", "36", "41"],
    ["cdn.acme.example/releases/acme-cli-2.4.0.dmg", "12", "12"],
  ],
  "Not found pages, most visitors first": [
    ["/old-pricing", "14", "15"],
    ["/blog/2019/launch", "6", "6"],
  ],
};

describe("the link and not found lists", () => {
  test.each([
    [1440, 900],
    [390, 844],
  ])("show each row's visitors and count at %i pixels, within the page", async (width, height) => {
    await page.viewport(width, height);
    installFakeApi();
    renderApp(ANALYTICS);

    for (const title of ["Outbound links", "File downloads", "Not found pages"]) {
      await expect.element(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
    }
    for (const [name, rows] of Object.entries(LISTS)) {
      expect(listRows(name)).toEqual(rows);
    }
    // Nothing wider than the screen, long links included.
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
  });

  test("a row filters the page by its link, with a chip that names it", async () => {
    const api = installFakeApi();
    const router = renderApp(ANALYTICS);

    await page
      .getByRole("link", { name: "Filter by Outbound link: github.com/acme/shop-sdk" })
      .click();
    await expect
      .element(
        page.getByRole("link", {
          name: "Remove the filter Outbound link: github.com/acme/shop-sdk",
        }),
      )
      .toBeVisible();
    expect(router.state.location.search).toMatchObject({
      outbound: "https://github.com/acme/shop-sdk",
    });
    expect(lastQuery(api)).toMatchObject({ outbound: "https://github.com/acme/shop-sdk" });

    await page.getByRole("link", { name: "Filter by Not found page: /old-pricing" }).click();
    await expect.poll(() => lastQuery(api)).toMatchObject({ notFound: "/old-pricing" });
  });

  test("with a goal, rows show visitors, converted, and rate", async () => {
    installFakeApi({
      analytics: (_projectId, _period, query, api) =>
        withGoal(analyticsFixture({ goals: api.goals }), query, api.goals),
    });
    renderApp(`${ANALYTICS}?goalEvent=signup`);

    const table = page.getByRole("table", { name: "File downloads, most converted first" });
    await expect.element(table).toBeVisible();
    const headings = [...table.element().querySelectorAll("thead th")].map(
      (cell) => cell.textContent,
    );
    expect(headings.slice(-3)).toEqual(["Visitors", "Converted", "Rate"]);
    const [first] = listRows("File downloads, most converted first");
    expect(first?.[0]).toBe("acme.example/files/price-list.pdf");
    expect(first?.[1]).toBe("36");
  });

  test("an empty list says how it fills", async () => {
    installFakeApi({
      analytics: () =>
        analyticsFixture({ outboundLinks: [], fileDownloads: [], notFoundPages: [] }),
    });
    renderApp(ANALYTICS);

    await expect
      .element(page.getByText(/To count them, add <meta name="ottertrail" content="not-found">/))
      .toBeVisible();
    await expect.element(page.getByText(/data-outbound="off"/)).toBeVisible();
    await expect.element(page.getByText(/data-downloads="off"/)).toBeVisible();
  });

  test("Show all lists every link, searched", async () => {
    const api = installFakeApi({
      analytics: () =>
        analyticsFixture({
          outboundLinks: Array.from({ length: 10 }, (_, i) => ({
            value: `https://example.org/outboundLinks-${i + 1}`,
            visitors: 500 - i,
            events: 503 - i,
          })),
        }),
    });
    renderApp(ANALYTICS);

    await page.getByRole("button", { name: "Show all outbound links" }).click();
    await expect.element(page.getByRole("dialog", { name: "Outbound links" })).toBeVisible();
    await expect
      .element(page.getByText("example.org/outboundLinks-50", { exact: true }))
      .toBeVisible();
    expect(api.requests.some((path) => path.includes("report=outboundLinks"))).toBe(true);
  });
});
