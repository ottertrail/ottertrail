import { afterEach, describe, expect, test } from "vite-plus/test";
import { page } from "vite-plus/test/browser/context";

import { analyticsFixture, FAKE_SHARE_TOKEN, installFakeApi, PROJECT } from "./fake-api.ts";
import { currentPath, renderApp, renderShare } from "./render.tsx";

/*
 * The Channels, Hostnames, Terms, Content, and browser version lists, and
 * the exit rate (docs/web-analytics.md, "Breakdowns"), with their filter
 * links, on the dashboard and on a shared link.
 */

const ANALYTICS = `/projects/${PROJECT.id}/web-analytics`;
const SHARED = `/share/${FAKE_SHARE_TOKEN}`;

afterEach(async () => {
  await page.viewport(1280, 900);
});

const views = (title: string) =>
  page.getByRole("group", { name: `Which ${title.toLowerCase()} to list` });

/** A cell's text, without the label a stacked breakdown row shows on a phone. */
function cellText(cell: HTMLTableCellElement): string {
  const label = cell.querySelector("[data-slot=breakdown-label]")?.textContent ?? "";
  const text = cell.textContent ?? "";
  return text.startsWith(label) ? text.slice(label.length) : text;
}

/** Each body row of a table as its cells' text, leaving out the cell that only holds a bar. */
function tableRows(caption: string): string[][] {
  const table = page.getByRole("table", { name: caption }).element();
  if (!(table instanceof HTMLTableElement)) throw new Error(`No table ${caption}`);
  return [...(table.tBodies[0]?.rows ?? [])].map((row) =>
    [...row.cells]
      .filter((cell) => cell.querySelector("[data-slot=breakdown-bar]") === null)
      .map(cellText),
  );
}

describe("the new lists", () => {
  test("Channels list the kinds of source, and a row filters by its channel", async () => {
    installFakeApi();
    const router = renderApp(ANALYTICS);

    await views("Sources").getByRole("button", { name: "Channels" }).click();
    await expect
      .element(page.getByRole("table", { name: "Channels, most visitors first" }))
      .toBeVisible();
    expect(tableRows("Channels, most visitors first").map((row) => row[0])).toEqual([
      "Direct",
      "Organic search",
      "Email",
      "AI assistants",
    ]);
    await page.getByRole("link", { name: "Filter by Channel: Organic search" }).click();
    await expect.poll(() => currentPath(router)).toBe(`${ANALYTICS}?channel=Organic+search`);
    await expect
      .element(page.getByRole("list", { name: "Filters" }))
      .toHaveTextContent("Channel is Organic search");
  });

  test("Hostnames list the sites, with Unknown for visits stored before hostnames were kept", async () => {
    installFakeApi();
    const router = renderApp(ANALYTICS);

    await expect
      .element(page.getByRole("table", { name: "Hostnames, most visitors first" }))
      .toBeVisible();
    expect(tableRows("Hostnames, most visitors first").map((row) => row[0])).toEqual([
      "shop.example",
      "docs.shop.example",
      "Unknown",
    ]);
    await page.getByRole("link", { name: "Filter by Hostname: Unknown" }).click();
    await expect.poll(() => currentPath(router)).toBe(`${ANALYTICS}?hostname=`);
    await page.getByRole("link", { name: "Filter by Hostname: docs.shop.example" }).click();
    await expect.poll(() => currentPath(router)).toBe(`${ANALYTICS}?hostname=docs.shop.example`);
  });

  test("Term and Content sit beside Campaign, with No term and No content as values", async () => {
    installFakeApi();
    const router = renderApp(ANALYTICS);

    await views("Campaigns").getByRole("button", { name: "Term", exact: true }).click();
    expect(tableRows("Term, most visitors first").map((row) => row[0])).toEqual([
      "No term",
      "web analytics",
    ]);
    await page.getByRole("link", { name: "Filter by Term: web analytics" }).click();
    await expect.poll(() => currentPath(router)).toBe(`${ANALYTICS}?utmTerm=web+analytics`);

    await views("Campaigns").getByRole("button", { name: "Content" }).click();
    await page.getByRole("link", { name: "Filter by Content: No content" }).click();
    await expect.poll(() => currentPath(router)).toContain("utmContent=");
    await expect
      .element(page.getByRole("list", { name: "Filters" }))
      .toHaveTextContent("Term is web analyticsContent is No content");
  });

  test("a browser's row drills down to its versions", async () => {
    installFakeApi();
    const router = renderApp(`${ANALYTICS}?browser=Firefox`);

    await views("Devices").getByRole("button", { name: "Browsers" }).click();
    const table = page.getByRole("table", { name: "Browsers, most visitors first" });
    await expect.element(table).toBeVisible();
    expect(table.element().querySelector("thead th")?.textContent).toBe("Firefox version");
    expect(tableRows("Browsers, most visitors first").map((row) => row[0])).toEqual([
      "Firefox 133",
      "Firefox 132",
    ]);
    await page.getByRole("link", { name: "Filter by Browser version: Firefox 133" }).click();
    await expect
      .poll(() => currentPath(router))
      .toBe(`${ANALYTICS}?browser=Firefox&browserVersion=Firefox+133`);
  });

  test("without a browser filter, Browsers lists the browsers", async () => {
    installFakeApi();
    renderApp(ANALYTICS);

    await views("Devices").getByRole("button", { name: "Browsers" }).click();
    expect(tableRows("Browsers, most visitors first").map((row) => row[0])).toEqual(["Firefox"]);
  });
});

