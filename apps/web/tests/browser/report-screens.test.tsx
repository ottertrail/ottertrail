import { afterEach, describe, expect, test } from "vite-plus/test";
import { type Locator, page, userEvent } from "vite-plus/test/browser/context";

import type { FunnelStep } from "../../src/lib/product-api.ts";
import { fakeSpeed, installFakeApi, ORDERS_SHAPE, PROJECT } from "./fake-api.ts";
import { renderApp } from "./render.tsx";

/*
 * Speed, Heatmaps, Product analytics, Services, Databases, AI, Hosts, and Metrics as
 * reports (docs/design-system.md, "Report (Console)"): the pinned filter
 * bar, the strips of figures, the funnel's save rule, the metric's split in
 * the filter bar, and each screen at 390 and 1440 wide. The screens' own
 * test files cover their numbers and links.
 */

const P = `/projects/${PROJECT.id}`;
const STEPS: FunnelStep[] = [
  { type: "page", path: "/pricing" },
  { type: "event", name: "signup" },
];
const FUNNEL = `${P}/product/funnel`;
const PRICING_FUNNEL = "cccccccc-cccc-4ccc-8ccc-ccccccccccc2";
const funnelAddress = (steps: FunnelStep[], rest = "") =>
  `${FUNNEL}?steps=${encodeURIComponent(JSON.stringify(steps))}${rest}`;
const METRIC = `${P}/metrics/${encodeURIComponent("http.server.request.duration")}?kind=histogram`;

afterEach(async () => {
  await page.viewport(1280, 900);
});

/** The report's filter bar, once it is there: the <search> landmark at the top of the screen. */
async function filterBar() {
  await expect.poll(() => document.querySelector("[data-slot=filter-bar]")).not.toBeNull();
  const bar = document.querySelector("[data-slot=filter-bar]");
  if (!(bar instanceof HTMLElement)) throw new Error("The filter bar is missing");
  return page.elementLocator(bar);
}

/** A strip of figures (`StatStrip`, a <dl>), by its name. */
const strip = (label: string) => document.querySelector(`dl[aria-label="${label}"]`);

/** A strip's figures, as label and value. */
function figures(label: string): [string | null, string | null][] {
  return [...(strip(label)?.querySelectorAll("[data-slot=stat]") ?? [])].map((stat) => [
    stat.querySelector("dt")?.textContent ?? null,
    stat.querySelector("dd")?.textContent ?? null,
  ]);
}

