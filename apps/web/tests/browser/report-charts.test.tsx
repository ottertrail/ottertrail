import { afterEach, describe, expect, test } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser/context";

import type { ServicesTrend } from "../../src/lib/services-api.ts";
import {
  deferred,
  type FakeApi,
  fakeDatabasesTrend,
  fakeHosts,
  fakeMetrics,
  fakeMetricSparkline,
  fakeServicesTrend,
  installFakeApi,
  noServicesTrend,
  PROJECT,
} from "./fake-api.ts";
import { renderApp } from "./render.tsx";

/**
 * What the Hosts, Metrics, Services, and Databases lists draw beside or
 * above their tables: the hosts' share bars, the metrics' sparklines, and
 * the charts of every service's requests and every database call, in each
 * of their states, at 390 and 1440 wide.
 */

const P = `/projects/${PROJECT.id}`;

const busy = () =>
  Response.json({ error: "reports_busy", message: "This took too long." }, { status: 503 });

/** The queries of every GET request to a path ending in `path`. */
const queriesOf = (api: FakeApi, path: string) =>
  api.requests
    .filter((item) => item.split("?")[0]?.endsWith(path))
    .map((item) => Object.fromEntries(new URLSearchParams(item.split("?")[1] ?? "")));

/** The section of the chart titled `title`. */
const chartOf = (title: string) =>
  page.getByRole("heading", { name: title }).element().closest("[data-slot=chart]");

/** A chart's legend: each entry's text and its key's color. */
const legendOf = (title: string) =>
  [...(chartOf(title)?.querySelectorAll("ul[aria-label=Legend] li") ?? [])].map((item) => [
    item.textContent,
    item.querySelector("span")?.style.background,
  ]);

/** The colors a chart's lines are drawn in. */
const strokesOf = (title: string) => [
  ...new Set(
    [...(chartOf(title)?.querySelectorAll("svg path") ?? [])].map((path) =>
      path.getAttribute("stroke"),
    ),
  ),
];

/** Moves the pointer over a chart's plot, `share` of the way across, and returns its tooltip's text. */
async function hover(title: string, share: number) {
  const plot = chartOf(title)?.querySelector<HTMLElement>("div.relative");
  if (plot === null || plot === undefined) throw new Error(`${title} has no plot`);
  const box = plot.getBoundingClientRect();
  plot.dispatchEvent(
    new PointerEvent("pointermove", {
      bubbles: true,
      clientX: box.left + 64 + (box.width - 80) * share,
      clientY: box.top + 40,
    }),
  );
  await expect.poll(() => plot.querySelector("div.bg-popover")).not.toBeNull();
  const text = plot.querySelector("div.bg-popover")?.textContent;
  // React reads a pointer leaving from pointerout, to the element it moved to.
  plot.dispatchEvent(
    new PointerEvent("pointerout", { bubbles: true, relatedTarget: document.body }),
  );
  await expect.poll(() => plot.querySelector("div.bg-popover")).toBeNull();
  return text;
}

/** Nothing in the content panel or the page scrolls sideways. */
function expectNoSidewaysScroll(width: number) {
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
  const content = document.querySelector("[data-slot=app-content]");
  expect(content?.scrollWidth).toBeLessThanOrEqual(content?.clientWidth ?? 0);
}

/** A share bar as the test reads it: hidden, its width, high or not, its fill. */
const shareBar = (width: string, high = false) => ({
  hidden: "true",
  width,
  high: String(high),
  fill: high ? "bg-status-warning" : "bg-chart-1",
});

/** The fixture's metrics as 80, so the list runs past the view. */
const many = (query: URLSearchParams) => {
  const list = fakeMetrics(query);
  const [first] = list.metrics;
  if (first === undefined) return list;
  return {
    ...list,
    metrics: Array.from({ length: 80 }, (_, index) => ({
      ...first,
      name: `metric.${String(index).padStart(2, "0")}`,
    })),
  };
};

/** The sparklines drawn, each with its words as visually hidden text. */
const sparklines = () => [...document.querySelectorAll("[data-slot=sparkline]")];

