import { describe, expect, test } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser/context";

import {
  type FakeApi,
  fakeDatabases,
  fakeShape,
  installFakeApi,
  noDatabases,
  noShapeCalls,
  ORDERS_SHAPE,
  PROJECT,
} from "./fake-api.ts";
import { renderApp } from "./render.tsx";

const DATABASES = `/projects/${PROJECT.id}/databases`;

/** The query of the latest GET request to a path ending in `path`. */
function lastQuery(api: FakeApi, path: string): Record<string, string> | undefined {
  const request = api.requests.findLast((item) => item.split("?")[0]?.endsWith(path));
  if (request === undefined) return undefined;
  const at = request.indexOf("?");
  return at === -1 ? {} : Object.fromEntries(new URLSearchParams(request.slice(at + 1)));
}

const sidebarLink = (name: string) =>
  page.getByRole("navigation", { name: "Project" }).getByRole("link", { name });

const cellsOf = (row: Element | undefined) =>
  [...(row?.querySelectorAll("td") ?? [])].map((cell) => cell.textContent);

const rowsOf = (name: string) =>
  [...page.getByRole("table", { name }).element().querySelectorAll("tbody tr")].map(cellsOf);

/** The headers marked as the sort, one per table. */
const sortedBy = () =>
  [...document.querySelectorAll("th[aria-sort=descending]")].map((header) => header.textContent);

/** The stroke of the line in the chart titled `title`. */
const strokeOf = (title: string) =>
  [...document.querySelectorAll("svg path")]
    .find(
      (path) =>
        path.closest("[data-slot=report-chart]")?.querySelector("h3")?.textContent === title,
    )
    ?.getAttribute("stroke");

const SHOP_TABLE = "Query shapes of shop on postgresql, those with the most time spent first";

