import { describe, expect, test } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser/context";

import {
  type FakeApi,
  fakeMetricChart,
  fakeServiceChart,
  fakeServices,
  installFakeApi,
  noMetrics,
  noServiceChart,
  noServices,
  PROJECT,
} from "./fake-api.ts";
import { renderApp } from "./render.tsx";

const METRICS = `/projects/${PROJECT.id}/metrics`;
const SERVICES = `/projects/${PROJECT.id}/services`;
const metricPath = (name: string, kind: string, extra = "") =>
  `${METRICS}/${encodeURIComponent(name)}?kind=${kind}${extra}`;

/** The query of the latest GET request to a path ending in `path`. */
function lastQuery(api: FakeApi, path: string): Record<string, string> {
  const request = api.requests.findLast((item) => item.split("?")[0]?.endsWith(path)) ?? "";
  const at = request.indexOf("?");
  return at === -1 ? {} : Object.fromEntries(new URLSearchParams(request.slice(at + 1)));
}

const sidebarLink = (name: string) =>
  page.getByRole("navigation", { name: "Project" }).getByRole("link", { name });

const cellsOf = (row: Element | undefined) =>
  [...(row?.querySelectorAll("td") ?? [])].map((cell) => cell.textContent);

/** The legend's entries: each line's label and its key's color. */
const legend = () =>
  [...document.querySelectorAll("ul[aria-label=Legend] li")].map((item) => [
    item.textContent,
    item.querySelector("span")?.style.background,
  ]);

describe("the metrics page", () => {
  test("opens from the sidebar with the project's metrics by name", async () => {
    const api = installFakeApi();
    const router = renderApp(`/projects/${PROJECT.id}/logs`);
    await sidebarLink("Metrics").click();

    await expect.poll(() => router.state.location.pathname).toBe(METRICS);
    const table = page.getByRole("table", { name: "Metrics, by name" });
    await expect.element(table).toBeVisible();
    expect(lastQuery(api, "/metrics")).toEqual({ period: "7d" });
    await expect.element(sidebarLink("Metrics")).toHaveAttribute("data-active");
    const rows = [...table.element().querySelectorAll("tbody tr")];
    // The second column holds each row's sparkline (report-charts.test.tsx).
    expect(rows.map((row) => cellsOf(row).toSpliced(1, 1))).toEqual([
      ["http.server.request.duration", "Histogram", "ms", "api, web", "16 Nov 2026, 16:00:00.000"],
      ["http.server.requests", "Counter", "request", "web", "16 Nov 2026, 16:01:00.000"],
      [
        "process.memory.usage",
        "Gauge",
        "By",
        `${Array.from({ length: 10 }, (_, i) => `worker-${i}`).join(", ")} and 2 more`,
        "16 Nov 2026, 16:02:00.000",
      ],
    ]);
  });

  test("shows how to send metrics while the project has none, without the secret key", async () => {
    installFakeApi({ metrics: noMetrics });
    renderApp(METRICS);

    await expect.element(page.getByText("No metrics yet")).toBeVisible();
    expect(document.querySelector("pre")?.textContent).toContain(
      `OTEL_EXPORTER_OTLP_ENDPOINT=${window.location.origin}`,
    );
    expect(document.body.textContent).toContain("/v1/metrics");
    expect(document.body.textContent).not.toContain(PROJECT.secretKey);
    expect(page.getByRole("table").elements()).toEqual([]);
  });

  test("says when no metric arrived in the period", async () => {
    installFakeApi({ metrics: (query) => ({ ...noMetrics(query), received: true }) });
    renderApp(METRICS);
    await expect.element(page.getByText("No metrics in this period")).toBeVisible();
  });
});