/** The metrics whose lines were asked for over `period`. */
const namesAsked = (api: FakeApi, period: string) =>
  queriesOf(api, "/metrics/sparkline")
    .filter((query) => query.period === period)
    .map((query) => query.name ?? "");

/** The names asked for over `period`, once no more have come for half a second. */
async function settledNames(api: FakeApi, period: string) {
  let count = -1;
  await expect
    .poll(
      async () => {
        const now = namesAsked(api, period).length;
        const settled = now > 0 && now === count;
        count = now;
        await new Promise((resolve) => setTimeout(resolve, 250));
        return settled;
      },
      { timeout: 10_000, interval: 250 },
    )
    .toBe(true);
  return namesAsked(api, period);
}

/** The bottom of the scrolling content panel's view. */
const viewBottom = () =>
  document.querySelector("[data-slot=app-content]")?.getBoundingClientRect().bottom ?? 0;

/** The top of the row of the metric `name`, where it is now. */
const rowTop = (name: string) =>
  page.getByRole("link", { name, exact: true }).element().closest("tr")?.getBoundingClientRect()
    .top ?? Infinity;

afterEach(async () => {
  await page.viewport(1280, 900);
});

describe("the hosts' share bars", () => {
  test("a bar beside each share, hidden from screen readers, High past 90%, none for a dash", async () => {
    installFakeApi();
    renderApp(`${P}/hosts`);
    const table = page.getByRole("table", { name: "Hosts, by name" });
    await expect.element(table).toBeVisible();
    const rows = [...table.element().querySelectorAll("tbody tr")];
    const bars = rows.map((row) =>
      [...row.querySelectorAll("[data-slot=share-bar]")].map((bar) => ({
        hidden: bar.getAttribute("aria-hidden"),
        width: bar.querySelector("span")?.style.width,
        high: bar.getAttribute("data-high"),
        fill: [...(bar.querySelector("span")?.classList ?? [])].find((name) =>
          name.startsWith("bg-"),
        ),
      })),
    );
    // db-1: CPU 25%, memory 80%, the fullest filesystem 42%; web-1: 22.5%, 50.04%, 90%.
    expect(bars).toEqual([
      [shareBar("25%"), shareBar("80%"), shareBar("42%")],
      [shareBar("22.5%"), shareBar("50.04%"), shareBar("90%", true)],
    ]);
    // The figure stays as text; a high share says so in words, with the badge's icon.
    const fullest = rows[1]?.querySelectorAll("td")[4];
    expect(fullest?.textContent).toBe("90% (/data)High");
    expect(fullest?.querySelector("[data-slot=status-badge]")?.getAttribute("data-tone")).toBe(
      "warning",
    );
    expect(rows[0]?.textContent).not.toContain("High");
    await expect.element(page.getByText(/at 90% or more it is marked High/)).toBeVisible();
  });

  test("a share shown as 90% is High, whatever its decimals", async () => {
    installFakeApi({
      hosts: (query) => {
        const list = fakeHosts(query);
        return { ...list, hosts: list.hosts.map((host) => ({ ...host, cpuPercent: 89.96 })) };
      },
    });
    renderApp(`${P}/hosts`);
    const table = page.getByRole("table", { name: "Hosts, by name" });
    await expect.element(table).toBeVisible();
    const cpu = [...table.element().querySelectorAll("tbody tr")].map(
      (row) => row.querySelectorAll("td")[2]?.textContent,
    );
    expect(cpu).toEqual(["90%High", "90%High"]);
  });

  test("a share not sent is a dash without a bar", async () => {
    installFakeApi({
      hosts: (query) => {
        const list = fakeHosts(query);
        return {
          ...list,
          hosts: list.hosts.map((host) => ({ ...host, memoryPercent: null })),
        };
      },
    });
    renderApp(`${P}/hosts`);
    const table = page.getByRole("table", { name: "Hosts, by name" });
    await expect.element(table).toBeVisible();
    const memory = [...table.element().querySelectorAll("tbody tr")].map(
      (row) => row.querySelectorAll("td")[3],
    );
    expect(memory.map((cell) => cell?.textContent)).toEqual(["–Not sent", "–Not sent"]);
    expect(memory.map((cell) => cell?.querySelector("[data-slot=share-bar]") ?? null)).toEqual([
      null,
      null,
    ]);
  });
});

