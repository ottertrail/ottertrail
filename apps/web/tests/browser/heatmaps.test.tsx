import { afterEach, describe, expect, test } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser/context";

import type { Heatmap } from "../../src/lib/heatmaps-api.ts";
import {
  deferred,
  emptyHeatmap,
  type FakeApi,
  fakeHeatmap,
  heatmapFixture,
  heatmapPagesFixture,
  installFakeApi,
  json,
  memberAccess,
  PROJECT,
} from "./fake-api.ts";
import { renderApp } from "./render.tsx";

/*
 * The Heatmaps screen (docs/dashboard.md, "Heatmaps"), its setting on the
 * project's Install tab, and who may open it. The Pages tables' links to it
 * are in analytics-page.test.tsx.
 */

const HEATMAPS = `/projects/${PROJECT.id}/heatmaps`;
const SETTINGS = `/projects/${PROJECT.id}/settings`;

afterEach(async () => {
  await page.viewport(1280, 900);
});

/** The query of the latest request to an endpoint: "heatmaps" for a page's, "pages" for the list. */
function lastQuery(api: FakeApi, endpoint: "heatmaps" | "pages"): Record<string, string> | null {
  const request = api.requests.findLast((item) =>
    item.split("?")[0]?.endsWith(endpoint === "pages" ? "/heatmaps/pages" : "/heatmaps"),
  );
  if (request === undefined) return null;
  const at = request.indexOf("?");
  return at === -1 ? {} : Object.fromEntries(new URLSearchParams(request.slice(at + 1)));
}

/** Every request for a page's heatmap, in order, as its query. */
function heatmapQueries(api: FakeApi): Record<string, string>[] {
  return api.requests
    .filter((item) => item.split("?")[0]?.endsWith("/heatmaps"))
    .map((item) => Object.fromEntries(new URLSearchParams(item.split("?")[1] ?? "")));
}

/** The strip's figures, as label and value. */
function figures(): [string | null, string | null][] {
  const strip = document.querySelector('dl[aria-label="Heatmap figures"]');
  return [...(strip?.querySelectorAll("[data-slot=stat]") ?? [])].map((stat) => [
    stat.querySelector("dt")?.textContent ?? null,
    stat.querySelector("dd")?.textContent ?? null,
  ]);
}

/** A table's rows as cell text, without a stacked row's labels and the bar's cell. */
function tableRows(name: string): string[][] {
  const table = page.getByRole("table", { name }).element();
  return [...table.querySelectorAll("tbody tr")].map((row) =>
    [...row.querySelectorAll("td, th")]
      .filter((cell) => cell.querySelector("[data-slot=breakdown-bar]") === null)
      .map((cell) => {
        const copy = cell.cloneNode(true);
        if (!(copy instanceof Element)) return cell.textContent ?? "";
        for (const label of copy.querySelectorAll("[data-slot=breakdown-label], .sr-only")) {
          label.remove();
        }
        return copy.textContent ?? "";
      }),
  );
}

/** A breakdown table's whole section, by its table's name. */
const section = (name: string) =>
  page.getByRole("table", { name }).element().closest("[data-slot=breakdown-table]");

const ready = () => page.getByRole("table", { name: "Elements of the page, most clicks first" });

/** Nothing in the content panel or the page scrolls sideways. */
function expectNoSidewaysScroll(width: number) {
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
  const content = document.querySelector("[data-slot=app-content]");
  expect(content?.scrollWidth).toBeLessThanOrEqual(content?.clientWidth ?? 0);
}