/** Each screen, the text that says its data has arrived, and the tables that must fit at 1440. */
const SCREENS = [
  {
    name: "Speed",
    path: `${P}/speed`,
    ready: () => page.getByRole("table", { name: "Pages, most measured loads first" }),
    tables: ["Speed by device", "Pages, most measured loads first"],
    phone: { stack: ["Speed by device", "Pages, most measured loads first"] },
  },
  {
    name: "Heatmaps",
    path: `${P}/heatmaps`,
    ready: () => page.getByRole("table", { name: "Elements with rage clicks, most first" }),
    tables: ["Elements of the page, most clicks first", "Elements with rage clicks, most first"],
    phone: {
      stack: ["Elements of the page, most clicks first", "Elements with rage clicks, most first"],
    },
  },
  {
    name: "Product events",
    path: `${P}/product/events`,
    ready: () => page.getByRole("table", { name: "Product events, most frequent first" }),
    tables: ["Product events, most frequent first"],
    phone: { scroll: ["Product events, most frequent first"] },
  },
  {
    name: "a product event",
    path: `${P}/product/events/signup`,
    ready: () => page.getByRole("table", { name: "plan: its most frequent values" }),
    tables: ["plan: its most frequent values", "seats: its most frequent values"],
    phone: { scroll: ["plan: its most frequent values", "seats: its most frequent values"] },
  },
  {
    name: "the saved funnels",
    path: FUNNEL,
    ready: () => page.getByRole("table", { name: "Saved funnels, by name" }),
    tables: ["Saved funnels, by name"],
    phone: { stack: ["Saved funnels, by name"] },
  },
  {
    name: "a funnel",
    path: funnelAddress(STEPS),
    ready: () =>
      page.getByRole("table", { name: "Funnel steps, with the visitors who reached each" }),
    tables: ["Funnel steps, with the visitors who reached each"],
    phone: { scroll: ["Funnel steps, with the visitors who reached each"] },
  },
  {
    name: "a funnel of users, by browser",
    path: funnelAddress(STEPS, "&count=users&window=3600&by=browser"),
    ready: () =>
      page.getByRole("table", { name: "Funnel steps by browser, with the users who reached each" }),
    tables: [
      "Funnel steps, with the users who reached each",
      "Funnel steps by browser, with the users who reached each",
    ],
    phone: {
      scroll: [
        "Funnel steps, with the users who reached each",
        "Funnel steps by browser, with the users who reached each",
      ],
    },
  },
  {
    name: "Retention",
    path: `${P}/product/retention`,
    ready: () =>
      page.getByRole("table", {
        name: "Weekly retention of signed-in users, by the week of their first event",
      }),
    tables: ["Weekly retention of signed-in users, by the week of their first event"],
    phone: { scroll: ["Weekly retention of signed-in users, by the week of their first event"] },
  },
  {
    name: "Services",
    path: `${P}/services`,
    ready: () => page.getByRole("table", { name: "Routes of web, busiest first" }),
    tables: ["Routes of web, busiest first", "Routes of billing, busiest first"],
    phone: {
      scroll: ["Routes of web, busiest first", "Routes of billing, busiest first"],
      end: ["Routes of web, busiest first", "Routes of billing, busiest first"],
    },
  },
  {
    name: "a service",
    path: `${P}/services/web`,
    ready: () => page.getByRole("table", { name: "Requests by status class" }),
    tables: ["Requests by status class"],
    phone: { fit: ["Requests by status class"] },
  },
  {
    name: "Databases",
    path: `${P}/databases`,
    ready: () =>
      page.getByRole("table", {
        name: "Query shapes of shop on postgresql, those with the most time spent first",
      }),
    tables: ["Query shapes of shop on postgresql, those with the most time spent first"],
    phone: {
      scroll: ["Query shapes of shop on postgresql, those with the most time spent first"],
    },
  },
  {
    name: "a query shape",
    path: `${P}/databases/${ORDERS_SHAPE.id}`,
    ready: () => page.getByRole("table", { name: "Routes that make these calls" }),
    tables: [
      "Slowest calls, slowest first",
      "Services that make these calls",
      "Routes that make these calls",
    ],
    phone: {
      scroll: [
        "Slowest calls, slowest first",
        "Services that make these calls",
        "Routes that make these calls",
      ],
      // The start time scrolls: pinned beside the trace link, it would leave no room.
      unpinnedStart: ["Slowest calls, slowest first"],
      end: ["Slowest calls, slowest first"],
    },
  },
  {
    name: "AI",
    path: `${P}/ai`,
    ready: () => page.getByRole("table", { name: "The latest 50 calls, newest first" }),
    tables: [
      "Calls by model, the costliest first",
      "Calls by feature, the costliest first",
      "The latest 50 calls, newest first",
    ],
    phone: {
      scroll: [
        "Calls by model, the costliest first",
        "Calls by feature, the costliest first",
        "The latest 50 calls, newest first",
      ],
      // The start time scrolls: pinned beside the trace link, it would leave no room.
      unpinnedStart: ["The latest 50 calls, newest first"],
      end: ["The latest 50 calls, newest first"],
    },
  },
  {
    name: "Hosts",
    path: `${P}/hosts`,
    ready: () => page.getByRole("table", { name: "Hosts, by name" }),
    tables: ["Hosts, by name"],
    phone: { scroll: ["Hosts, by name"] },
  },
  {
    name: "a host",
    path: `${P}/hosts/web-1`,
    ready: () => page.getByRole("heading", { name: "Load average" }),
    tables: [],
    phone: {},
  },
  {
    name: "Metrics",
    path: `${P}/metrics`,
    ready: () => page.getByRole("table", { name: "Metrics, by name" }),
    tables: ["Metrics, by name"],
    phone: { scroll: ["Metrics, by name"] },
  },
  {
    name: "a metric",
    path: METRIC,
    ready: () => page.getByRole("heading", { name: "Observations per second" }),
    tables: [],
    phone: {},
  },
] satisfies {
  name: string;
  path: string;
  ready: () => Locator;
  tables: readonly string[];
  phone: {
    /** Rows stack into labelled blocks. */
    stack?: readonly string[];
    /** Wider than a phone: scroll inside themselves, the first column pinned. */
    scroll?: readonly string[];
    /** Of those, the ones whose first column scrolls too. */
    unpinnedStart?: readonly string[];
    /** Of those, the ones whose last column, the row's actions, is pinned at the end. */
    end?: readonly string[];
    /** Fit a phone without scrolling. */
    fit?: readonly string[];
  };
}[];