describe("the UTM lists", () => {
  test("list every tag alone in the Campaigns card, each row a filter", async () => {
    installFakeApi();
    const router = renderApp(ANALYTICS);

    await views("Campaigns").getByRole("button", { name: "Source", exact: true }).click();
    expect(tableRows("Source, most visitors first").map((row) => row[0])).toEqual([
      "No source",
      "newsletter",
      "google",
    ]);
    await page.getByRole("link", { name: "Filter by UTM source: newsletter" }).click();
    await expect.poll(() => currentPath(router)).toBe(`${ANALYTICS}?utmSource=newsletter`);

    await views("Campaigns").getByRole("button", { name: "Medium", exact: true }).click();
    expect(tableRows("Medium, most visitors first").map((row) => row[0])).toEqual([
      "No medium",
      "email",
      "cpc",
    ]);
    await page.getByRole("link", { name: "Filter by UTM medium: cpc" }).click();
    await expect
      .poll(() => currentPath(router))
      .toBe(`${ANALYTICS}?utmSource=newsletter&utmMedium=cpc`);
  });

  test("Sources says what a source is", async () => {
    installFakeApi();
    renderApp(ANALYTICS);
    await expect
      .element(
        page.getByText(
          "A visit's source is its utm_source tag (or ref), else the referrer's site, else Direct / none.",
        ),
      )
      .toBeVisible();
  });
});

const breakdownRow = ([value, visitors]: [string | null, number]) => ({
  value,
  visitors,
  visits: visitors,
  bounceRate: 0.5,
});

/** The answer for a page filtered by one source, as the API counts its drill-down. */
function sourceDetail(sourceKind: [string, number][], referrer: [string | null, number][]) {
  const base = analyticsFixture();
  return () =>
    analyticsFixture({
      breakdowns: {
        ...base.breakdowns,
        sourceKind: sourceKind.map(breakdownRow),
        referrer: referrer.map(breakdownRow),
        utmMedium: [breakdownRow(["email", 70])],
        utmCampaign: [breakdownRow(["november-picks", 70])],
      },
    });
}