describe("the databases page", () => {
  test("opens from the sidebar after Services, with each database and its query shapes", async () => {
    const api = installFakeApi();
    const router = renderApp(`/projects/${PROJECT.id}/services`);
    await sidebarLink("Databases").click();

    await expect.poll(() => router.state.location.pathname).toBe(DATABASES);
    await expect.element(page.getByRole("heading", { name: "shop on postgresql" })).toBeVisible();
    expect(lastQuery(api, "/databases")).toEqual({ period: "7d" });
    await expect.element(sidebarLink("Databases")).toHaveAttribute("data-active");
    // A database without a name is its system alone.
    await expect.element(page.getByRole("heading", { name: "redis", exact: true })).toBeVisible();
    await expect
      .element(
        page.getByText(
          "60,600 calls (0.1/s), 30 min 12 s in all, <0.1% failed; median 12.5 ms, 95th percentile 95 ms, 99th percentile 1.9 s. From api, billing, web.",
        ),
      )
      .toBeVisible();
    expect(rowsOf(SHOP_TABLE)).toEqual([
      [
        ORDERS_SHAPE.shape,
        "60,480",
        "0.1/s",
        "25 min 12 s",
        "12 ms",
        "80 ms",
        "250 ms",
        "<0.1%",
        "api, web",
      ],
      ["SELECT invoices", "120", "<0.01/s", "5 min", "1.8 s", "4.2 s", "6 s", "1.7%", "billing"],
    ]);
    // Cut: 2 of 240 shapes.
    await expect
      .element(page.getByText("The 2 query shapes with the most time spent, of 240."))
      .toBeVisible();
    // Total time is the sort: its header says so.
    expect(sortedBy()).toEqual(["Total time", "Total time"]);
  });

  test("sorts the shapes by a column: the address and the request take it", async () => {
    const api = installFakeApi();
    const router = renderApp(`${DATABASES}?period=30d`);
    await expect.element(page.getByRole("table", { name: SHOP_TABLE })).toBeVisible();

    await page.getByRole("button", { name: "95th percentile", exact: true }).first().click();
    await expect.poll(() => router.state.location.search).toEqual({ period: "30d", sort: "p95" });
    await expect.poll(() => lastQuery(api, "/databases")).toEqual({ period: "30d", sort: "p95" });
    const table = page.getByRole("table", {
      name: "Query shapes of shop on postgresql, those with the slowest 95th percentile first",
    });
    await expect.element(table).toBeVisible();
    expect([...table.element().querySelectorAll("tbody tr")].map((row) => cellsOf(row)[0])).toEqual(
      ["SELECT invoices", ORDERS_SHAPE.shape],
    );
    expect(sortedBy()).toEqual(["95th percentile", "95th percentile"]);
    await expect
      .element(page.getByText("The 2 query shapes with the slowest 95th percentile, of 240."))
      .toBeVisible();

    await page.getByRole("button", { name: "Failed", exact: true }).first().click();
    await expect
      .poll(() => router.state.location.search)
      .toEqual({
        period: "30d",
        sort: "failures",
      });
    await expect
      .element(page.getByText("The 2 query shapes with the most failed calls, of 240."))
      .toBeVisible();
    // Back to the default: the address drops it.
    await page.getByRole("button", { name: "Total time", exact: true }).first().click();
    await expect.poll(() => router.state.location.search).toEqual({ period: "30d" });
    // The first answer, still cached, shows again.
    await expect.element(page.getByRole("table", { name: SHOP_TABLE })).toBeVisible();
  });

  test("an address with an unknown sort shows the default", async () => {
    const api = installFakeApi();
    renderApp(`${DATABASES}?sort=slowest`);
    await expect.element(page.getByRole("table", { name: SHOP_TABLE })).toBeVisible();
    expect(lastQuery(api, "/databases")).toEqual({ period: "7d" });
  });

  test("shows how to send traces while the project has none, without the secret key", async () => {
    installFakeApi({ databases: noDatabases });
    renderApp(DATABASES);
    await expect.element(page.getByText("No traces yet")).toBeVisible();
    await expect
      .element(page.getByText(/This page shows the database calls in those traces\./))
      .toBeVisible();
    expect(document.body.textContent).not.toContain(PROJECT.secretKey);
  });

  test("says how database calls are recorded when none arrived in the period", async () => {
    installFakeApi({ databases: (query) => ({ ...noDatabases(query), received: true }) });
    renderApp(`${DATABASES}?env=staging`);
    await expect.element(page.getByText("No database calls in this period")).toBeVisible();
    await expect
      .element(page.getByText(/No such span arrived in staging in this period\./))
      .toBeVisible();
    await expect
      .element(page.getByText(/Enable your SDK's instrumentation for your app's database client/))
      .toBeVisible();
  });

  test("a failed load offers Retry", async () => {
    let fail = true;
    installFakeApi({
      databases: (query) =>
        fail
          ? new Response(JSON.stringify({ error: "busy", message: "This took too long." }), {
              status: 503,
            })
          : fakeDatabases(query),
    });
    renderApp(DATABASES);
    await expect.element(page.getByText("The databases could not load")).toBeVisible();
    fail = false;
    await page.getByRole("button", { name: "Retry" }).click();
    await expect.element(page.getByRole("table", { name: SHOP_TABLE })).toBeVisible();
  });
});