/** Nothing in the content panel or the page scrolls sideways. */
function expectNoSidewaysScroll(width: number) {
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
  const content = document.querySelector("[data-slot=app-content]");
  expect(content?.scrollWidth).toBeLessThanOrEqual(content?.clientWidth ?? 0);
}

/** The element that scrolls a table sideways: shadcn's container, or the table's own parent. */
function scrollerOf(name: string): HTMLElement {
  const table = page.getByRole("table", { name }).element();
  const scroller = table.closest("[data-slot=table-container]") ?? table.parentElement;
  if (!(scroller instanceof HTMLElement)) throw new Error(`No container for ${name}`);
  return scroller;
}

describe("each report's filter bar", () => {
  for (const screen of SCREENS) {
    test(`${screen.name}: holds the period and the days, pinned under the header`, async () => {
      await page.viewport(1440, 900);
      installFakeApi();
      renderApp(screen.path);

      await expect.element(screen.ready()).toBeVisible();
      expect(document.querySelectorAll("[data-slot=filter-bar]")).toHaveLength(1);
      expect((await filterBar()).element().tagName).toBe("SEARCH");
      await expect
        .element((await filterBar()).getByRole("combobox", { name: "Period" }))
        .toBeVisible();
      await expect
        .element((await filterBar()).getByText("10 to 16 Nov 2026", { exact: true }))
        .toBeVisible();
      await expect
        .element((await filterBar()).getByText("Asia/Singapore", { exact: true }))
        .toBeVisible();
      expect(getComputedStyle((await filterBar()).element()).position).toBe("sticky");
    });
  }

  test("Speed: the device picker sits in the bar, with the environment once there are two", async () => {
    installFakeApi({
      speed: (query) => ({ ...fakeSpeed(query), environments: ["production", "staging"] }),
    });
    renderApp(`${P}/speed`);
    await expect
      .element((await filterBar()).getByRole("combobox", { name: "Device" }))
      .toBeVisible();
    await expect
      .element((await filterBar()).getByRole("combobox", { name: "Environment" }))
      .toBeVisible();
  });

  test("an event's property filters sit in the bar, each with a way to remove it", async () => {
    installFakeApi();
    renderApp(`${P}/product/events/signup?p.plan=team`);
    await expect
      .element((await filterBar()).getByRole("list", { name: "Property filters" }))
      .toHaveTextContent("plan = team");
    await expect
      .element((await filterBar()).getByRole("button", { name: "Remove the filter plan = team" }))
      .toBeVisible();
  });

  test("a metric's split and measure sit in the bar, and the split changes the chart", async () => {
    installFakeApi();
    const router = renderApp(METRIC);
    await expect.element(page.getByRole("heading", { name: "Percentiles" })).toBeVisible();
    // No split yet: no measure to choose.
    expect((await filterBar()).getByRole("combobox", { name: "Measure" }).elements()).toEqual([]);

    await (await filterBar()).getByRole("combobox", { name: "Split by" }).click();
    await page.getByRole("option", { name: "Split by http.route" }).click();
    await expect
      .element(page.getByRole("heading", { name: "95th percentile by http.route" }))
      .toBeVisible();
    await expect
      .element((await filterBar()).getByRole("combobox", { name: "Measure" }))
      .toBeVisible();
    expect(router.state.location.search).toEqual({ kind: "histogram", split: "http.route" });
  });

  test("a metric narrowed to a host shows it in the bar, with a way back to every host", async () => {
    installFakeApi();
    const router = renderApp(`${METRIC}&host=web-1`);
    const narrowed = (await filterBar()).getByRole("list", { name: "Narrowed to" });
    await expect.element(narrowed).toHaveTextContent("Hostweb-1");
    await (await filterBar()).getByRole("button", { name: "Show every host" }).click();
    await expect.poll(() => router.state.location.search).toEqual({ kind: "histogram" });
  });
});