describe("a metric's page", () => {
  test("opens from the list on its chart, with the period kept", async () => {
    const api = installFakeApi();
    const router = renderApp(`${METRICS}?period=30d`);
    await page.getByRole("link", { name: "http.server.requests" }).click();

    await expect
      .poll(() => router.state.location.pathname)
      .toBe(`${METRICS}/${encodeURIComponent("http.server.requests")}`);
    expect(router.state.location.search).toEqual({ period: "30d", kind: "counter" });
    await expect.element(page.getByRole("heading", { name: "Per second" })).toBeVisible();
    expect(lastQuery(api, "/metrics/chart")).toEqual({
      period: "30d",
      name: "http.server.requests",
      kind: "counter",
    });
    // One line: no legend; the title names it.
    expect(legend()).toEqual([]);
    // The metric's sidebar entry stays active.
    await expect.element(sidebarLink("Metrics")).toHaveAttribute("data-active");
  });

  test("draws a gauge's average, minimum, and maximum, with a legend and keyboard readout", async () => {
    installFakeApi();
    renderApp(metricPath("process.memory.usage", "gauge"));

    await expect.element(page.getByRole("heading", { name: "Value" })).toBeVisible();
    expect(legend()).toEqual([
      ["Average", "var(--chart-1)"],
      ["Minimum", "var(--chart-2)"],
      ["Maximum", "var(--chart-3)"],
    ]);
    // Bytes, in their unit; the keyboard starts on the latest bucket: 19:00 in Singapore.
    const slider = page.getByRole("slider", { name: /^Value, process.memory.usage, per hour$/ });
    await expect
      .element(slider)
      .toHaveAttribute(
        "aria-valuetext",
        "Mon 16 Nov 2026, 19:00 to 20:00: Average 111 B, Minimum 121 B, Maximum 131 B",
      );
    slider.element().focus();
    await userEvent.keyboard("{Home}");
    await expect
      .element(slider)
      .toHaveAttribute(
        "aria-valuetext",
        "Mon 16 Nov 2026, 08:00 to 09:00: Average 100 B, Minimum 110 B, Maximum 120 B",
      );
  });

  test("shows a histogram's percentiles and its rate as two charts, with tables", async () => {
    installFakeApi();
    renderApp(metricPath("http.server.request.duration", "histogram"));

    await expect.element(page.getByRole("heading", { name: "Percentiles" })).toBeVisible();
    await expect
      .element(page.getByRole("heading", { name: "Observations per second" }))
      .toBeVisible();
    expect(legend()).toEqual([
      ["Median (p50)", "var(--chart-1)"],
      ["95th percentile", "var(--chart-2)"],
      ["99th percentile", "var(--chart-3)"],
    ]);
    await page.getByRole("button", { name: "Show the numbers" }).first().click();
    const table = page.getByRole("table", { name: "Percentiles" });
    const rows = [...table.element().querySelectorAll("tbody tr")];
    // The bucket with nothing is left out of the table.
    expect(rows).toHaveLength(11);
    expect(
      [...(rows[0]?.querySelectorAll("th, td") ?? [])].map((cell) => cell.textContent),
    ).toEqual(["Mon 16 Nov 2026, 08:00 to 09:00", "100 ms", "110 ms", "120 ms"]);
  });

  test("splits by an attribute: a line per value, other in gray", async () => {
    const api = installFakeApi();
    const router = renderApp(metricPath("http.server.request.duration", "histogram"));

    await page.getByRole("combobox", { name: "Split by" }).click();
    await page.getByRole("option", { name: "Split by http.route" }).click();
    await expect
      .poll(() => router.state.location.search)
      .toEqual({ kind: "histogram", split: "http.route" });
    await expect
      .poll(() => lastQuery(api, "/metrics/chart"))
      .toEqual({
        period: "7d",
        name: "http.server.request.duration",
        kind: "histogram",
        split: "http.route",
      });
    await expect
      .element(page.getByRole("heading", { name: "95th percentile by http.route" }))
      .toBeVisible();
    // Most volume first in the legend, each value in the next free color.
    expect(legend().slice(0, 3)).toEqual([
      ["/orders", "var(--chart-1)"],
      ["/cart", "var(--chart-2)"],
      ["Other values", "var(--ink-tertiary)"],
    ]);
    await expect.element(page.getByText(/those with the least volume are combined/)).toBeVisible();

    await page.getByRole("combobox", { name: "Measure" }).click();
    await page.getByRole("option", { name: "Median (p50)" }).click();
    await expect
      .poll(() => router.state.location.search)
      .toEqual({ kind: "histogram", split: "http.route", stat: "p50" });
    await expect
      .element(page.getByRole("heading", { name: "Median (p50) by http.route" }))
      .toBeVisible();

    await page.getByRole("combobox", { name: "Split by" }).click();
    await page.getByRole("option", { name: "No split" }).click();
    await expect.poll(() => router.state.location.search).toEqual({ kind: "histogram" });
  });

  test("a value keeps its color while the page is open, whatever the values shown", async () => {
    let calls = 0;
    installFakeApi({
      metricChart: (query) => {
        calls += 1;
        const chart = fakeMetricChart(query);
        if (calls === 1 || query.get("split") === null) return chart;
        // Another period: /orders is gone, /cart leads, /checkout is new.
        const [orders, cart, other] = chart.series;
        if (orders === undefined || cart === undefined || other === undefined) return chart;
        return {
          ...chart,
          series: [cart, { ...orders, value: "/checkout" }, other],
        };
      },
    });
    renderApp(metricPath("http.server.requests", "counter", "&split=http.route"));
    await expect.poll(legend).toEqual([
      ["/orders", "var(--chart-1)"],
      ["/cart", "var(--chart-2)"],
      ["Other values", "var(--ink-tertiary)"],
    ]);
    await page.getByRole("combobox", { name: "Period" }).click();
    await page.getByRole("option", { name: "Last 30 days" }).click();
    // /cart keeps its color; /checkout takes one no value has had, not /orders'.
    await expect.poll(legend).toEqual([
      ["/cart", "var(--chart-2)"],
      ["/checkout", "var(--chart-3)"],
      ["Other values", "var(--ink-tertiary)"],
    ]);
  });

  test("values named like the page's own labels keep colors of their own", async () => {
    installFakeApi({
      metricChart: (query) => {
        const chart = fakeMetricChart(query);
        const [first, second, other] = chart.series;
        if (first === undefined || second === undefined || other === undefined) return chart;
        return {
          ...chart,
          series: [
            { ...first, value: "Other values" },
            { ...second, value: null },
            { ...second, value: "(not set)" },
            other,
          ],
        };
      },
    });
    renderApp(metricPath("http.server.requests", "counter", "&split=http.route"));
    await expect.poll(legend).toEqual([
      ["Other values", "var(--chart-1)"],
      ["(not set)", "var(--chart-2)"],
      ["(not set)", "var(--chart-3)"],
      ["Other values", "var(--ink-tertiary)"],
    ]);
  });

  test("a histogram without bucket counts says so in place of its percentiles", async () => {
    installFakeApi({
      metricChart: (query) => ({ ...fakeMetricChart(query), percentiles: false, bounds: [] }),
    });
    renderApp(metricPath("http.server.request.duration", "histogram"));
    await expect
      .element(page.getByText(/This histogram's points have no bucket counts/))
      .toBeVisible();
    await expect
      .element(page.getByRole("heading", { name: "Observations per second" }))
      .toBeVisible();
    expect(page.getByRole("slider").elements()).toHaveLength(1);
  });

  test("an up-down counter: the series' last values added up", async () => {
    installFakeApi();
    renderApp(metricPath("db.connections", "updown"));
    await expect.element(page.getByRole("heading", { name: "Total" })).toBeVisible();
    await expect
      .element(page.getByRole("slider", { name: /^Total, db.connections, per hour$/ }))
      .toHaveAttribute("aria-valuetext", "Mon 16 Nov 2026, 19:00 to 20:00: Total 111 ms");
  });

  test("says when the metric has nothing in the period, and when the address names no kind", async () => {
    installFakeApi({ metricChart: (query) => ({ ...fakeMetricChart(query), series: [] }) });
    renderApp(metricPath("http.server.requests", "counter"));
    await expect.element(page.getByText("No points of this metric in this period")).toBeVisible();

    const api = installFakeApi();
    renderApp(`${METRICS}/http.server.requests`);
    await expect.element(page.getByText("This URL does not specify the metric kind")).toBeVisible();
    expect(api.requests.some((request) => request.includes("/metrics/chart"))).toBe(false);
  });

  test("says when a load fails, with Retry", async () => {
    let fail = false;
    installFakeApi({
      metricChart: (query) =>
        fail
          ? Response.json(
              { error: "reports_busy", message: "This took too long." },
              { status: 503 },
            )
          : fakeMetricChart(query),
    });
    renderApp(metricPath("http.server.requests", "counter"));
    await expect.element(page.getByRole("heading", { name: "Per second" })).toBeVisible();
    fail = true;
    await page.getByRole("combobox", { name: "Period" }).click();
    await page.getByRole("option", { name: "Last 30 days" }).click();
    await expect.element(page.getByText("The metric could not load")).toBeVisible();
    await expect.element(page.getByText("This took too long.")).toBeVisible();
    fail = false;
    await page.getByRole("button", { name: "Retry" }).click();
    await expect.element(page.getByRole("heading", { name: "Per second" })).toBeVisible();
    await expect.element(page.getByText("The metric could not load")).not.toBeInTheDocument();
  });
});

describe("the services page", () => {
  test("opens from the sidebar with each service's routes, their 99th percentile and status classes", async () => {
    const api = installFakeApi();
    const router = renderApp(`/projects/${PROJECT.id}/logs?period=30d`);
    await sidebarLink("Services").click();

    await expect.poll(() => router.state.location.pathname).toBe(SERVICES);
    // The page asks once its chunk has loaded (docs/dashboard.md, "Code splitting").
    await expect.poll(() => lastQuery(api, "/services")).toEqual({ period: "7d" });
    await expect.element(page.getByRole("heading", { name: "web" })).toBeVisible();
    await expect
      .element(
        page.getByText(
          "1,200 requests, 2.5% failed, median 25 ms, 95th percentile 182 ms, 99th percentile 310 ms",
        ),
      )
      .toBeVisible();
    // The classes' legend, once, in the chart colors; no status in gray.
    expect(
      [...document.querySelectorAll("ul[aria-label='Status classes'] li")].map((item) => [
        item.textContent,
        item.querySelector("span")?.style.background,
      ]),
    ).toEqual([
      ["2xx", "var(--chart-1)"],
      ["3xx", "var(--chart-2)"],
      ["4xx", "var(--chart-3)"],
      ["5xx", "var(--chart-4)"],
      ["No status", "var(--ink-tertiary)"],
    ]);
    const web = page.getByRole("table", { name: "Routes of web, busiest first" });
    expect([...web.element().querySelectorAll("tbody tr")].map(cellsOf)).toEqual([
      // The status bar has no text; the last cell holds the traces and rule links.
      ["/orders/{id}", "1,000", "3.0%", "30 ms", "190 ms", "320 ms", "", ""],
      ["GET /health", "200", "0%", "850 µs", "1.2 ms", "2.5 ms", "", ""],
    ]);
    // A bar's name gives every class with a request, its count and share.
    const bar = page.getByRole("button", {
      name: "Status classes of /orders/{id}: 2xx 900 (90%), 3xx 20 (2.0%), 4xx 50 (5.0%), 5xx 30 (3.0%)",
    });
    await expect.element(bar).toBeVisible();
    expect(
      [...bar.element().querySelectorAll("[data-status]")].map((part) => [
        part.getAttribute("data-status"),
        (part as HTMLElement).style.background,
      ]),
    ).toEqual([
      ["2xx", "var(--chart-1)"],
      ["3xx", "var(--chart-2)"],
      ["4xx", "var(--chart-3)"],
      ["5xx", "var(--chart-4)"],
    ]);
    await expect
      .element(page.getByRole("button", { name: "Status classes of billing: No status 40 (100%)" }))
      .toBeVisible();
    await expect.element(page.getByText("The 1 busiest of 140 routes.")).toBeVisible();
  });

  test("shows the status classes as numbers, the table view of the bars", async () => {
    installFakeApi();
    renderApp(SERVICES);
    const web = page.getByRole("table", { name: "Routes of web, busiest first" });
    await expect.element(web).toBeVisible();
    await page.getByRole("button", { name: "Show status classes as numbers" }).first().click();
    await expect
      .element(page.getByRole("button", { name: "Show status classes as bars" }))
      .toHaveAttribute("aria-expanded", "true");
    expect([...web.element().querySelectorAll("thead th")].map((cell) => cell.textContent)).toEqual(
      [
        "Route",
        "Requests",
        "Failed",
        "Median",
        "95th percentile",
        "99th percentile",
        "2xx",
        "3xx",
        "4xx",
        "5xx",
        "No status",
        "Traces and alert rule",
      ],
    );
    expect([...web.element().querySelectorAll("tbody tr")].map(cellsOf)).toEqual([
      [
        "/orders/{id}",
        "1,000",
        "3.0%",
        "30 ms",
        "190 ms",
        "320 ms",
        "900",
        "20",
        "50",
        "30",
        "0",
        "",
      ],
      ["GET /health", "200", "0%", "850 µs", "1.2 ms", "2.5 ms", "200", "0", "0", "0", "0", ""],
    ]);
  });

  test("a route opens its page; its traces link opens the Traces page filtered by it", async () => {
    const api = installFakeApi();
    const router = renderApp(`${SERVICES}?period=30d`);
    await page.getByRole("link", { name: "Traces of /orders/{id} in web" }).click();
    await expect.poll(() => router.state.location.pathname).toBe(`/projects/${PROJECT.id}/traces`);
    expect(router.state.location.search).toEqual({
      period: "30d",
      service: "web",
      name: "/orders/{id}",
    });
    await expect
      .poll(() => lastQuery(api, "/traces"))
      .toEqual({ period: "30d", service: "web", name: "/orders/{id}" });

    router.history.back();
    await page.getByRole("link", { name: "/orders/{id}", exact: true }).click();
    await expect.poll(() => router.state.location.pathname).toBe(`${SERVICES}/web`);
    expect(router.state.location.search).toEqual({ period: "30d", route: "/orders/{id}" });
    await expect
      .poll(() => lastQuery(api, "/services/chart"))
      .toEqual({ period: "30d", service: "web", route: "/orders/{id}" });
    await expect.element(page.getByRole("heading", { name: "/orders/{id}" })).toBeVisible();
    await expect.element(sidebarLink("Services")).toHaveAttribute("data-active");
  });
  test("a route of only spaces, and a service named . or .., have no page", async () => {
    const api = installFakeApi();
    api.services = (query) => {
      const list = fakeServices(query);
      const [web, billing] = list.services;
      if (web?.routes[0] !== undefined) web.routes[0] = { ...web.routes[0], route: "   " };
      if (billing !== undefined) list.services[1] = { ...billing, service: ".." };
      return list;
    };
    renderApp(SERVICES);
    const web = page.getByRole("table", { name: "Routes of web, busiest first" });
    await expect.element(web).toBeVisible();
    const row = web.element().querySelector("tbody tr");
    expect(row?.querySelector("td")?.textContent).toBe("(no name)");
    expect(row?.querySelector("td")?.querySelector("a")).toBeNull();
    expect(row?.querySelector("a[aria-label^='Add an alert rule']")).toBeNull();
    // "..", shown as text; its routes are text too.
    await expect.element(page.getByRole("heading", { name: "..", exact: true })).toBeVisible();
    expect(
      page.getByRole("heading", { name: "..", exact: true }).element().querySelector("a"),
    ).toBeNull();
    const dots = page.getByRole("table", { name: "Routes of .., busiest first" });
    expect(dots.element().querySelector("tbody td")?.querySelector("a")).toBeNull();
  });

  test("a route of only spaces in a page's address shows its service", async () => {
    const api = installFakeApi();
    renderApp(`${SERVICES}/web?route=${encodeURIComponent('"   "')}`);
    await expect.element(page.getByRole("heading", { name: "web", exact: true })).toBeVisible();
    expect(lastQuery(api, "/services/chart")).toEqual({ period: "7d", service: "web" });
    await expect
      .element(page.getByRole("link", { name: "Add an alert rule for web" }))
      .toHaveAttribute("href", `/projects/${PROJECT.id}/alerts?add=route_latency&service=web`);
  });

  test("shows how to send traces while the project has none", async () => {
    installFakeApi({ services: noServices });
    renderApp(SERVICES);
    await expect.element(page.getByText("No traces yet")).toBeVisible();
    expect(document.body.textContent).not.toContain(PROJECT.secretKey);
  });

  test("says when no request arrived in the period", async () => {
    installFakeApi({ services: (query) => ({ ...noServices(query), received: true }) });
    renderApp(`${SERVICES}?env=staging`);
    await expect.element(page.getByText("No requests in this period")).toBeVisible();
  });
});

describe("a service's and a route's page", () => {
  test("a service's name opens its totals and charts, with legends, readouts, and tables", async () => {
    const api = installFakeApi();
    const router = renderApp(SERVICES);
    await page.getByRole("link", { name: "web", exact: true }).click();
    await expect.poll(() => router.state.location.pathname).toBe(`${SERVICES}/web`);
    await expect
      .poll(() => lastQuery(api, "/services/chart"))
      .toEqual({ period: "7d", service: "web" });

    await expect.element(page.getByRole("heading", { name: "In this period" })).toBeVisible();
    // The totals, as the Services page counts them: 39,600 2xx, 360 4xx, 36 5xx (the failures).
    expect(
      [...document.querySelectorAll("dl div")].map((item) => [
        item.querySelector("dt")?.textContent,
        item.querySelector("dd")?.textContent,
      ]),
    ).toEqual([
      ["Requests", "39,996"],
      ["Failed", "0.1%"],
      ["Median", "20 ms"],
      ["95th percentile", "150 ms"],
      ["99th percentile", "1.5 s"],
    ]);
    const classes = page.getByRole("table", { name: "Requests by status class" });
    expect(
      [...classes.element().querySelectorAll("tbody tr")].map((row) =>
        [...row.querySelectorAll("th, td")].map((cell) => cell.textContent),
      ),
    ).toEqual([
      ["2xx", "39,600", "99%"],
      ["3xx", "0", "0%"],
      ["4xx", "360", "0.9%"],
      ["5xx", "36", "0.1%"],
      ["No status", "0", "0%"],
    ]);

    // Requests per second: a line per class with a request, each in its class's color.
    await expect.element(page.getByRole("heading", { name: "Requests per second" })).toBeVisible();
    const legends = [...document.querySelectorAll("ul[aria-label=Legend]")].map((list) =>
      [...list.querySelectorAll("li")].map((item) => [
        item.textContent,
        item.querySelector("span")?.style.background,
      ]),
    );
    expect(legends).toEqual([
      [
        ["2xx", "var(--chart-1)"],
        ["4xx", "var(--chart-3)"],
        ["5xx", "var(--chart-4)"],
      ],
      // The failed share is one line: no legend. The durations, in seconds (the slowest is 1.5 s).
      // Neither takes a class's color (chart-1 to chart-4): a color means one thing on the page.
      [
        ["Median", "var(--chart-6)"],
        ["95th percentile", "var(--chart-7)"],
        ["99th percentile", "var(--chart-8)"],
      ],
    ]);
    const failedPath = [...document.querySelectorAll("svg path")].find(
      (path) =>
        path.closest("[data-slot=chart]")?.querySelector("h3")?.textContent === "Failed (%)",
    );
    expect(failedPath?.getAttribute("stroke")).toBe("var(--chart-5)");
    await expect.element(page.getByRole("heading", { name: "Duration (s)" })).toBeVisible();

    // The keyboard starts on the latest bucket, 19:00 in Singapore, and moves between buckets.
    const requests = page.getByRole("slider", { name: "Requests per second, web, per hour" });
    await expect
      .element(requests)
      .toHaveAttribute(
        "aria-valuetext",
        "Mon 16 Nov 2026, 19:00 to 20:00: 2xx 1/s, 4xx 0/s, 5xx 0/s",
      );
    requests.element().focus();
    await userEvent.keyboard("{Home}{ArrowRight}{ArrowRight}{ArrowRight}");
    await expect
      .element(requests)
      .toHaveAttribute(
        "aria-valuetext",
        "Mon 16 Nov 2026, 11:00 to 12:00: 2xx 2/s, 4xx 0.1/s, 5xx 0/s",
      );
    // 36 of 3,636 failed at 12:00: 0.99%; nothing arrived at 08:00.
    const failed = page.getByRole("slider", { name: "Failed (%), web, per hour" });
    failed.element().focus();
    await userEvent.keyboard("{Home}");
    await expect
      .element(failed)
      .toHaveAttribute("aria-valuetext", "Mon 16 Nov 2026, 08:00 to 09:00: Failed no data");
    await userEvent.keyboard("{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}");
    await expect
      .element(failed)
      .toHaveAttribute("aria-valuetext", "Mon 16 Nov 2026, 12:00 to 13:00: Failed 0.99%");
    await expect
      .element(page.getByRole("slider", { name: "Duration (s), web, per hour" }))
      .toHaveAttribute(
        "aria-valuetext",
        "Mon 16 Nov 2026, 19:00 to 20:00: Median 0.02 s, 95th percentile 0.15 s, 99th percentile 1.5 s",
      );

    // The table view of the durations: the buckets with a value.
    await page.getByRole("button", { name: "Show the numbers" }).nth(2).click();
    const table = page.getByRole("table", { name: "Duration (s)" });
    await expect.element(table).toBeVisible();
    const rows = [...table.element().querySelectorAll("tbody tr")];
    expect(rows).toHaveLength(10);
    expect(
      [...(rows[0]?.querySelectorAll("th, td") ?? [])].map((cell) => cell.textContent),
    ).toEqual(["Mon 16 Nov 2026, 10:00 to 11:00", "0.02 s", "0.15 s", "1.5 s"]);
  });

  test("a route's page links to its traces, its alert rule, and its service", async () => {
    const api = installFakeApi();
    const route = "/orders/{id}";
    const router = renderApp(
      `${SERVICES}/web?route=${encodeURIComponent(`"${route}"`)}&env=staging`,
    );
    await expect.element(page.getByRole("heading", { name: route })).toBeVisible();
    expect(lastQuery(api, "/services/chart")).toEqual({
      period: "7d",
      environment: "staging",
      service: "web",
      route,
    });

    await page.getByRole("link", { name: `Traces of ${route} in web` }).click();
    await expect.poll(() => router.state.location.pathname).toBe(`/projects/${PROJECT.id}/traces`);
    expect(router.state.location.search).toEqual({ env: "staging", service: "web", name: route });

    router.history.back();
    await page.getByRole("link", { name: `Add an alert rule for ${route} in web` }).click();
    await expect.poll(() => router.state.location.pathname).toBe(`/projects/${PROJECT.id}/alerts`);
    expect(router.state.location.search).toMatchObject({
      add: "route_latency",
      service: "web",
      route,
      env: "staging",
    });

    router.history.back();
    await page.getByRole("link", { name: "Every route of web" }).click();
    await expect.poll(() => router.state.location.search).toEqual({ env: "staging" });
    await expect
      .poll(() => lastQuery(api, "/services/chart"))
      .toEqual({ period: "7d", environment: "staging", service: "web" });
    await page.getByRole("link", { name: "All services" }).click();
    await expect.poll(() => router.state.location.pathname).toBe(SERVICES);
    expect(router.state.location.search).toEqual({ env: "staging" });
  });

  test("says when no request of the route arrived in the period", async () => {
    installFakeApi({ serviceChart: noServiceChart });
    renderApp(`${SERVICES}/web?route=${encodeURIComponent('"GET /gone"')}`);
    await expect.element(page.getByText("No requests in this period")).toBeVisible();
    await expect
      .element(page.getByText(/No server span of GET \/gone in web arrived in this period\./))
      .toBeVisible();
    expect(page.getByRole("slider").elements()).toEqual([]);
  });

  test("a failed load offers Retry", async () => {
    let fail = true;
    installFakeApi({
      serviceChart: (query) =>
        fail
          ? new Response(JSON.stringify({ error: "busy", message: "This took too long." }), {
              status: 503,
            })
          : fakeServiceChart(query),
    });
    renderApp(`${SERVICES}/web`);
    await expect.element(page.getByText("The charts could not load")).toBeVisible();
    fail = false;
    await page.getByRole("button", { name: "Retry" }).click();
    await expect.element(page.getByRole("heading", { name: "Requests per second" })).toBeVisible();
  });
});