describe("the metrics' sparklines", () => {
  test("each row's default line, asked for with its name and kind, named in words", async () => {
    const api = installFakeApi();
    renderApp(`${P}/metrics`);
    await expect.element(page.getByRole("table", { name: "Metrics, by name" })).toBeVisible();
    await expect.poll(() => sparklines().length).toBe(3);
    const lines = sparklines();
    // The words are visually hidden text beside the line, and its hover title.
    expect(lines.map((line) => line.querySelector(".sr-only")?.textContent)).toEqual([
      "95th percentile per hour: lowest 100 ms, highest 210 ms, latest 210 ms",
      "Per second per hour: lowest 1 request/s, highest 12 request/s, latest 12 request/s",
      "Average per hour: lowest 64 MiB, highest 75 MiB, latest 75 MiB",
    ]);
    expect(
      queriesOf(api, "/metrics/sparkline").toSorted((a, b) =>
        (a.name ?? "").localeCompare(b.name ?? ""),
      ),
    ).toEqual([
      { period: "7d", name: "http.server.request.duration", kind: "histogram" },
      { period: "7d", name: "http.server.requests", kind: "counter" },
      { period: "7d", name: "process.memory.usage", kind: "gauge" },
    ]);
    expect(lines.map((line) => line.getAttribute("title"))).toEqual(
      lines.map((line) => line.querySelector(".sr-only")?.textContent),
    );
    // The line is decoration: hidden from screen readers, and no tab stop in the row.
    expect(lines.map((line) => line.querySelector("svg")?.getAttribute("aria-hidden"))).toEqual([
      "true",
      "true",
      "true",
    ]);
    expect(
      lines.filter(
        (line) => line.querySelector("button, a, [tabindex]") !== null || line.matches("button"),
      ),
    ).toEqual([]);
    // The histogram's missing 4th hour breaks its line in two; the others are one line.
    const paths = lines.map((line) => line.querySelectorAll("path").length);
    expect(paths).toEqual([2, 1, 1]);
    // The line is the de-emphasis gray; the latest value a dot in the first chart color.
    const [first] = lines;
    expect(first?.querySelector("path")?.getAttribute("stroke")).toBe("var(--ink-subtle)");
    expect(first?.querySelector("circle:last-of-type")?.getAttribute("fill")).toBe(
      "var(--chart-1)",
    );
  });

  test("a failed line, a period without data, and a histogram without bucket counts are dashes", async () => {
    installFakeApi({
      metricSparkline: (query) => {
        const name = query.get("name");
        if (name === "http.server.requests") return busy();
        const line = fakeMetricSparkline(query);
        if (name === "http.server.request.duration") return { ...line, percentiles: false };
        return { ...line, values: line.values.map(() => null) };
      },
    });
    renderApp(`${P}/metrics`);
    const table = page.getByRole("table", { name: "Metrics, by name" });
    await expect.element(table).toBeVisible();
    await expect.element(page.getByTitle("The line could not load")).toBeVisible();
    await expect.element(page.getByTitle("No bucket counts to draw from")).toBeVisible();
    await expect.element(page.getByTitle("No data in this period")).toBeVisible();
    // No flat line stands in for any of them.
    expect(table.element().querySelectorAll("[data-slot=sparkline]")).toHaveLength(0);
    // The failed line leaves the rest of its row as it was.
    const row = [...table.element().querySelectorAll("tbody tr")][1];
    expect([...(row?.querySelectorAll("td") ?? [])].map((cell) => cell.textContent)).toEqual([
      "http.server.requests",
      "–The line could not load",
      "Counter",
      "request",
      "web",
      "16 Nov 2026, 16:01:00.000",
    ]);
  });

  test("a line past the most-point series it reads says so", async () => {
    installFakeApi({
      metricSparkline: (query) => ({
        ...fakeMetricSparkline(query),
        seriesCount: 100,
        seriesCapped: true,
      }),
    });
    renderApp(`${P}/metrics`);
    await expect.poll(() => sparklines().length).toBe(3);
    expect(sparklines()[2]?.querySelector(".sr-only")?.textContent).toBe(
      "Average per hour: lowest 64 MiB, highest 75 MiB, latest 75 MiB, of the 100 series with the most points",
    );
  });

  test("only rows within 200 pixels of the content panel's view ask for their lines", async () => {
    const api = installFakeApi({ metrics: many });
    await page.viewport(1440, 900);
    renderApp(`${P}/metrics`);
    await expect.element(page.getByRole("table", { name: "Metrics, by name" })).toBeVisible();
    const asked = await settledNames(api, "7d");
    const view = viewBottom();
    // Rows just under the panel's bottom ask too: the look-ahead, inside the scrolling panel.
    expect(asked.some((name) => rowTop(name) > view)).toBe(true);
    // None further down than the 200 pixels.
    expect(asked.filter((name) => rowTop(name) > view + 200)).toEqual([]);
    expect(asked.length).toBeLessThan(80);
    // Scrolling to the last row asks for its line.
    document.querySelector("[data-slot=app-content]")?.scrollTo({ top: 100_000 });
    await expect.poll(() => namesAsked(api, "7d").includes("metric.79")).toBe(true);
  });

  test("after a period change, only the rows in view ask again, not every row seen before", async () => {
    const api = installFakeApi({ metrics: many });
    await page.viewport(1440, 900);
    renderApp(`${P}/metrics`);
    await expect.element(page.getByRole("table", { name: "Metrics, by name" })).toBeVisible();
    const first = await settledNames(api, "7d");
    // The rows at the bottom are seen too: down to the last, then back to the top.
    const content = document.querySelector("[data-slot=app-content]");
    content?.scrollTo({ top: 100_000 });
    await expect.poll(() => namesAsked(api, "7d").includes("metric.79")).toBe(true);
    content?.scrollTo({ top: 0 });
    await settledNames(api, "7d");
    const seen = namesAsked(api, "7d");
    expect(seen.length).toBeGreaterThan(first.length);

    await page.getByRole("combobox", { name: "Period" }).click();
    await page.getByRole("option", { name: "Today" }).click();
    const again = await settledNames(api, "today");
    const view = viewBottom();
    expect(again.length).toBeGreaterThan(0);
    expect(again.filter((name) => rowTop(name) > view + 200)).toEqual([]);
    // The rows seen at the bottom, now out of view, do not ask: fewer than were seen.
    expect(again).not.toContain("metric.79");
    expect(again.length).toBeLessThan(seen.length);
  });

  test("past 7 days, no line is asked for, and each row says why", async () => {
    const api = installFakeApi({
      metrics: (query) => ({
        ...fakeMetrics(query),
        ...(query.get("period") === "30d" ? { firstDay: "2026-10-18" } : {}),
      }),
    });
    renderApp(`${P}/metrics`);
    await expect.poll(() => sparklines().length).toBe(3);
    await page.getByRole("combobox", { name: "Period" }).click();
    await page.getByRole("option", { name: "Last 30 days" }).click();
    await expect
      .poll(() => page.getByTitle("Lines are drawn for up to 7 days").elements().length)
      .toBe(3);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(namesAsked(api, "30d")).toEqual([]);
    await expect
      .element(page.getByText(/Lines are drawn for periods of up to 7 days/))
      .toBeVisible();
  });

  test("a page loads at most two lines at once", async () => {
    let inFlight = 0;
    let most = 0;
    const held = deferred<void>();
    const api = installFakeApi({
      metricSparkline: async (query) => {
        inFlight += 1;
        most = Math.max(most, inFlight);
        await held.promise;
        inFlight -= 1;
        return fakeMetricSparkline(query);
      },
    });
    renderApp(`${P}/metrics`);
    await expect.element(page.getByRole("table", { name: "Metrics, by name" })).toBeVisible();
    // While a line loads, its cell holds a skeleton.
    await expect.element(page.getByLabelText("Loading the line").first()).toBeVisible();
    await expect.poll(() => queriesOf(api, "/metrics/sparkline").length).toBe(2);
    await new Promise((resolve) => setTimeout(resolve, 300));
    // The third row's line waits its turn without asking.
    expect(queriesOf(api, "/metrics/sparkline")).toHaveLength(2);
    held.resolve();
    await expect.poll(() => sparklines().length).toBe(3);
    expect(queriesOf(api, "/metrics/sparkline")).toHaveLength(3);
    expect(most).toBe(2);
  });
});