describe("the strips of figures", () => {
  test("Speed: the Core Web Vitals and the measurements before LCP, each with its rating in words", async () => {
    installFakeApi();
    renderApp(`${P}/speed`);
    await expect.poll(() => strip("Core Web Vitals")).not.toBeNull();
    expect(figures("Core Web Vitals")).toEqual([
      ["Largest Contentful Paint (LCP), p75", "2.3 s"],
      ["Interaction to Next Paint (INP), p75", "240 ms"],
      ["Cumulative Layout Shift (CLS), p75", "0.31"],
    ]);
    expect(
      [...(strip("Core Web Vitals")?.querySelectorAll("[data-slot=status-badge]") ?? [])].map(
        (badge) => badge.textContent,
      ),
    ).toEqual(["Good", "Needs improvement", "Poor"]);
    expect(figures("Measurements before LCP")).toEqual([
      ["First Contentful Paint (FCP), p75", "1.2 s"],
      ["Time to First Byte (TTFB), p75", "950 ms"],
    ]);
    // No period before to compare with: under each figure only its details, no change.
    for (const stat of document.querySelectorAll("[data-slot=stat]")) {
      expect([...stat.querySelectorAll("dd")].map((dd) => dd.dataset.slot ?? "value")).toEqual([
        "value",
        "stat-detail",
      ]);
    }
  });

  test("an event: its events, visitors, and users", async () => {
    installFakeApi();
    renderApp(`${P}/product/events/signup`);
    await expect.poll(() => strip("Figures")).not.toBeNull();
    expect(figures("Figures")).toEqual([
      ["Events", "140"],
      ["Visitors", "126"],
      ["Users", "42"],
    ]);
  });

  test("a funnel: the overall conversion, who did the first and last step, and how long it took", async () => {
    installFakeApi();
    renderApp(funnelAddress(STEPS, "&count=users&window=3600"));
    await expect
      .element(page.getByRole("table", { name: "Funnel steps, with the users who reached each" }))
      .toBeVisible();
    const shown = figures("Conversion");
    expect(shown.map(([label]) => label)).toEqual([
      "Overall conversion",
      "Users at step 1",
      "Users at step 2",
      "Median time to convert",
    ]);
    // The figures are the table's: step 1's users, and the last step's share of them.
    const rows = [
      ...page
        .getByRole("table", { name: "Funnel steps, with the users who reached each" })
        .element()
        .querySelectorAll("tbody tr"),
    ].map((row) =>
      // A count's own figure, without its change from the period before.
      [...row.querySelectorAll("td")].map(
        (cell) => (cell.querySelector(":scope > span > span:first-child") ?? cell).textContent,
      ),
    );
    expect(shown[1]?.[1]).toBe(rows[0]?.[0]);
    expect(shown[2]?.[1]).toBe(rows[1]?.[0]);
    expect(shown[0]?.[1]).toBe(rows[1]?.[1]);
  });

  test("a query shape: its totals in one strip", async () => {
    installFakeApi();
    renderApp(`${P}/databases/${ORDERS_SHAPE.id}`);
    await expect.poll(() => strip("Totals")).not.toBeNull();
    expect(figures("Totals").map(([label]) => label)).toEqual([
      "Calls",
      "Per second",
      "Total time",
      "Failed",
      "Median",
      "95th percentile",
      "99th percentile",
    ]);
  });
});

