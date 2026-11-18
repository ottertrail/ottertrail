import { describe, expect, test } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser/context";

import {
  type FakeApi,
  fakeMetricChart,
  installFakeApi,
  noMetrics,
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
    expect(rows.map(cellsOf)).toEqual([
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
        "Mon 16 Nov 2026, 19:00–20:00: Average 111 B, Minimum 121 B, Maximum 131 B",
      );
    slider.element().focus();
    await userEvent.keyboard("{Home}");
    await expect
      .element(slider)
      .toHaveAttribute(
        "aria-valuetext",
        "Mon 16 Nov 2026, 08:00–09:00: Average 100 B, Minimum 110 B, Maximum 120 B",
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
    ).toEqual(["Mon 16 Nov 2026, 08:00–09:00", "100 ms", "110 ms", "120 ms"]);
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
    await expect.element(page.getByText(/those with the least volume are added up/)).toBeVisible();

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
      .element(page.getByText(/This histogram's points carry no bucket counts/))
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
      .toHaveAttribute("aria-valuetext", "Mon 16 Nov 2026, 19:00–20:00: Total 111 ms");
  });

  test("says when the metric has nothing in the period, and when the address names no kind", async () => {
    installFakeApi({ metricChart: (query) => ({ ...fakeMetricChart(query), series: [] }) });
    renderApp(metricPath("http.server.requests", "counter"));
    await expect.element(page.getByText("No points of this metric in this period")).toBeVisible();

    const api = installFakeApi();
    renderApp(`${METRICS}/http.server.requests`);
    await expect
      .element(page.getByText("This address does not say what kind of metric this is"))
      .toBeVisible();
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
  test("opens from the sidebar with each service's routes, and a route opens its traces", async () => {
    const api = installFakeApi();
    const router = renderApp(`/projects/${PROJECT.id}/logs?period=30d`);
    await sidebarLink("Services").click();

    await expect.poll(() => router.state.location.pathname).toBe(SERVICES);
    expect(lastQuery(api, "/services")).toEqual({ period: "7d" });
    await expect.element(page.getByRole("heading", { name: "web" })).toBeVisible();
    await expect
      .element(page.getByText("1,200 requests, 2.5% failed, median 25 ms, 95th percentile 182 ms"))
      .toBeVisible();
    const web = page.getByRole("table", { name: "Routes of web, busiest first" });
    expect([...web.element().querySelectorAll("tbody tr")].map(cellsOf)).toEqual([
      ["/orders/{id}", "1,000", "3.0%", "30 ms", "190 ms"],
      ["GET /health", "200", "0%", "850 µs", "1.2 ms"],
    ]);
    await expect.element(page.getByText("The 1 busiest of 140 routes.")).toBeVisible();

    await page.getByRole("link", { name: "/orders/{id}" }).click();
    await expect.poll(() => router.state.location.pathname).toBe(`/projects/${PROJECT.id}/traces`);
    expect(router.state.location.search).toEqual({ service: "web", name: "/orders/{id}" });
    await expect
      .poll(() => lastQuery(api, "/traces"))
      .toEqual({ period: "7d", service: "web", name: "/orders/{id}" });
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