describe("the chart above the Services list", () => {
  test("requests per second by class, the failed share, or the 95th percentile, with a legend, tooltip, and numbers", async () => {
    const api = installFakeApi();
    renderApp(`${P}/services`);
    await expect
      .element(page.getByRole("slider", { name: "Requests per second, every service, per hour" }))
      .toBeInTheDocument();
    expect(queriesOf(api, "/services/trend")).toEqual([{ period: "7d" }]);
    // Each class with a request, in its class's color, as on a service's page.
    expect(legendOf("Requests per second")).toEqual([
      ["2xx", "var(--chart-1)"],
      ["4xx", "var(--chart-3)"],
      ["5xx", "var(--chart-4)"],
    ]);
    // The toggle: one choice pressed at a time.
    const toggle = page.getByRole("group", { name: "What to chart" });
    const pressed = () =>
      [...toggle.element().querySelectorAll("button")].map((button) => [
        button.textContent,
        button.getAttribute("aria-pressed"),
      ]);
    expect(pressed()).toEqual([
      ["Requests", "true"],
      ["Failed", "false"],
      ["95th percentile", "false"],
    ]);
    // The tooltip at 03:00 UTC (11:00 in Singapore): 2 a second of 2xx, 0.1 of 4xx.
    expect(await hover("Requests per second", 3 / 11)).toBe(
      "Mon 16 Nov 2026, 11:00 to 12:002/s2xx0.1/s4xx0/s5xx",
    );
    // The keyboard readout starts on the latest bucket.
    await expect
      .element(page.getByRole("slider", { name: "Requests per second, every service, per hour" }))
      .toHaveAttribute(
        "aria-valuetext",
        "Mon 16 Nov 2026, 19:00 to 20:00: 2xx 1/s, 4xx 0/s, 5xx 0/s",
      );

    await toggle.getByRole("button", { name: "Failed" }).click();
    await expect.element(page.getByRole("heading", { name: "Failed (%)" })).toBeVisible();
    expect(strokesOf("Failed (%)")).toEqual(["var(--chart-5)"]);
    // One line: the title names it, no legend.
    expect(legendOf("Failed (%)")).toEqual([]);
    // Percentages run from 0 to 100 on the axis.
    const axis = [...(chartOf("Failed (%)")?.querySelectorAll("svg text[text-anchor=end]") ?? [])]
      .map((text) => text.textContent)
      .filter((text) => text?.endsWith("%"));
    expect(axis.at(0)).toBe("0%");
    expect(axis.at(-1)).toBe("100%");

    await toggle.getByRole("button", { name: "95th percentile" }).click();
    await expect.element(page.getByRole("heading", { name: "95th percentile (ms)" })).toBeVisible();
    expect(strokesOf("95th percentile (ms)")).toEqual(["var(--chart-7)"]);

    // The table view: the buckets with a value.
    chartOf("95th percentile (ms)")
      ?.querySelector<HTMLButtonElement>("button[aria-expanded]")
      ?.click();
    const numbers = page.getByRole("table", { name: "95th percentile (ms)" });
    await expect.element(numbers).toBeVisible();
    const rows = [...numbers.element().querySelectorAll("tbody tr")];
    expect(rows).toHaveLength(10);
    expect(
      [...(rows[0]?.querySelectorAll("th, td") ?? [])].map((cell) => cell.textContent),
    ).toEqual(["Mon 16 Nov 2026, 10:00 to 11:00", "150 ms"]);
  });

  test("while it loads, a skeleton; the list does not wait for it", async () => {
    const held = deferred<ServicesTrend>();
    installFakeApi({ servicesTrend: () => held.promise });
    renderApp(`${P}/services`);
    await expect
      .element(page.getByRole("table", { name: "Routes of web, busiest first" }))
      .toBeVisible();
    await expect.element(page.getByLabelText("Loading the chart of every service")).toBeVisible();
    held.resolve(fakeServicesTrend(new URLSearchParams()));
    await expect
      .element(page.getByRole("slider", { name: "Requests per second, every service, per hour" }))
      .toBeInTheDocument();
    expect(document.querySelector("[aria-label='Loading the chart of every service']")).toBeNull();
  });

  test("a failed chart says so with Retry, and the list under it stays", async () => {
    let fail = true;
    installFakeApi({ servicesTrend: (query) => (fail ? busy() : fakeServicesTrend(query)) });
    renderApp(`${P}/services`);
    await expect.element(page.getByText("The chart could not load")).toBeVisible();
    await expect
      .element(page.getByRole("table", { name: "Routes of web, busiest first" }))
      .toBeVisible();
    await expect
      .element(page.getByRole("table", { name: "Routes of billing, busiest first" }))
      .toBeVisible();
    fail = false;
    await page.getByRole("button", { name: "Retry" }).click();
    await expect.element(page.getByRole("heading", { name: "Requests per second" })).toBeVisible();
    expect(document.body.textContent).not.toContain("The chart could not load");
  });

  test("a period without a request says so in place of the chart", async () => {
    installFakeApi({ servicesTrend: noServicesTrend });
    renderApp(`${P}/services`);
    await expect.element(page.getByText("No request arrived in this period.")).toBeVisible();
    expect(chartOf("Requests per second")?.querySelector("svg")).toBeNull();
    expect(document.querySelector("[aria-label='What to chart']")).toBeNull();
  });

  test("a list narrowed to one service shows no chart of every service", async () => {
    const api = installFakeApi();
    renderApp(`${P}/services?service=web`);
    await expect
      .element(page.getByRole("table", { name: "Routes of web, busiest first" }))
      .toBeVisible();
    expect(document.querySelector("[aria-label='What to chart']")).toBeNull();
    expect(queriesOf(api, "/services/trend")).toEqual([]);
  });
});