describe("views", () => {
  test("the product reports' tabs are links that mark the one shown and keep the period", async () => {
    installFakeApi();
    renderApp(`${P}/product/retention?period=30d`);
    const tabs = page.getByRole("navigation", { name: "Product analytics reports" });
    await expect
      .element(tabs.getByRole("link", { name: "Retention" }))
      .toHaveAttribute("aria-current", "page");
    expect(tabs.getByRole("link", { name: "Events" }).element().getAttribute("aria-current")).toBe(
      null,
    );
    expect(tabs.getByRole("link", { name: "Funnel" }).element().getAttribute("href")).toBe(
      `${P}/product/funnel?period=30d`,
    );
  });

  test("a chart's numbers open as a table under it, and close again", async () => {
    installFakeApi();
    renderApp(`${P}/speed`);
    const show = page.getByRole("button", { name: "Show the numbers" });
    await expect.element(show).toHaveAttribute("aria-expanded", "false");
    await show.click();
    await expect
      .element(page.getByRole("table", { name: "Page loads and p75 per day" }))
      .toBeVisible();
    await page.getByRole("button", { name: "Hide the numbers" }).click();
    await expect
      .element(page.getByRole("table", { name: "Page loads and p75 per day" }))
      .not.toBeInTheDocument();
  });

  test("a host's charts are full width, one under another", async () => {
    await page.viewport(1440, 900);
    installFakeApi();
    renderApp(`${P}/hosts/web-1`);
    await expect.element(page.getByRole("heading", { name: "Load average" })).toBeVisible();
    const charts = [...document.querySelectorAll("[data-slot=chart]")];
    expect(charts).toHaveLength(8);
    const lefts = new Set(charts.map((chart) => Math.round(chart.getBoundingClientRect().left)));
    const widths = new Set(charts.map((chart) => Math.round(chart.getBoundingClientRect().width)));
    expect(lefts.size).toBe(1);
    expect(widths.size).toBe(1);
  });
});

/** Shows the funnel counted by `label`, through Edit steps. */
async function showCountedBy(label: string) {
  await page.getByRole("button", { name: "Edit steps" }).click();
  await page.getByRole("combobox", { name: "Count by" }).click();
  await page.getByRole("option", { name: label, exact: true }).click();
  await page
    .getByRole("dialog", { name: "Edit the funnel's steps" })
    .getByRole("button", { name: "Show funnel" })
    .click();
}

describe("the funnel's save rule", () => {
  test("Save appears once a funnel is shown, ready to save", async () => {
    const api = installFakeApi({ savedFunnels: [] });
    renderApp(FUNNEL);
    // The list shows no funnel: nothing to save.
    await expect.element(page.getByRole("button", { name: "Try this example" })).toBeVisible();
    expect(page.getByRole("button", { name: "Save funnel" }).elements()).toEqual([]);

    // Shown: something to save.
    await page.getByRole("button", { name: "Try this example" }).click();
    const save = page.getByRole("button", { name: "Save funnel" });
    await expect.element(save).toBeVisible();
    await expect.element(save).not.toHaveAttribute("aria-disabled", "true");
    await expect.element(save).toBeEnabled();
    expect(api.bodies.filter((body) => body.method !== "GET")).toEqual([]);
  });

  test("a saved funnel's Save changes is disabled until it differs from what was saved", async () => {
    const api = installFakeApi();
    const router = renderApp(funnelAddress(STEPS, `&funnel=${PRICING_FUNNEL}`));
    const saveChanges = page.getByRole("button", { name: "Save changes" });
    await expect.element(saveChanges).toHaveAttribute("aria-disabled", "true");
    // An outline button, not the filled one.
    expect(saveChanges.element().classList.contains("bg-primary")).toBe(false);
    expect(saveChanges.element().classList.contains("bg-background")).toBe(true);
    expect(page.getByRole("button", { name: "Save as new funnel" }).elements()).toEqual([]);
    // Focusable while disabled, as the Save bar's is; pressing it does nothing.
    saveChanges.element().focus();
    await expect.element(saveChanges).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    await saveChanges.click({ force: true });
    await settle();
    expect(api.bodies.some((body) => body.method === "PUT")).toBe(false);

    // Another count: it differs.
    await showCountedBy("Users");
    await expect.poll(() => router.state.location.search).toMatchObject({ count: "users" });
    await expect.element(saveChanges).not.toHaveAttribute("aria-disabled", "true");
    await expect.element(page.getByRole("button", { name: "Save as new funnel" })).toBeVisible();

    // Saved: disabled again.
    await saveChanges.click();
    await expect.element(saveChanges).toHaveAttribute("aria-disabled", "true");
    expect(api.bodies.filter((body) => body.method === "PUT")).toHaveLength(1);

    // Back to what was saved before: it differs from the new save, so it can be saved.
    await showCountedBy("Visitors");
    await expect.element(saveChanges).not.toHaveAttribute("aria-disabled", "true");
  });
});