describe("the heatmaps page", () => {
  test("opens from the sidebar after Speed, on the top page and its top device", async () => {
    const api = installFakeApi();
    const router = renderApp(`/projects/${PROJECT.id}/speed`);
    const menu = page.getByRole("navigation", { name: "Project" });
    await menu.getByRole("link", { name: "Heatmaps" }).click();

    await expect.poll(() => router.state.location.pathname).toBe(HEATMAPS);
    await expect.element(ready()).toBeVisible();
    await expect
      .element(menu.getByRole("link", { name: "Heatmaps" }))
      .toHaveAttribute("data-active");
    const names = [
      ...document.querySelectorAll("nav[aria-label=Project] [data-sidebar=menu-button]"),
    ].map((item) => item.textContent);
    expect(names.indexOf("Heatmaps")).toBe(names.indexOf("Speed") + 1);

    // First for all devices, which names the top device; then for that device.
    expect(heatmapQueries(api)).toEqual([
      { path: "/", period: "7d" },
      { path: "/", period: "7d", device: "desktop" },
    ]);
    expect(lastQuery(api, "pages")).toEqual({ period: "7d", device: "desktop" });
    await expect.element(page.getByRole("combobox", { name: "Page" })).toHaveValue("/");
    await expect
      .element(page.getByRole("combobox", { name: "Device" }))
      .toMatchTextContent(/^Desktop/);
    await expect.element(page.getByRole("heading", { name: "/", exact: true })).toBeVisible();
    // The address was replaced once with the page and device shown.
    expect(router.state.location.search).toEqual({ path: "/", device: "desktop" });
  });

  test("shows the figures, without changes from a period before", async () => {
    installFakeApi();
    renderApp(HEATMAPS);
    await expect.element(ready()).toBeVisible();

    expect(figures()).toEqual([
      ["Pageviews with heatmap data", "400"],
      ["Clicks", "1,250"],
      ["Rage clicks", "18"],
      ["Median scroll depth", "64%"],
    ]);
    await expect.element(page.getByText("33% reached the bottom")).toBeVisible();
    for (const stat of document.querySelectorAll("[data-slot=stat]")) {
      expect(stat.querySelector("svg")).toBeNull();
    }
    await expect
      .element(page.getByText(/^For 10 to 16 Nov 2026 \(Asia\/Singapore\)\./))
      .toBeVisible();
  });

  test("charts how far visitors scrolled, from the top down, with the average fold", async () => {
    installFakeApi();
    renderApp(HEATMAPS);
    await expect.element(ready()).toBeVisible();

    const bars = [...document.querySelectorAll<HTMLElement>("[data-slot=scroll-reach-bar]")];
    expect(bars.map((bar) => bar.dataset.depth)).toEqual([
      "10",
      "20",
      "30",
      "40",
      "50",
      "60",
      "70",
      "80",
      "90",
      "100",
    ]);
    expect(bars.map((bar) => bar.style.width)).toEqual([
      "100%",
      "96%",
      "90%",
      "81%",
      "70%",
      "62%",
      "55%",
      "47%",
      "40%",
      "33%",
    ]);
    // Top to bottom, one bar under another, all from one baseline.
    const tops = bars.map((bar) => bar.getBoundingClientRect().top);
    expect(tops).toEqual(tops.toSorted((a, b) => a - b));
    expect(new Set(bars.map((bar) => Math.round(bar.getBoundingClientRect().left))).size).toBe(1);

    const fold = document.querySelector<HTMLElement>("[data-slot=average-fold]");
    expect(fold?.textContent).toBe("Average fold, 38% down");
    // 38% down a plot of 140px.
    expect(fold?.querySelector<HTMLElement>("div")?.style.top).toBe(`${0.38 * 140}px`);
    // Said in words for a screen reader, too.
    await expect
      .element(page.getByText("Average fold: 38% of the page showed without scrolling."))
      .toBeInTheDocument();
  });

  test("reads out each depth from the keyboard and under the pointer", async () => {
    installFakeApi();
    renderApp(HEATMAPS);
    const chart = page.getByRole("slider", {
      name: "Share of pageviews reaching each depth of the page",
    });
    await expect.element(chart).toBeInTheDocument();

    chart.element().focus();
    await expect
      .element(chart)
      .toHaveAttribute("aria-valuetext", "10% down: 100% of pageviews reached it (400)");
    await userEvent.keyboard("{ArrowRight}");
    await expect
      .element(chart)
      .toHaveAttribute("aria-valuetext", "20% down: 96% of pageviews reached it (384)");
    await userEvent.keyboard("{End}");
    await expect
      .element(chart)
      .toHaveAttribute("aria-valuetext", "the bottom: 33% of pageviews reached it (132)");
    await expect.element(page.getByText("Reached the bottom", { exact: true })).toBeVisible();
    chart.element().blur();
    await expect
      .element(page.getByText("Reached the bottom", { exact: true }))
      .not.toBeInTheDocument();

    const bar = document.querySelector('[data-slot=scroll-reach-bar][data-depth="50"]');
    if (!(bar instanceof HTMLElement)) throw new Error("No bar for 50%");
    await userEvent.hover(page.elementLocator(bar));
    await expect.element(page.getByText("Reached 50% down", { exact: true })).toBeVisible();
    await expect.element(page.getByText("70% of pageviews (280)", { exact: true })).toBeVisible();
  });

  test("shows the chart's numbers as a table", async () => {
    installFakeApi();
    renderApp(HEATMAPS);
    await page.getByRole("button", { name: "Show the numbers" }).click();

    const table = page.getByRole("table", { name: "Pageviews reaching each depth of the page" });
    await expect.element(table).toBeVisible();
    const rows = [...table.element().querySelectorAll("tbody tr")].map((row) =>
      [...row.querySelectorAll("th, td")].map((cell) => cell.textContent),
    );
    expect(rows).toHaveLength(10);
    expect(rows[0]).toEqual(["10%", "400", "100%"]);
    expect(rows[9]).toEqual(["100%", "132", "33%"]);
  });

  test("lists the most-clicked elements by name, marking rage clicks in words", async () => {
    installFakeApi();
    renderApp(HEATMAPS);
    await expect.element(ready()).toBeVisible();

    expect(tableRows("Elements of the page, most clicks first")).toEqual([
      ["hero-cta", "500", "40%", "0"],
      ["… > section:2 > div > buttonRage clicks", "250", "20%", "15"],
      ["… > ul > li:3 > aRage clicks", "5", "<1%", "3"],
    ]);
    const table = page.getByRole("table", { name: "Elements of the page, most clicks first" });
    const rows = [...table.element().querySelectorAll("tbody tr")];
    // Rage clicks are a badge with an icon and a word, never color alone.
    expect(
      rows.map((row) => row.querySelector("[data-slot=status-badge]")?.textContent ?? null),
    ).toEqual([null, "Rage clicks", "Rage clicks"]);
    expect(rows[1]?.querySelector("[data-slot=status-badge] svg")).not.toBeNull();
    // The full path, and the site's own name with it, on hover.
    expect(rows[0]?.querySelector("[title]")?.getAttribute("title")).toBe(
      "hero-cta (section:1>div>a)",
    );
    expect(rows[1]?.querySelector("[title]")?.getAttribute("title")).toBe(
      "body>main>section:2>div>button",
    );
  });

  test("lists the rage-click hotspots beside the elements, from 64rem of content", async () => {
    await page.viewport(1440, 900);
    installFakeApi();
    renderApp(HEATMAPS);
    const hotspots = page.getByRole("table", { name: "Elements with rage clicks, most first" });
    await expect.element(hotspots).toBeVisible();

    expect(tableRows("Elements with rage clicks, most first")).toEqual([
      ["… > section:2 > div > button", "15", "48%, 30%"],
      ["… > ul > li:3 > a", "3", "10%, 90%"],
    ]);
    // A screen reader hears the spot in words.
    await expect.element(hotspots.getByText("48% across, 30% down")).toBeInTheDocument();
    const elements = section("Elements of the page, most clicks first")?.getBoundingClientRect();
    const beside = section("Elements with rage clicks, most first")?.getBoundingClientRect();
    expect(beside?.top).toBe(elements?.top);
    expect(beside?.left).toBeGreaterThan(elements?.right ?? Infinity);
  });

  test("says when no element had rage clicks", async () => {
    installFakeApi({ heatmap: (query) => ({ ...fakeHeatmap(query), hotspots: [] }) });
    renderApp(HEATMAPS);
    await expect.element(ready()).toBeVisible();
    await expect
      .element(page.getByText("No rage clicks on this page in this period."))
      .toBeVisible();
  });

  test("offers the overlay on the live site as planned, disabled", async () => {
    installFakeApi();
    renderApp(HEATMAPS);
    const open = page.getByRole("button", { name: "Open on your site" });
    await expect.element(open).toBeVisible();
    await expect.element(open).toHaveAttribute("aria-disabled", "true");
    await expect.element(open).toHaveAccessibleDescription(/^Planned/);
    await expect.element(page.getByText(/^Planned/)).toBeVisible();
  });

  test("filters by device, in the address and both requests", async () => {
    const api = installFakeApi();
    const router = renderApp(`${HEATMAPS}?period=30d`);
    await expect.element(ready()).toBeVisible();
    await page.getByRole("combobox", { name: "Device" }).click();
    await expect.element(page.getByRole("option", { name: "Mobile" })).toBeVisible();
    expect(
      page
        .getByRole("option")
        .elements()
        .map((item) => item.textContent),
    ).toEqual(["All devices", "Desktop", "Tablet", "Mobile"]);
    await page.getByRole("option", { name: "Mobile" }).click();

    await expect
      .poll(() => router.state.location.search)
      .toEqual({ period: "30d", path: "/", device: "mobile" });
    await expect
      .poll(() => lastQuery(api, "heatmaps"))
      .toEqual({ path: "/", period: "30d", device: "mobile" });
    expect(lastQuery(api, "pages")).toEqual({ period: "30d", device: "mobile" });
  });

  test("without a device in the address, shows the page's device with the most pageviews", async () => {
    const api = installFakeApi({
      heatmap: (query) => ({
        ...fakeHeatmap(query),
        devices: [
          { device: "desktop", pageviews: 90 },
          { device: "mobile", pageviews: 300 },
          { device: "tablet", pageviews: 10 },
        ],
      }),
    });
    const router = renderApp(`${HEATMAPS}?path=${encodeURIComponent("/pricing")}`);
    await expect.element(ready()).toBeVisible();

    expect(router.state.location.search).toEqual({ path: "/pricing", device: "mobile" });
    await expect
      .element(page.getByRole("combobox", { name: "Device" }))
      .toMatchTextContent(/^Mobile/);
    // Once for all devices, once for the top one: no loop.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(heatmapQueries(api)).toEqual([
      { path: "/pricing", period: "7d" },
      { path: "/pricing", period: "7d", device: "mobile" },
    ]);
  });

  test("All devices stays a choice: the address says so and the requests name no device", async () => {
    // One device's answer has fewer clicks than all devices'.
    const api = installFakeApi({
      heatmap: (query) => {
        const fixture = fakeHeatmap(query);
        return query.has("device")
          ? { ...fixture, totals: { ...fixture.totals, clicks: 100 } }
          : fixture;
      },
    });
    const router = renderApp(HEATMAPS);
    await expect.element(ready()).toBeVisible();
    await expect.poll(() => router.state.location.search).toEqual({ path: "/", device: "desktop" });
    await expect.poll(() => figures()[1]).toEqual(["Clicks", "100"]);
    const asked = api.requests.length;

    await page.getByRole("combobox", { name: "Device" }).click();
    await page.getByRole("option", { name: "All devices" }).click();
    await expect.poll(() => router.state.location.search).toEqual({ path: "/", device: "all" });
    await expect.poll(() => figures()[1]).toEqual(["Clicks", "1,250"]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    // Anything asked since names no device, and the address is not replaced again.
    for (const request of api.requests.slice(asked)) expect(request).not.toContain("device=");
    expect(router.state.location.search).toEqual({ path: "/", device: "all" });
    await expect
      .element(page.getByRole("combobox", { name: "Device" }))
      .toMatchTextContent(/^All devices/);
  });

  test("a page with clicks but no scroll depth yet shows its report, not an empty state", async () => {
    installFakeApi({
      heatmap: (query) => ({
        ...emptyHeatmap({ path: query.get("path") ?? "/" }),
        totals: {
          pageviews: 0,
          clicks: 12,
          rageClicks: 0,
          droppedClicks: 0,
          medianDepth: null,
          reachedBottom: null,
        },
        elements: [
          { label: "hero-cta", element: "a", clicks: 12, share: 1, rageClicks: 0, x: 0.5, y: 0.5 },
        ],
      }),
    });
    renderApp(HEATMAPS);
    await expect.element(ready()).toBeVisible();

    expect(figures()).toEqual([
      ["Pageviews with heatmap data", "0"],
      ["Clicks", "12"],
      ["Rage clicks", "0"],
      ["Median scroll depth", "–"],
    ]);
    expect(page.getByText(/^No heatmap data/).elements()).toEqual([]);
    await expect
      .element(page.getByText(/No pageview sent how far it was scrolled yet/))
      .toBeVisible();
  });

  test("without a page in the address, never opens on a page without data", async () => {
    const api = installFakeApi({
      heatmapPages: () =>
        heatmapPagesFixture({
          pages: [
            { path: "/empty", pageviews: 0, clicks: 0 },
            { path: "/pricing", pageviews: 0, clicks: 30 },
          ],
        }),
    });
    renderApp(HEATMAPS);
    await expect.element(ready()).toBeVisible();
    expect(heatmapQueries(api)[0]).toEqual({ path: "/pricing", period: "7d" });
  });

  test("says how many clicks were not recorded past 100 on one pageview", async () => {
    installFakeApi({
      heatmap: (query) => {
        const fixture = fakeHeatmap(query);
        return { ...fixture, totals: { ...fixture.totals, droppedClicks: 1_234 } };
      },
    });
    renderApp(HEATMAPS);
    await expect.element(ready()).toBeVisible();
    await expect
      .element(page.getByText("1,234 clicks not recorded (over 100 on one pageview)."))
      .toBeVisible();
  });

  test("says nothing of dropped clicks when none were", async () => {
    installFakeApi();
    renderApp(HEATMAPS);
    await expect.element(ready()).toBeVisible();
    expect(document.querySelector("[data-slot=dropped-clicks]")).toBeNull();
  });

  test("ignores a device it does not know", async () => {
    const api = installFakeApi();
    const router = renderApp(`${HEATMAPS}?device=watch`);
    await expect.element(ready()).toBeVisible();
    expect(heatmapQueries(api)[0]).toEqual({ path: "/", period: "7d" });
    // As with no device: the top one.
    expect(router.state.location.search).toEqual({ path: "/", device: "desktop" });
  });

  test("chooses another page from the list, and searches it", async () => {
    const api = installFakeApi();
    const router = renderApp(HEATMAPS);
    await expect.element(ready()).toBeVisible();

    await page.getByRole("button", { name: "Show pages" }).click();
    expect(
      page
        .getByRole("option")
        .elements()
        .map((item) => item.textContent),
    ).toEqual(["/", "/pricing", "/docs/install"]);
    await page.getByRole("option", { name: "/pricing" }).click();
    await expect
      .poll(() => router.state.location.search)
      .toEqual({ path: "/pricing", device: "desktop" });
    await expect
      .poll(() => lastQuery(api, "heatmaps"))
      .toEqual({ path: "/pricing", period: "7d", device: "desktop" });
    await expect
      .element(page.getByRole("heading", { name: "/pricing", exact: true }))
      .toBeVisible();

    const field = page.getByRole("combobox", { name: "Page" });
    await field.fill("inst");
    // Once typing pauses, the API searches past the first 100 pages.
    await expect
      .poll(() => lastQuery(api, "pages"))
      .toEqual({ period: "7d", device: "desktop", search: "inst" });
    await expect
      .poll(() =>
        page
          .getByRole("option")
          .elements()
          .map((item) => item.textContent),
      )
      .toEqual(["/docs/install"]);
    await page.getByRole("option", { name: "/docs/install" }).click();
    await expect
      .poll(() => router.state.location.search)
      .toEqual({ path: "/docs/install", device: "desktop" });
  });

  test("reads the page from the address", async () => {
    const api = installFakeApi();
    renderApp(`${HEATMAPS}?path=${encodeURIComponent("/pricing")}&env=staging`);
    await expect.element(ready()).toBeVisible();
    expect(heatmapQueries(api)[0]).toEqual({
      path: "/pricing",
      period: "7d",
      environment: "staging",
    });
    await expect.element(page.getByRole("combobox", { name: "Page" })).toHaveValue("/pricing");
  });

  test("shows skeletons while the page loads", async () => {
    const held = deferred<Heatmap>();
    installFakeApi({ heatmap: () => held.promise });
    renderApp(HEATMAPS);

    await expect.element(page.getByLabelText("Loading")).toBeVisible();
    expect(figures()).toEqual([]);
    held.resolve(heatmapFixture());
    await expect.element(ready()).toBeVisible();
    await expect.element(page.getByLabelText("Loading")).not.toBeInTheDocument();
  });

  test("shows a failed load with a retry", async () => {
    let failing = true;
    installFakeApi({
      heatmap: (query) =>
        failing ? json({ message: "ClickHouse is busy." }, 503) : fakeHeatmap(query),
    });
    renderApp(HEATMAPS);

    await expect.element(page.getByText("The heatmaps could not load")).toBeVisible();
    await expect.element(page.getByText("ClickHouse is busy.")).toBeVisible();
    expect(figures()).toEqual([]);

    failing = false;
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await expect.element(ready()).toBeVisible();
    await expect.element(page.getByText("The heatmaps could not load")).not.toBeInTheDocument();
  });

  test("shows a failed list of pages with a retry", async () => {
    let failing = true;
    installFakeApi({
      heatmapPages: () =>
        failing ? json({ message: "ClickHouse is busy." }, 503) : heatmapPagesFixture(),
    });
    renderApp(HEATMAPS);

    await expect.element(page.getByText("The heatmaps could not load")).toBeVisible();
    failing = false;
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await expect.element(ready()).toBeVisible();
  });

  test("says when the project does not exist", async () => {
    installFakeApi({
      heatmapPages: () => json({ error: "not_found", message: "No project has this ID." }, 404),
    });
    renderApp(HEATMAPS);
    await expect.element(page.getByText("No such project")).toBeVisible();
  });

  test("with heatmaps off, tells the owner how to turn them on", async () => {
    const api = installFakeApi({
      heatmapPages: () => heatmapPagesFixture({ heatmaps: false, pages: [] }),
    });
    const router = renderApp(HEATMAPS);

    await expect.element(page.getByText("Heatmaps are off for this project")).toBeVisible();
    await expect.element(page.getByText('data-heatmaps="on"', { exact: true })).toBeVisible();
    // No page to show: no heatmap is asked for.
    expect(lastQuery(api, "heatmaps")).toBeNull();
    await page.getByRole("link", { name: "Turn on heatmaps" }).click();
    await expect.poll(() => router.state.location.pathname).toBe(SETTINGS);
    expect(router.state.location.search).toEqual({ tab: "install" });
    await expect
      .element(page.getByRole("switch", { name: "Record clicks and scroll depth" }))
      .toBeVisible();
  });

  test("with heatmaps off, tells a member to ask an owner or admin", async () => {
    installFakeApi({
      access: memberAccess({ web_analytics: "view" }),
      heatmapPages: () => heatmapPagesFixture({ heatmaps: false, pages: [] }),
    });
    renderApp(HEATMAPS);

    await expect.element(page.getByText("Heatmaps are off for this project")).toBeVisible();
    await expect.element(page.getByText(/Ask one of them to turn on heatmaps/)).toBeVisible();
    expect(page.getByRole("link", { name: "Turn on heatmaps" }).elements()).toEqual([]);
  });

  test("with heatmaps off but data from before, shows it and says no new data arrives", async () => {
    installFakeApi({
      heatmapPages: () => heatmapPagesFixture({ heatmaps: false }),
      heatmap: (query) => ({ ...fakeHeatmap(query), heatmaps: false }),
    });
    renderApp(HEATMAPS);
    await expect.element(ready()).toBeVisible();
    await expect
      .element(page.getByText(/No new data arrives until they are turned on/))
      .toBeVisible();
  });

  test("with heatmaps on and no data, says to add the attribute and that data comes with pageviews", async () => {
    installFakeApi({ heatmapPages: () => heatmapPagesFixture({ pages: [] }) });
    renderApp(`${HEATMAPS}?device=tablet`);

    await expect.element(page.getByText("No heatmap data on tablet in this period")).toBeVisible();
    await expect.element(page.getByText('data-heatmaps="on"', { exact: true })).toBeVisible();
    await expect.element(page.getByText(/Data arrives as visitors view pages/)).toBeVisible();
    await expect.element(page.getByText(/kept 90 days\./)).toBeVisible();
  });

  test("a period wholly before the 90 days kept says nothing from it is left", async () => {
    installFakeApi({ heatmapPages: () => heatmapPagesFixture({ pages: [], clipped: true }) });
    renderApp(`${HEATMAPS}?from=2025-01-01&to=2025-01-31`);
    await expect.element(page.getByText("No heatmap data in this period")).toBeVisible();
    await expect
      .element(page.getByText(/kept 90 days, so nothing from earlier in this period is left\./))
      .toBeVisible();
  });

  test("a page without data on the chosen device offers the devices and pages that have some", async () => {
    const api = installFakeApi({
      heatmap: (query) =>
        emptyHeatmap({
          path: query.get("path") ?? "/",
          device: "mobile",
          devices: [
            { device: "desktop", pageviews: 5 },
            { device: "mobile", pageviews: 0 },
          ],
        }),
    });
    const router = renderApp(`${HEATMAPS}?path=${encodeURIComponent("/old")}&device=mobile`);

    await expect
      .element(page.getByText("No heatmap data for /old on mobile in this period"))
      .toBeVisible();
    const devices = page.getByRole("list", { name: "Devices with data" });
    expect(
      devices
        .getByRole("link")
        .elements()
        .map((link) => link.textContent),
    ).toEqual(["All devices", "Desktop (5)"]);
    const pages = page.getByRole("list", { name: "Pages with data" });
    expect(
      pages
        .getByRole("link")
        .elements()
        .map((link) => link.textContent),
    ).toEqual(["/", "/pricing", "/docs/install"]);
    expect(figures()).toEqual([]);

    await devices.getByRole("link", { name: "Desktop (5)" }).click();
    await expect
      .poll(() => router.state.location.search)
      .toEqual({ path: "/old", device: "desktop" });
    await expect
      .poll(() => lastQuery(api, "heatmaps"))
      .toEqual({ path: "/old", period: "7d", device: "desktop" });
  });

  test("marks today's figures as still arriving", async () => {
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Singapore" }).format(
      new Date(),
    );
    installFakeApi({ heatmap: (query) => ({ ...fakeHeatmap(query), lastDay: today }) });
    renderApp(HEATMAPS);
    await expect.element(ready()).toBeVisible();

    const badge = page.getByText("Today still arriving", { exact: true });
    await expect.element(badge).toBeVisible();
    expect(badge.element().closest("[data-slot=status-badge]")?.getAttribute("data-tone")).toBe(
      "warning",
    );
    await expect
      .element(page.getByText(/Scroll depth arrives as visitors leave a page/))
      .toBeVisible();
  });

  test("leaves past days unmarked", async () => {
    installFakeApi();
    renderApp(HEATMAPS);
    await expect.element(ready()).toBeVisible();
    expect(page.getByText("Today still arriving").elements()).toEqual([]);
    expect(document.querySelector("[data-slot=clipped-note]")).toBeNull();
  });

  test("says heatmaps keep 90 days when the period began earlier", async () => {
    installFakeApi({
      heatmap: (query) => ({ ...fakeHeatmap(query), clipped: true, firstDay: "2026-08-19" }),
    });
    renderApp(`${HEATMAPS}?period=12m`);
    await expect.element(ready()).toBeVisible();
    await expect
      .element(page.getByText("Heatmaps keep 90 days of data, so this report starts on 19 Aug."))
      .toBeVisible();
  });

  test("at 390 wide: nothing scrolls sideways, and the tables stack", async () => {
    await page.viewport(390, 844);
    installFakeApi();
    renderApp(HEATMAPS);
    await expect.element(ready()).toBeVisible();

    expectNoSidewaysScroll(390);
    expect(getComputedStyle(ready().element()).display).toBe("block");
    const chart = document.querySelector("[data-slot=scroll-reach-chart]");
    expect(chart?.scrollWidth).toBeLessThanOrEqual(chart?.clientWidth ?? 0);
  });

  test("at 1440 wide: nothing scrolls sideways", async () => {
    await page.viewport(1440, 900);
    installFakeApi();
    renderApp(HEATMAPS);
    await expect.element(ready()).toBeVisible();
    expectNoSidewaysScroll(1440);
  });
});