describe("one source's drill-down", () => {
  test("a referrer-only source shows how it came and its referrers, no tag lists", async () => {
    installFakeApi({
      analytics: sourceDetail([["referrer", 145]], [["https://www.google.com/", 145]]),
    });
    const router = renderApp(`${ANALYTICS}?source=google.com`);

    const group = views("Sources");
    await expect.element(group).toBeVisible();
    expect(
      group
        .getByRole("button")
        .elements()
        .map((button) => button.textContent),
    ).toEqual(["How", "Referrers", "Channels"]);
    await expect
      .element(page.getByText("google.com: how its visits got this source, and their referrers."))
      .toBeVisible();
    expect(tableRows("How, most visitors first").map((row) => row[0])).toEqual(["Referrer"]);
    await group.getByRole("button", { name: "Referrers" }).click();
    await page.getByRole("link", { name: "Filter by Referrer: www.google.com/" }).click();
    await expect
      .poll(() => currentPath(router))
      .toBe(`${ANALYTICS}?source=google.com&referrer=https%3A%2F%2Fwww.google.com%2F`);
  });

  test("a tagged-only source adds its medium and campaign", async () => {
    installFakeApi({ analytics: sourceDetail([["tag", 70]], [[null, 70]]) });
    const router = renderApp(`${ANALYTICS}?source=newsletter`);

    const group = views("Sources");
    await expect.element(group).toBeVisible();
    expect(
      group
        .getByRole("button")
        .elements()
        .map((button) => button.textContent),
    ).toEqual(["How", "Referrers", "Medium", "Campaign", "Channels"]);
    expect(tableRows("How, most visitors first").map((row) => row[0])).toEqual([
      "Tagged (utm_source or ref)",
    ]);
    await page
      .getByRole("link", { name: "Filter by Source from: Tagged (utm_source or ref)" })
      .click();
    await expect
      .poll(() => currentPath(router))
      .toBe(`${ANALYTICS}?source=newsletter&sourceKind=tag`);
    await group.getByRole("button", { name: "Referrers" }).click();
    expect(tableRows("Referrers, most visitors first").map((row) => row[0])).toEqual([
      "No referrer",
    ]);
    await group.getByRole("button", { name: "Medium" }).click();
    expect(tableRows("Medium, most visitors first").map((row) => row[0])).toEqual(["email"]);
  });

  test("a mixed source lists both ways", async () => {
    installFakeApi({
      analytics: sourceDetail(
        [
          ["referrer", 20],
          ["tag", 5],
        ],
        [
          ["https://chatgpt.com/", 20],
          [null, 5],
        ],
      ),
    });
    renderApp(`${ANALYTICS}?source=chatgpt.com`);

    await expect.element(views("Sources")).toBeVisible();
    expect(tableRows("How, most visitors first")).toEqual([
      ["Referrer", "20", "20"],
      ["Tagged (utm_source or ref)", "5", "5"],
    ]);
  });

  test("Direct / none says it has no tag and no referrer from another site", async () => {
    installFakeApi({
      analytics: sourceDetail(
        [["none", 300]],
        [
          [null, 280],
          ["https://shop.example/pricing", 20],
        ],
      ),
    });
    renderApp(`${ANALYTICS}?source=${encodeURIComponent("Direct / none")}`);

    await expect.element(views("Sources")).toBeVisible();
    expect(tableRows("How, most visitors first").map((row) => row[0])).toEqual([
      "No tag, no referrer",
    ]);
    await expect
      .element(
        page.getByText(
          "Direct / none: visits with no utm_source or ref tag and no referrer from another site.",
        ),
      )
      .toBeVisible();
  });

  test.each([
    "source.not=google.com",
    "source=google.com&source=newsletter",
    "source.contains=goo",
  ])("only one source with is drills down, not %s", async (query) => {
    installFakeApi();
    renderApp(`${ANALYTICS}?${query}`);
    const group = views("Sources");
    await expect.element(group).toBeVisible();
    expect(
      group
        .getByRole("button")
        .elements()
        .map((button) => button.textContent),
    ).toEqual(["Sources", "Channels"]);
  });

  test("works on a shared link and fits a phone", async () => {
    await page.viewport(390, 844);
    installFakeApi({
      signedIn: false,
      analytics: sourceDetail([["referrer", 145]], [["https://www.google.com/", 145]]),
    });
    const history = renderShare(`${SHARED}?source=google.com`);

    const group = views("Sources");
    await expect.element(group).toBeVisible();
    expect(group.element().getBoundingClientRect().right).toBeLessThanOrEqual(390);
    await group.getByRole("button", { name: "Referrers" }).click();
    await page.getByRole("link", { name: "Filter by Referrer: www.google.com/" }).click();
    expect(history.location.pathname).toBe(SHARED);
    expect(history.location.search).toBe(
      "?source=google.com&referrer=https%3A%2F%2Fwww.google.com%2F",
    );
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
  });
});