/** Whether a background is fully opaque, so what scrolls under a pinned cell is hidden. */
function opaque(element: Element): boolean {
  const color = getComputedStyle(element).backgroundColor;
  const parts = color.match(/[\d.]+/g)?.map(Number) ?? [];
  return parts.length === 3 || (parts.length === 4 && parts[3] === 1);
}

/** Lets a click or a key press finish whatever it starts (a dialog, a request) before checking it did not. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

describe("each report fits", () => {
  for (const screen of SCREENS) {
    test(`${screen.name} at 1440 wide: nothing overflows, no figure spills out of its cell`, async () => {
      await page.viewport(1440, 900);
      installFakeApi();
      renderApp(screen.path);
      await expect.element(screen.ready()).toBeVisible();

      expectNoSidewaysScroll(1440);
      for (const name of screen.tables) {
        const table = page.getByRole("table", { name }).element();
        // A squeezed column shows as a figure wider than its cell, not as a scrolling table.
        const spilled = [...table.querySelectorAll("td, th")]
          .filter((cell) => getComputedStyle(cell).textAlign === "right")
          .filter((cell) => cell.scrollWidth > cell.clientWidth + 1)
          .map((cell) => cell.textContent);
        expect({ name, spilled }).toEqual({ name, spilled: [] });
        const scroller = scrollerOf(name);
        expect({ name, fits: scroller.scrollWidth <= scroller.clientWidth }).toEqual({
          name,
          fits: true,
        });
      }
    });

    test(`${screen.name} at 390 wide: the bar scrolls away, tables stack or scroll with their names pinned`, async () => {
      await page.viewport(390, 844);
      installFakeApi();
      renderApp(screen.path);
      await expect.element(screen.ready()).toBeVisible();

      expectNoSidewaysScroll(390);
      expect(getComputedStyle((await filterBar()).element()).position).not.toBe("sticky");
      const phone: (typeof SCREENS)[number]["phone"] = screen.phone;
      for (const name of phone.stack ?? []) {
        expect({
          name,
          display: getComputedStyle(page.getByRole("table", { name }).element()).display,
        }).toEqual({ name, display: "block" });
      }
      for (const name of phone.fit ?? []) {
        const scroller = scrollerOf(name);
        expect({ name, fits: scroller.scrollWidth <= scroller.clientWidth }).toEqual({
          name,
          fits: true,
        });
      }
      for (const name of phone.scroll ?? []) {
        const table = page.getByRole("table", { name }).element();
        const scroller = scrollerOf(name);
        // Wider than the phone: it scrolls inside itself.
        expect({ name, scrolls: scroller.scrollWidth > scroller.clientWidth }).toEqual({
          name,
          scrolls: true,
        });
        const first = table.querySelector("tbody tr > :first-child");
        const last = table.querySelector("tbody tr > :last-child");
        if (first === null || last === null) throw new Error(`${name} has no rows`);
        const pinnedStart = !(phone.unpinnedStart ?? []).includes(name);
        const pinnedEnd = (phone.end ?? []).includes(name);
        // The column that names the row stays in view, and the one that acts on it.
        expect({
          name,
          start: getComputedStyle(first).position,
          end:
            getComputedStyle(last).position === "sticky" && getComputedStyle(last).right === "0px",
        }).toEqual({ name, start: pinnedStart ? "sticky" : "static", end: pinnedEnd });
        // A pinned cell hides what scrolls under it.
        const pinnedCells = [...(pinnedStart ? [first] : []), ...(pinnedEnd ? [last] : [])];
        expect({ name, opaque: pinnedCells.map(opaque) }).toEqual({
          name,
          opaque: pinnedCells.map(() => true),
        });
        // The fade where more columns wait can be seen: beside a pinned end column, not under it.
        const hint = scroller
          .closest("[data-more]")
          ?.querySelector(":scope > [data-slot=scroll-hint]");
        if (!(hint instanceof HTMLElement)) throw new Error(`${name} shows no fade`);
        const hintBox = hint.getBoundingClientRect();
        expect({ name, wide: hintBox.width > 0 && hintBox.height > 0 }).toEqual({
          name,
          wide: true,
        });
        // Beside a pinned end column the fade stays clear of it, and above the cells under it.
        const endBox = last.getBoundingClientRect();
        expect({
          name,
          clear: !pinnedEnd || hintBox.right <= endBox.left + 1,
          above:
            !pinnedEnd ||
            Number(getComputedStyle(hint).zIndex) > Number(getComputedStyle(last).zIndex),
        }).toEqual({ name, clear: true, above: true });
      }
    });
  }

  test("the saved funnels at 390 wide: each funnel stacks, its steps wrapping onto lines", async () => {
    await page.viewport(390, 844);
    const long: FunnelStep[] = [
      { type: "page", path: "/pricing/enterprise-plans" },
      { type: "event", name: "checkout_started" },
      { type: "event", name: "payment_details_entered" },
      { type: "event", name: "subscription_created" },
    ];
    installFakeApi({
      savedFunnels: [
        {
          id: PRICING_FUNNEL,
          name: "Enterprise checkout",
          steps: long,
          count: "users",
          window: 604_800,
          createdAt: "2026-11-01T00:00:00.000Z",
          updatedAt: "2026-11-01T00:00:00.000Z",
        },
      ],
    });
    renderApp(FUNNEL);
    const table = page.getByRole("table", { name: "Saved funnels, by name" });
    await expect.element(table).toBeVisible();
    expectNoSidewaysScroll(390);

    const row = table.element().querySelector("tbody tr");
    if (row === null) throw new Error("No row");
    const [name, , steps, counted] = [...row.querySelectorAll("th, td")];
    const text = steps?.querySelector("[data-truncated-text]");
    if (!(name instanceof HTMLElement) || !(text instanceof HTMLElement) || counted === undefined) {
      throw new Error("Missing cells");
    }
    // All of the steps show, on more than one line, inside the screen.
    expect(text.textContent).toBe(
      "/pricing/enterprise-plans → checkout_started → payment_details_entered → subscription_created",
    );
    expect(text.scrollWidth).toBeLessThanOrEqual(text.clientWidth + 1);
    const lineHeight = Number.parseFloat(getComputedStyle(text).lineHeight);
    expect(text.getBoundingClientRect().height).toBeGreaterThan(lineHeight * 1.5);
    expect(text.getBoundingClientRect().right).toBeLessThanOrEqual(390);
    // The name first, then the steps, then who it counts and the conversion.
    const nameBox = name.getBoundingClientRect();
    const stepsBox = text.getBoundingClientRect();
    const countedBox = counted.getBoundingClientRect();
    expect(nameBox.bottom).toBeLessThanOrEqual(stepsBox.top + 1);
    expect(stepsBox.bottom).toBeLessThanOrEqual(countedBox.top + 1);
    // The actions stay beside the name.
    const rename = page.getByRole("button", { name: "Rename the funnel Enterprise checkout" });
    expect(rename.element().getBoundingClientRect().top).toBeLessThan(nameBox.bottom);
  });

  test("Services at 390 wide: a marked route keeps its highlight under its pinned cells", async () => {
    await page.viewport(390, 844);
    installFakeApi();
    renderApp(`${P}/services?service=web&route=${encodeURIComponent('"GET /health"')}`);
    const table = page.getByRole("table", { name: "Routes of web, busiest first" });
    await expect.element(table).toBeVisible();
    const row = table.element().querySelector("tr[aria-current=true]");
    if (row === null) throw new Error("No marked row");
    const rowColor = getComputedStyle(row).backgroundColor;
    const pinned = [row.firstElementChild, row.lastElementChild].filter((cell) => cell !== null);
    expect(pinned.map((cell) => getComputedStyle(cell).backgroundColor)).toEqual([
      rowColor,
      rowColor,
    ]);
  });

  test("Speed: each vital is named with its percentile, in the strip, the tables, and a stacked row", async () => {
    await page.viewport(390, 844);
    installFakeApi();
    renderApp(`${P}/speed`);
    const devices = page.getByRole("table", { name: "Speed by device" });
    await expect.element(devices).toBeVisible();
    expect(
      [...devices.element().querySelectorAll("thead th")].map((cell) => cell.textContent),
    ).toEqual(["Device", "Share", "Loads", "LCP p75", "INP p75", "CLS p75"]);
    expect(
      [
        ...(devices
          .element()
          .querySelector("tbody tr")
          ?.querySelectorAll("[data-slot=breakdown-label]") ?? []),
      ].map((label) => label.textContent),
    ).toEqual(["Loads", "LCP p75", "INP p75", "CLS p75"]);
    expect(figures("Core Web Vitals").map(([label]) => label)).toEqual([
      "Largest Contentful Paint (LCP), p75",
      "Interaction to Next Paint (INP), p75",
      "Cumulative Layout Shift (CLS), p75",
    ]);
  });

  test("Speed at 390 wide: the device and page tables stack their rows", async () => {
    await page.viewport(390, 844);
    installFakeApi();
    renderApp(`${P}/speed`);
    const devices = page.getByRole("table", { name: "Speed by device" });
    await expect.element(devices).toBeVisible();
    expect(getComputedStyle(devices.element()).display).toBe("block");
    expect(devices.element().querySelector("tbody tr")?.textContent).toContain("Loads");
  });

  test("Speed at 1440 wide: the device and page tables sit side by side", async () => {
    await page.viewport(1440, 900);
    installFakeApi();
    renderApp(`${P}/speed`);
    await expect.element(page.getByRole("table", { name: "Speed by device" })).toBeVisible();
    const tops = ["By device", "Pages"].map((title) =>
      Math.round(
        page.getByRole("heading", { name: title, exact: true }).element().getBoundingClientRect()
          .top,
      ),
    );
    expect(new Set(tops).size).toBe(1);
  });
});

/** Focuses an element as the keyboard would, and reads the outline it gets. */
async function ringOf(element: HTMLElement) {
  // A key press first: after an earlier test's clicks, focus from script would not count as
  // the keyboard's, and :focus-visible would not match.
  await userEvent.keyboard("{Shift}");
  element.focus();
  await expect.poll(() => element.matches(":focus-visible")).toBe(true);
  const style = getComputedStyle(element);
  return { width: style.outlineWidth, style: style.outlineStyle, offset: style.outlineOffset };
}