describe("who may open it", () => {
  test("a member without web analytics cannot, and sees no link to it", async () => {
    installFakeApi({ access: memberAccess({ errors: "view" }) });
    renderApp(HEATMAPS);

    await expect.element(page.getByText("You don't have access")).toBeVisible();
    expect(
      page
        .getByRole("navigation", { name: "Project" })
        .getByRole("link", { name: "Heatmaps" })
        .elements(),
    ).toEqual([]);
    // The page itself never shows: the API refuses its requests too.
    expect(figures()).toEqual([]);
  });

  test("a member with web analytics can", async () => {
    installFakeApi({ access: memberAccess({ web_analytics: "view" }) });
    renderApp(HEATMAPS);
    await expect.element(ready()).toBeVisible();
  });
});

/** The settings tab shown, its Save button, and the install snippet as shown. */
const settingsPanel = () => page.getByRole("tabpanel");
/** The Save bar's status: the Install tab also says whether events arrive. */
const saveStatus = () => settingsPanel().getByText(/^(No unsaved|Unsaved) changes$/);
const save = () => settingsPanel().getByRole("button", { name: "Save changes" });
const snippet = () =>
  [...document.querySelectorAll("code, pre")].find((item) =>
    item.textContent?.startsWith("<script"),
  )?.textContent ?? "";

