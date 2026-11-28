import { afterEach, describe, expect, test } from "vite-plus/test";
import { page } from "vite-plus/test/browser/context";

import { FAKE_SHARE_TOKEN, fakeList, installFakeApi, json, PROJECT } from "./fake-api.ts";
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

/** A table's rows once it shows: a tab's list loads when the tab is selected. */
async function shownRows(caption: string): Promise<string[][]> {
  await expect.element(page.getByRole("table", { name: caption })).toBeVisible();
  return tableRows(caption);
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
    expect((await shownRows("Channels, most visitors first")).map((row) => row[0])).toEqual([
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

    await views("Pages").getByRole("button", { name: "Hostnames" }).click();
    expect((await shownRows("Hostnames, most visitors first")).map((row) => row[0])).toEqual([
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
    expect((await shownRows("Term, most visitors first")).map((row) => row[0])).toEqual([
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
    expect((await shownRows("Browsers, most visitors first")).map((row) => row[0])).toEqual([
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
    expect((await shownRows("Browsers, most visitors first")).map((row) => row[0])).toEqual([
      "Firefox",
    ]);
  });
});

describe("the UTM lists", () => {
  test("list every tag alone in the Campaigns card, each row a filter", async () => {
    installFakeApi();
    const router = renderApp(ANALYTICS);

    await views("Campaigns").getByRole("button", { name: "Source", exact: true }).click();
    expect((await shownRows("Source, most visitors first")).map((row) => row[0])).toEqual([
      "No source",
      "newsletter",
      "google",
    ]);
    await page.getByRole("link", { name: "Filter by UTM source: newsletter" }).click();
    await expect.poll(() => currentPath(router)).toBe(`${ANALYTICS}?utmSource=newsletter`);

    await views("Campaigns").getByRole("button", { name: "Medium", exact: true }).click();
    expect((await shownRows("Medium, most visitors first")).map((row) => row[0])).toEqual([
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

/** The list route for a page filtered by one source, as the API counts its drill-down. */
function sourceDetail(sourceKind: [string, number][], referrer: [string | null, number][]) {
  const lists: Record<string, ReturnType<typeof breakdownRow>[]> = {
    sourceKind: sourceKind.map(breakdownRow),
    referrer: referrer.map(breakdownRow),
    utmMedium: [breakdownRow(["email", 70])],
  };
  return (query: URLSearchParams) => {
    const rows = lists[query.get("report") ?? ""];
    return rows === undefined ? fakeList(query) : { rows, hasMore: false };
  };
}

describe("one source's drill-down", () => {
  test("a referrer-only source shows how it came and its referrers, no tag lists", async () => {
    installFakeApi({
      list: sourceDetail([["referrer", 145]], [["https://www.google.com/", 145]]),
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
    expect((await shownRows("How, most visitors first")).map((row) => row[0])).toEqual([
      "Referrer",
    ]);
    await group.getByRole("button", { name: "Referrers" }).click();
    await page.getByRole("link", { name: "Filter by Referrer: www.google.com/" }).click();
    await expect
      .poll(() => currentPath(router))
      .toBe(`${ANALYTICS}?source=google.com&referrer=https%3A%2F%2Fwww.google.com%2F`);
  });

  test("a tagged-only source adds its medium and campaign", async () => {
    installFakeApi({ list: sourceDetail([["tag", 70]], [[null, 70]]) });
    const router = renderApp(`${ANALYTICS}?source=newsletter`);

    const group = views("Sources");
    await expect.element(group).toBeVisible();
    // Medium and Campaign join once the How list shows a tagged visit.
    await expect
      .poll(() =>
        group
          .getByRole("button")
          .elements()
          .map((button) => button.textContent),
      )
      .toEqual(["How", "Referrers", "Medium", "Campaign", "Channels"]);
    expect((await shownRows("How, most visitors first")).map((row) => row[0])).toEqual([
      "Tagged (utm_source or ref)",
    ]);
    await page
      .getByRole("link", { name: "Filter by Source from: Tagged (utm_source or ref)" })
      .click();
    await expect
      .poll(() => currentPath(router))
      .toBe(`${ANALYTICS}?source=newsletter&sourceKind=tag`);
    await group.getByRole("button", { name: "Referrers" }).click();
    expect((await shownRows("Referrers, most visitors first")).map((row) => row[0])).toEqual([
      "No referrer",
    ]);
    await group.getByRole("button", { name: "Medium" }).click();
    expect((await shownRows("Medium, most visitors first")).map((row) => row[0])).toEqual([
      "email",
    ]);
  });

  test("a mixed source lists both ways", async () => {
    installFakeApi({
      list: sourceDetail(
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
    expect(await shownRows("How, most visitors first")).toEqual([
      ["Referrer", "20", "20"],
      ["Tagged (utm_source or ref)", "5", "5"],
    ]);
  });

  test("Direct / none says it has no tag and no referrer from another site", async () => {
    installFakeApi({
      list: sourceDetail(
        [["none", 300]],
        [
          [null, 280],
          ["https://shop.example/pricing", 20],
        ],
      ),
    });
    renderApp(`${ANALYTICS}?source=${encodeURIComponent("Direct / none")}`);

    await expect.element(views("Sources")).toBeVisible();
    expect((await shownRows("How, most visitors first")).map((row) => row[0])).toEqual([
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
      list: sourceDetail([["referrer", 145]], [["https://www.google.com/", 145]]),
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
      list: (query) =>
        query.get("report") === "exitPage" && query.get("limit") === "10"
          ? {
              rows: Array.from({ length: 10 }, (_, i) => ({
                value: `/page-${i + 1}`,
                visitors: 100 - i,
                visits: 100 - i,
                bounceRate: 0.5,
                exitRate: i === 0 ? 0.42 : 0.1,
              })),
              hasMore: true,
            }
          : fakeList(query),
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
    expect((await shownRows("Exit, most visitors first"))[0]).toEqual([
      "/page-1",
      "100",
      "100",
      "42%",
    ]);

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
    await views("Pages").getByRole("button", { name: "Hostnames" }).click();
    await expect
      .element(page.getByRole("link", { name: "Filter by Hostname: docs.shop.example" }))
      .toBeVisible();
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
  });
});

/** The list route requests for one list. */
const listRequests = (api: { requests: string[] }, report: string) =>
  api.requests.filter(
    (path) => path.includes("/analytics/list?") && path.includes(`report=${report}&`),
  );

describe("a tab's list loads when it shows", () => {
  test("only once its tab is selected, and the page's answer leaves it out", async () => {
    const api = installFakeApi();
    renderApp(ANALYTICS);

    await expect.element(views("Sources")).toBeVisible();
    // The page's own request, and no list of a hidden tab.
    expect(api.requests.some((path) => path.includes("/analytics?"))).toBe(true);
    expect(api.requests.filter((path) => path.includes("/analytics/list?"))).toEqual([]);

    await views("Sources").getByRole("button", { name: "Channels" }).click();
    await shownRows("Channels, most visitors first");
    expect(listRequests(api, "channel")).toHaveLength(1);
    expect(listRequests(api, "channel")[0]).toContain("limit=10");
    expect(listRequests(api, "utmTerm")).toEqual([]);
  });

  test("shows its rows at once when someone switches away and back", async () => {
    installFakeApi();
    renderApp(ANALYTICS);

    await views("Sources").getByRole("button", { name: "Channels" }).click();
    await shownRows("Channels, most visitors first");
    await views("Sources").getByRole("button", { name: "Sources" }).click();
    await views("Sources").getByRole("button", { name: "Channels" }).click();
    // From the cache: no loading state in between.
    expect(
      page.getByRole("table", { name: "Channels, most visitors first" }).elements(),
    ).toHaveLength(1);
    expect(document.querySelector("[aria-label=Loading]")).toBeNull();
  });

  test("shows a loading state, then its rows", async () => {
    let release: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    installFakeApi({
      list: async (query) => {
        await waiting;
        return fakeList(query);
      },
    });
    renderApp(ANALYTICS);

    await views("Campaigns").getByRole("button", { name: "Term", exact: true }).click();
    await expect.element(page.getByLabelText("Loading")).toBeVisible();
    release?.();
    expect((await shownRows("Term, most visitors first")).map((row) => row[0])).toEqual([
      "No term",
      "web analytics",
    ]);
  });

  test("says why it did not load, and retries", async () => {
    let fail = true;
    installFakeApi({
      list: (query) =>
        fail
          ? json({ error: "internal", message: "The list is unavailable." }, 500)
          : fakeList(query),
    });
    renderApp(ANALYTICS);

    await views("Pages").getByRole("button", { name: "Hostnames" }).click();
    await expect.element(page.getByText("The list could not load")).toBeVisible();
    await expect.element(page.getByText("The list is unavailable.")).toBeVisible();
    fail = false;
    await page.getByRole("button", { name: "Retry" }).click();
    expect((await shownRows("Hostnames, most visitors first")).map((row) => row[0])).toEqual([
      "shop.example",
      "docs.shop.example",
      "Unknown",
    ]);
  });

  test("on a shared link, from the link's own list route", async () => {
    const api = installFakeApi({ signedIn: false });
    renderShare(SHARED);

    await views("Pages").getByRole("button", { name: "Exit" }).click();
    await shownRows("Exit, most visitors first");
    expect(
      api.requests.some(
        (path) =>
          path.startsWith(`/api/share/${FAKE_SHARE_TOKEN}/analytics/list?`) &&
          path.includes("report=exitPage"),
      ),
    ).toBe(true);
    expect(api.requests.some((path) => path.startsWith("/api/projects/"))).toBe(false);
  });
});