describe("focus rings", () => {
  test("a link in a table that scrolls gets the ring drawn inward, so the scroller cannot clip it", async () => {
    installFakeApi();
    renderApp(`${P}/services`);
    const link = page.getByRole("link", { name: "/orders/{id}", exact: true });
    await expect.element(link).toBeVisible();
    const element = link.element();
    if (!(element instanceof HTMLElement)) throw new Error("No link");
    expect(await ringOf(element)).toEqual({ width: "2px", style: "solid", offset: "-2px" });
  });

  test("a report link outside a table gets the full ring at once", async () => {
    installFakeApi();
    renderApp(`${P}/services/web`);
    const link = page.getByRole("link", { name: "All services" });
    await expect.element(link).toBeVisible();
    const element = link.element();
    if (!(element instanceof HTMLElement)) throw new Error("No link");
    expect(await ringOf(element)).toEqual({ width: "2px", style: "solid", offset: "2px" });
  });

  test("the product tabs draw the ring inward, inside the row that scrolls", async () => {
    installFakeApi();
    renderApp(`${P}/product/events`);
    const tab = page
      .getByRole("navigation", { name: "Product analytics reports" })
      .getByRole("link", { name: "Funnel" });
    await expect.element(tab).toBeVisible();
    const element = tab.element();
    if (!(element instanceof HTMLElement)) throw new Error("No tab");
    expect(await ringOf(element)).toEqual({ width: "2px", style: "solid", offset: "-2px" });
  });

  test("shadcn's parts keep their own ring, with no outline pushed out over it", async () => {
    installFakeApi();
    renderApp(`${P}/web-analytics`);
    const tab = page.getByRole("tab", { name: "Visits" });
    await expect.element(tab).toBeVisible();
    const element = tab.element();
    if (!(element instanceof HTMLElement)) throw new Error("No tab");
    expect((await ringOf(element)).offset).toBe("0px");
  });
});