describe("the chart above the Databases list", () => {
  test("calls per second or the time spent, with a tooltip and numbers", async () => {
    const api = installFakeApi();
    renderApp(`${P}/databases?period=30d&env=staging`);
    await expect
      .element(page.getByRole("slider", { name: "Calls per second, every database, per hour" }))
      .toBeInTheDocument();
    expect(queriesOf(api, "/databases/trend")).toEqual([{ period: "30d", environment: "staging" }]);
    expect(strokesOf("Calls per second")).toEqual(["var(--chart-1)"]);
    // 7,200 calls in the hour at 05:00 UTC (13:00 in Singapore): 2 a second.
    expect(await hover("Calls per second", 5 / 11)).toBe(
      "Mon 16 Nov 2026, 13:00 to 14:002/sCalls per second",
    );

    await page
      .getByRole("group", { name: "What to chart" })
      .getByRole("button", { name: "Time spent" })
      .click();
    await expect
      .element(page.getByRole("heading", { name: "Time spent per hour (s)" }))
      .toBeVisible();
    expect(strokesOf("Time spent per hour (s)")).toEqual(["var(--chart-2)"]);
    const slider = page.getByRole("slider", {
      name: "Time spent per hour (s), every database, per hour",
    });
    slider.element().focus();
    await userEvent.keyboard("{Home}{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}");
    await expect
      .element(slider)
      .toHaveAttribute("aria-valuetext", "Mon 16 Nov 2026, 13:00 to 14:00: Time spent 540 s");

    chartOf("Time spent per hour (s)")
      ?.querySelector<HTMLButtonElement>("button[aria-expanded]")
      ?.click();
    const numbers = page.getByRole("table", { name: "Time spent per hour (s)" });
    await expect.element(numbers).toBeVisible();
    // Every hour has a value: the first two hours took 0 s.
    expect(numbers.element().querySelectorAll("tbody tr")).toHaveLength(12);
  });

  test("a failed chart says so with Retry, and the shapes' tables stay", async () => {
    let fail = true;
    installFakeApi({ databasesTrend: (query) => (fail ? busy() : fakeDatabasesTrend(query)) });
    renderApp(`${P}/databases`);
    await expect.element(page.getByText("The chart could not load")).toBeVisible();
    await expect
      .element(
        page.getByRole("table", {
          name: "Query shapes of shop on postgresql, those with the most time spent first",
        }),
      )
      .toBeVisible();
    fail = false;
    await page.getByRole("button", { name: "Retry" }).click();
    await expect.element(page.getByRole("heading", { name: "Calls per second" })).toBeVisible();
  });

  test("while it loads, a skeleton", async () => {
    const held = deferred<ReturnType<typeof fakeDatabasesTrend>>();
    installFakeApi({ databasesTrend: () => held.promise });
    renderApp(`${P}/databases`);
    await expect.element(page.getByLabelText("Loading the chart of every database")).toBeVisible();
    held.resolve(fakeDatabasesTrend(new URLSearchParams()));
    await expect
      .element(page.getByRole("slider", { name: "Calls per second, every database, per hour" }))
      .toBeInTheDocument();
    expect(document.querySelector("[aria-label='Loading the chart of every database']")).toBeNull();
  });
});