describe("a query shape's page", () => {
  test("a shape opens its page with the period kept: the shape, totals, and charts", async () => {
    const api = installFakeApi();
    const router = renderApp(`${DATABASES}?env=staging`);
    await page.getByRole("link", { name: ORDERS_SHAPE.shape }).click();

    await expect.poll(() => router.state.location.pathname).toBe(`${DATABASES}/${ORDERS_SHAPE.id}`);
    expect(router.state.location.search).toEqual({ env: "staging" });
    await expect
      .poll(() => lastQuery(api, `/databases/shapes/${ORDERS_SHAPE.id}`))
      .toEqual({ period: "7d", environment: "staging" });
    await expect
      .element(page.getByRole("heading", { name: "Query shape in shop on postgresql" }))
      .toBeVisible();
    // The shape in full, and what it is made from.
    expect(document.querySelector("pre")?.textContent).toBe(ORDERS_SHAPE.shape);
    await expect
      .element(page.getByText(/normalized with string literals, number literals/))
      .toBeVisible();

    await expect.element(page.getByRole("heading", { name: "In this period" })).toBeVisible();
    expect(
      [...document.querySelectorAll("dl div")].map((item) => [
        item.querySelector("dt")?.textContent,
        item.querySelector("dd")?.textContent,
      ]),
    ).toEqual([
      ["Calls", "39,600"],
      ["Per second", "0.0655/s"],
      ["Total time", "8 min"],
      ["Failed", "0.1%"],
      ["Median", "12 ms"],
      ["95th percentile", "80 ms"],
      ["99th percentile", "250 ms"],
    ]);

    // Calls take chart-1, the failed share chart-5, the percentiles chart-6 to chart-8:
    // a color means one thing on the page. One-line charts have no legend.
    await expect.element(page.getByRole("heading", { name: "Calls per second" })).toBeVisible();
    expect(strokeOf("Calls per second")).toBe("var(--chart-1)");
    expect(strokeOf("Failed (%)")).toBe("var(--chart-5)");
    expect(
      [...document.querySelectorAll("ul[aria-label=Legend]")].map((list) =>
        [...list.querySelectorAll("li")].map((item) => [
          item.textContent,
          item.querySelector("span")?.style.background,
        ]),
      ),
    ).toEqual([
      [
        ["Median", "var(--chart-6)"],
        ["95th percentile", "var(--chart-7)"],
        ["99th percentile", "var(--chart-8)"],
      ],
    ]);
    // Durations in ms: the slowest is 250 ms.
    await expect.element(page.getByRole("heading", { name: "Duration (ms)" })).toBeVisible();

    // The keyboard readouts, and the 0 to 100 failed share: 36 of 3,600 at 12:00 in Singapore.
    const calls = page.getByRole("slider", {
      name: "Calls per second, shop on postgresql, per hour",
    });
    await expect
      .element(calls)
      .toHaveAttribute("aria-valuetext", "Mon 16 Nov 2026, 19:00 to 20:00: Calls 1/s");
    const failed = page.getByRole("slider", { name: "Failed (%), shop on postgresql, per hour" });
    failed.element().focus();
    await userEvent.keyboard("{Home}{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}");
    await expect
      .element(failed)
      .toHaveAttribute("aria-valuetext", "Mon 16 Nov 2026, 12:00 to 13:00: Failed 1%");

    // The table view of the calls per second: every hour, 0 where no call was made.
    await page.getByRole("button", { name: "Show the numbers" }).first().click();
    const table = page.getByRole("table", { name: "Calls per second" });
    await expect.element(table).toBeVisible();
    expect(table.element().querySelectorAll("tbody tr")).toHaveLength(12);
  });

  test("the slowest calls open their spans; the services and routes open the Services pages", async () => {
    installFakeApi();
    const router = renderApp(`${DATABASES}/${ORDERS_SHAPE.id}?period=30d`);
    const slowest = page.getByRole("table", { name: "Slowest calls, slowest first" });
    await expect.element(slowest).toBeVisible();
    expect([...slowest.element().querySelectorAll("tbody tr")].map(cellsOf)).toEqual([
      [
        "16 Nov 2026, 12:12:30.123",
        "2.4 s",
        "web",
        "Error",
        expect.stringContaining("Open its trace"),
      ],
      [
        "16 Nov 2026, 17:00:01.000",
        "900 ms",
        "api",
        "No error",
        expect.stringContaining("Open its trace"),
      ],
    ]);
    await page.getByRole("link", { name: /Open its trace \(2\.4 s/ }).click();
    await expect
      .poll(() => router.state.location.pathname)
      .toBe(`/projects/${PROJECT.id}/traces/4bf92f3577b34da6a3ce929d0e0e4736`);
    expect(router.state.location.search).toEqual({
      at: "2026-11-16T04:12:30.123Z",
      span: "00f067aa0ba902b7",
    });

    router.history.back();
    const routes = page.getByRole("table", { name: "Routes that make these calls" });
    await expect.element(routes).toBeVisible();
    expect([...routes.element().querySelectorAll("tbody tr")].map(cellsOf)).toEqual([
      ["/orders/{id}", "web", "700", "70%"],
      ["No request found", "api", "300", "30%"],
    ]);
    await expect
      .element(page.getByText(/The requests behind the 1,000 latest calls/))
      .toBeVisible();
    await routes.getByRole("link", { name: "/orders/{id}" }).click();
    await expect
      .poll(() => router.state.location.pathname)
      .toBe(`/projects/${PROJECT.id}/services/web`);
    expect(router.state.location.search).toEqual({ period: "30d", route: "/orders/{id}" });

    router.history.back();
    const services = page.getByRole("table", { name: "Services that make these calls" });
    await expect.element(services).toBeVisible();
    expect([...services.element().querySelectorAll("tbody tr")].map(cellsOf)).toEqual([
      ["web", "30,000", "5 min", "90 ms", "0.1%"],
      ["api", "9,600", "3 min", "70 ms", "0%"],
    ]);
    await services.getByRole("link", { name: "api" }).click();
    await expect
      .poll(() => router.state.location.pathname)
      .toBe(`/projects/${PROJECT.id}/services/api`);

    router.history.back();
    await page.getByRole("link", { name: "All databases" }).click();
    await expect.poll(() => router.state.location.pathname).toBe(DATABASES);
    expect(router.state.location.search).toEqual({ period: "30d" });
  });

  test("says when the shape had no call in the period", async () => {
    installFakeApi({ shape: noShapeCalls });
    renderApp(`${DATABASES}/${ORDERS_SHAPE.id}`);
    await expect
      .element(page.getByText("No calls of this query shape in this period"))
      .toBeVisible();
    expect(page.getByRole("slider").elements()).toEqual([]);
  });

  test("an address that names no shape says so without asking the API", async () => {
    const api = installFakeApi();
    renderApp(`${DATABASES}/not-a-shape`);
    await expect.element(page.getByText("Not a query shape")).toBeVisible();
    expect(api.requests.some((request) => request.includes("/databases/shapes/"))).toBe(false);
  });

  test("an ID past 64 bits names no shape", async () => {
    const api = installFakeApi();
    renderApp(`${DATABASES}/18446744073709551616`);
    await expect.element(page.getByText("Not a query shape")).toBeVisible();
    expect(api.requests.some((request) => request.includes("/databases/shapes/"))).toBe(false);
  });

  test("leading zeros ask for the shape without them", async () => {
    const api = installFakeApi();
    renderApp(`${DATABASES}/000042`);
    await expect.element(page.getByRole("heading", { name: "Calls per second" })).toBeVisible();
    expect(lastQuery(api, "/databases/shapes/42")).toEqual({ period: "7d" });
  });

  test("a failed load offers Retry", async () => {
    let fail = true;
    installFakeApi({
      shape: (shapeId, query) =>
        fail
          ? new Response(JSON.stringify({ error: "busy", message: "This took too long." }), {
              status: 503,
            })
          : fakeShape(shapeId, query),
    });
    renderApp(`${DATABASES}/${ORDERS_SHAPE.id}`);
    await expect.element(page.getByText("The query shape could not load")).toBeVisible();
    fail = false;
    await page.getByRole("button", { name: "Retry" }).click();
    await expect.element(page.getByRole("heading", { name: "Calls per second" })).toBeVisible();
  });
});