describe("the Heatmaps setting on the Install tab", () => {
  test("waits for Save, marks the tab unsaved, and Discard turns it back", async () => {
    const api = installFakeApi();
    renderApp(SETTINGS);
    const toggle = page.getByRole("switch", { name: "Record clicks and scroll depth" });
    await expect.element(toggle).not.toBeChecked();
    await expect.element(settingsPanel().getByRole("heading", { name: "Heatmaps" })).toBeVisible();
    await expect.element(save()).toHaveAttribute("aria-disabled", "true");
    await expect.element(saveStatus()).toHaveTextContent("No unsaved changes");

    await toggle.click();
    await expect.element(saveStatus()).toHaveTextContent("Unsaved changes");
    await expect.element(save()).not.toHaveAttribute("aria-disabled", "true");
    await expect
      .element(page.getByRole("tab", { name: /^Install\s*, unsaved changes$/ }))
      .toBeVisible();
    // The snippet shows what is saved, not the switch.
    expect(snippet()).not.toContain("data-heatmaps");

    await settingsPanel().getByRole("button", { name: "Discard" }).click();
    await expect.element(toggle).not.toBeChecked();
    await expect.element(saveStatus()).toHaveTextContent("No unsaved changes");
    expect(api.bodies).toEqual([]);
  });

  test("saves the switch, and the snippet then asks for heatmaps", async () => {
    const api = installFakeApi();
    renderApp(SETTINGS);
    const toggle = page.getByRole("switch", { name: "Record clicks and scroll depth" });
    await expect.element(toggle).toBeVisible();
    expect(snippet()).not.toContain("data-heatmaps");

    await toggle.click();
    await save().click();
    await expect.element(saveStatus()).toHaveTextContent("No unsaved changes");
    expect(api.bodies.at(-1)).toEqual({
      method: "PATCH",
      path: `/api/projects/${PROJECT.id}`,
      body: { heatmaps: true },
    });
    expect(api.projects[0]?.heatmaps).toBe(true);
    await expect.poll(snippet).toContain(' data-heatmaps="on"></script>');
    await expect
      .element(page.getByRole("tab", { name: /^Install\s*, unsaved changes$/ }))
      .not.toBeInTheDocument();
  });

  test("explains what is sent, what is kept, and the site's options", async () => {
    installFakeApi({ projects: [{ ...PROJECT, heatmaps: true }] });
    renderApp(SETTINGS);
    await expect
      .element(page.getByRole("switch", { name: "Record clicks and scroll depth" }))
      .toBeChecked();
    expect(snippet()).toContain(' data-heatmaps="on"');
    for (const text of [
      /No text, typed values, IDs, class names, or link addresses are sent/,
      /No cookies and nothing stored/,
      /no consent switch of their own/,
      /kept 90 days/,
    ]) {
      await expect.element(settingsPanel().getByText(text)).toBeVisible();
    }
    await expect
      .element(settingsPanel().getByText('data-heatmaps-sample="0.25"', { exact: true }))
      .toBeVisible();
    await expect
      .element(settingsPanel().getByText('data-ottertrail-name="hero-cta"', { exact: true }))
      .toBeVisible();
  });
});