describe("the charts fit", () => {
  for (const [width, height] of [
    [390, 844],
    [1440, 900],
  ] as const) {
    for (const [name, path, title] of [
      ["Services", `${P}/services`, "Requests per second"],
      ["Databases", `${P}/databases`, "Calls per second"],
    ] as const) {
      test(`${name} at ${width} wide: the chart and its toggle within the content, nothing sideways`, async () => {
        await page.viewport(width, height);
        installFakeApi();
        renderApp(path);
        await expect.element(page.getByRole("heading", { name: title })).toBeVisible();
        // Polled, and the chart looked up afresh each time: on CI's slower runner the toggle drew after
        // the heading, and the chart was drawn again once its data came, so an element kept from before
        // was no longer on the page. A toggle not there yet measures as sticking out.
        await expect
          .poll(() => {
            const right = document
              .querySelector("[data-slot=app-content]")
              ?.getBoundingClientRect().right;
            const drawn = chartOf(title);
            const toggle = drawn?.querySelector("[aria-label='What to chart']");
            return {
              chart: (drawn?.getBoundingClientRect().right ?? Infinity) <= (right ?? 0) + 1,
              toggle: (toggle?.getBoundingClientRect().right ?? Infinity) <= (right ?? 0) + 1,
            };
          })
          .toEqual({ chart: true, toggle: true });
        // Short: a report's 140px plot with its axis labels, the full width of the content.
        await expect
          .poll(() => chartOf(title)?.querySelector("svg")?.getBoundingClientRect().height)
          .toBe(180);
        expectNoSidewaysScroll(width);
      });
    }

    test(`Metrics at ${width} wide: the lines scroll with their table`, async () => {
      await page.viewport(width, height);
      installFakeApi();
      renderApp(`${P}/metrics`);
      await expect.poll(() => sparklines().length).toBe(3);
      expectNoSidewaysScroll(width);
    });

    test(`Hosts at ${width} wide: the bars and badges scroll with their table, nothing sideways`, async () => {
      await page.viewport(width, height);
      installFakeApi();
      renderApp(`${P}/hosts`);
      const table = page.getByRole("table", { name: "Hosts, by name" });
      await expect.element(table).toBeVisible();
      expect(table.element().querySelectorAll("[data-slot=share-bar]")).toHaveLength(6);
      expectNoSidewaysScroll(width);
      // At 1440 the table fits; at 390 it scrolls inside itself, its host column pinned.
      const scroller =
        table.element().closest("[data-slot=table-container]") ?? table.element().parentElement;
      const scrolls = (scroller?.scrollWidth ?? 0) > (scroller?.clientWidth ?? 0);
      expect(scrolls).toBe(width === 390);
      // No figure spills out of its cell.
      const spilled = [...table.element().querySelectorAll("td")].filter(
        (cell) => cell.scrollWidth > cell.clientWidth + 1,
      );
      expect(spilled.map((cell) => cell.textContent)).toEqual([]);
    });
  }
});