describe("the exit rate", () => {
  test("is a column of the Exit list and of its Show all", async () => {
    installFakeApi({
      analytics: () =>
        analyticsFixture({
          breakdowns: {
            ...analyticsFixture().breakdowns,
            exitPage: Array.from({ length: 10 }, (_, i) => ({
              value: `/page-${i + 1}`,
              visitors: 100 - i,
              visits: 100 - i,
              bounceRate: 0.5,
              exitRate: i === 0 ? 0.42 : 0.1,
            })),
          },
        }),
    });
    renderApp(ANALYTICS);

    await views("Pages").getByRole("button", { name: "Exit" }).click();
    const exits = page.getByRole("table", { name: "Exit, most visitors first" });
    await expect.element(exits).toBeVisible();
    const headings = [...exits.element().querySelectorAll("thead th")].map((th) =>
      th.textContent?.trim(),
    );
    expect(headings).toContain("Exits");
    expect(headings).toContain("Exit rate");
    expect(tableRows("Exit, most visitors first")[0]).toEqual(["/page-1", "100", "100", "42%"]);

    await page.getByRole("button", { name: "Show all exit" }).click();
    const dialog = page.getByRole("dialog", { name: "Pages: Exit" });
    await expect.element(dialog.getByRole("columnheader", { name: "Exit rate" })).toBeVisible();
    await expect.element(dialog.getByText("25%").first()).toBeVisible();
  });

  test("gives way to the goal's figures under a goal", async () => {
    installFakeApi();
    renderApp(`${ANALYTICS}?goalEvent=signup`);

    await views("Pages").getByRole("button", { name: "Exit" }).click();
    const exits = page.getByRole("table", { name: "Exit, most converted first" });
    await expect.element(exits).toBeVisible();
    expect(exits.element().textContent).not.toContain("Exit rate");
  });
});

describe("on a phone, 390 wide", () => {
  test("the toggles and lists fit, and nothing scrolls sideways", async () => {
    await page.viewport(390, 844);
    installFakeApi();
    renderApp(ANALYTICS);

    for (const title of ["Pages", "Sources", "Campaigns", "Locations", "Devices"]) {
      const group = views(title);
      await expect.element(group).toBeVisible();
      expect(group.element().getBoundingClientRect().right).toBeLessThanOrEqual(390);
    }
    await views("Pages").getByRole("button", { name: "Exit" }).click();
    await expect
      .element(page.getByRole("table", { name: "Exit, most visitors first" }))
      .toBeVisible();
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
    const content = document.querySelector("[data-slot=app-content]");
    expect(content?.scrollWidth).toBeLessThanOrEqual(content?.clientWidth ?? 0);
  });
});

describe("a shared link", () => {
  test("shows the new lists, and their rows filter the shared page", async () => {
    await page.viewport(390, 844);
    installFakeApi({ signedIn: false });
    const history = renderShare(SHARED);

    await views("Sources").getByRole("button", { name: "Channels" }).click();
    await page.getByRole("link", { name: "Filter by Channel: Email" }).click();
    expect(history.location.pathname).toBe(SHARED);
    expect(history.location.search).toBe("?channel=Email");

    await views("Campaigns").getByRole("button", { name: "Term", exact: true }).click();
    await expect
      .element(page.getByRole("link", { name: "Filter by Term: web analytics" }))
      .toBeVisible();
    await expect
      .element(page.getByRole("link", { name: "Filter by Hostname: docs.shop.example" }))
      .toBeVisible();
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
  });
});
