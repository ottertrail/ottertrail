import { describe, expect, test } from "vite-plus/test";
import { page } from "vite-plus/test/browser/context";

import { type FakeApi, fakeChannels, fakeServices, installFakeApi, PROJECT } from "./fake-api.ts";
import { renderApp } from "./render.tsx";

/**
 * Telemetry alert rules in the dashboard (docs/uptime-alerts.md, "Alerts
 * on telemetry"): the form's fields for route latency, route failures,
 * and metrics, with their suggestions; the warning for what has not
 * reported; and the links from the Services page and a metric's page
 * that open the form filled in.
 */

const ALERTS = `/projects/${PROJECT.id}/alerts`;
const RULES_PATH = `/api/projects/${PROJECT.id}/alert-rules`;
const SERVICES = `/projects/${PROJECT.id}/services`;
const [EMAIL] = fakeChannels().list;
if (EMAIL === undefined) throw new Error("the fixtures changed");

const dialog = (name: string | RegExp) => page.getByRole("dialog", { name });

async function choose(scope: ReturnType<typeof dialog>, combobox: string, option: string) {
  await scope.getByRole("combobox", { name: combobox }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

/** The suggestions a text field offers: its datalist's options. */
function suggestionsOf(label: string): string[] {
  const field = [...document.querySelectorAll("label")].find(
    (element) => element.textContent === label,
  );
  const input = document.getElementById(field?.htmlFor ?? "");
  const list = input instanceof HTMLInputElement ? input.list : null;
  return [...(list?.options ?? [])].map((option) => option.value);
}

/** The query of the latest GET request to a path ending in `path`. */
function lastQuery(api: FakeApi, path: string): Record<string, string> {
  const request = api.requests.findLast((item) => item.split("?")[0]?.endsWith(path)) ?? "";
  const at = request.indexOf("?");
  return at === -1 ? {} : Object.fromEntries(new URLSearchParams(request.slice(at + 1)));
}

describe("the rule form's telemetry kinds", () => {
  test("route latency: checks its fields, suggests services and routes, and sends its settings", async () => {
    const api = installFakeApi();
    renderApp(ALERTS);
    await page.getByRole("button", { name: "Add rule" }).click();
    const form = dialog("Add an alert rule");
    await choose(form, "When", "Route latency");
    await expect
      .element(form.getByText(/Sends when the requests' 95th or 99th percentile duration/))
      .toBeVisible();

    await form.getByLabelText("Above (milliseconds)").fill("0");
    await form.getByLabelText("At least (requests)").fill("0");
    // A route rule's window is at most 30 minutes.
    await form.getByLabelText("In the last (minutes)").fill("31");
    await form.getByRole("button", { name: "Add rule" }).click();
    await expect
      .element(form.getByText("Choose or enter the service, as its spans name it (service.name)."))
      .toBeVisible();
    await expect
      .element(form.getByText("Enter a duration above 0 and at most 3,600,000 milliseconds."))
      .toBeVisible();
    await expect
      .element(form.getByText("Enter a whole number of requests from 1 to 1,000,000."))
      .toBeVisible();
    await expect
      .element(form.getByText("Enter a whole number of minutes from 5 to 30."))
      .toBeVisible();
    expect(api.bodies).toEqual([]);

    // The services of the last day, from the light list, then the chosen one's routes.
    await expect.poll(() => suggestionsOf("Service")).toEqual(["web", "billing"]);
    expect(api.requests.some((request) => request.includes("/services/routes"))).toBe(true);
    expect(api.requests.some((request) => /\/services(\?|$)/u.test(request))).toBe(false);
    await form.getByLabelText("Service").fill("web");
    await expect
      .poll(() => suggestionsOf("Route (optional)"))
      .toEqual(["/orders/{id}", "GET /health"]);
    await form.getByLabelText("Route (optional)").fill("/orders/{id}");
    await choose(form, "Percentile", "99th percentile (p99)");
    await form.getByLabelText("Above (milliseconds)").fill("250.5");
    await form.getByLabelText("At least (requests)").fill("50");
    await form.getByLabelText("In the last (minutes)").fill("15");
    await form.getByRole("checkbox", { name: /On call/ }).click();
    await form.getByRole("button", { name: "Add rule" }).click();

    await expect.element(form).not.toBeInTheDocument();
    expect(api.bodies.at(-1)).toEqual({
      method: "POST",
      path: RULES_PATH,
      body: {
        name: "",
        kind: "route_latency",
        settings: {
          environment: null,
          service: "web",
          route: "/orders/{id}",
          windowMinutes: 15,
          minRequests: 50,
          percentile: "p99",
          thresholdMs: 250.5,
        },
        channelIds: [EMAIL.id],
      },
    });
    await expect
      .element(
        page.getByText(
          "The 99th percentile duration of /orders/{id} in web is above 250.5 ms over 15 minutes, with at least 50 requests, in production",
        ),
      )
      .toBeVisible();
    // A service that has sent requests: no warning.
    expect(page.getByText(/is saved, and has nothing to watch yet/).elements()).toEqual([]);
  });

  test("route failures for a service that has not reported: saved, with the API's warning", async () => {
    const api = installFakeApi();
    renderApp(ALERTS);
    await page.getByRole("button", { name: "Add rule" }).click();
    const form = dialog("Add an alert rule");
    await choose(form, "When", "Route failures");
    await form.getByLabelText("Environment").fill("staging");
    await form.getByLabelText("Service").fill("checkout");
    await form.getByLabelText("Failed above (percent)").fill("100");
    await form.getByRole("checkbox", { name: /On call/ }).click();
    await form.getByRole("button", { name: "Add rule" }).click();
    await expect
      .element(form.getByText("Enter a share from 0 to just under 100 percent."))
      .toBeVisible();
    await form.getByLabelText("Failed above (percent)").fill("2.5");
    await form.getByRole("button", { name: "Add rule" }).click();

    await expect.element(form).not.toBeInTheDocument();
    expect(api.bodies.at(-1)?.body).toMatchObject({
      kind: "route_failures",
      settings: {
        environment: "staging",
        service: "checkout",
        route: null,
        thresholdPercent: 2.5,
        minRequests: 20,
        windowMinutes: 10,
      },
    });
    await expect
      .element(page.getByText("“Route failures” is saved, and has nothing to watch yet"))
      .toBeVisible();
    await expect
      .element(
        page.getByText(
          "No request of checkout has arrived in staging in the last 24 hours. The rule is saved: it starts watching once the service reports.",
        ),
      )
      .toBeVisible();
    await page.getByRole("button", { name: "Dismiss" }).click();
    await expect
      .element(page.getByText(/is saved, and has nothing to watch yet/))
      .not.toBeInTheDocument();
  });

  test("metric: its kind decides the measures, and hosts and attributes are suggested", async () => {
    const api = installFakeApi();
    renderApp(ALERTS);
    await page.getByRole("button", { name: "Add rule" }).click();
    const form = dialog("Add an alert rule");
    await choose(form, "When", "Metric");
    await form.getByRole("button", { name: "Add rule" }).click();
    await expect.element(form.getByText("Choose or enter the metric's name.")).toBeVisible();
    await expect.element(form.getByText("Say what kind of metric it is.")).toBeVisible();
    await expect
      .element(form.getByText("Enter a number to compare with, such as 100 or 0.5."))
      .toBeVisible();

    await expect
      .poll(() => suggestionsOf("Metric"))
      .toEqual(["http.server.request.duration", "http.server.requests", "process.memory.usage"]);
    await expect.poll(() => suggestionsOf("Host (optional)")).toEqual(["db-1", "web-1"]);
    // A metric of one kind sets it, and the measures follow it.
    await form.getByLabelText("Metric").fill("http.server.request.duration");
    await expect
      .element(form.getByRole("combobox", { name: "Kind" }))
      .toMatchTextContent(/^Histogram/);
    await expect
      .element(form.getByRole("combobox", { name: "Read as" }))
      .toMatchTextContent(/^95th percentile \(p95\)/);
    await form.getByRole("combobox", { name: "Read as" }).click();
    // The list opens a moment after the click: wait for it, not read it at once.
    await expect
      .poll(() =>
        page
          .getByRole("option")
          .elements()
          .map((option) => option.textContent),
      )
      .toEqual(["95th percentile (p95)", "Median (p50)", "99th percentile (p99)"]);
    await page.getByRole("option", { name: "99th percentile (p99)" }).click();
    await choose(form, "Kind", "Gauge");
    await expect
      .element(form.getByRole("combobox", { name: "Read as" }))
      .toMatchTextContent(/^Average/);
    await choose(form, "Kind", "Histogram");

    // The metric's attribute keys, then the chosen key's values, from its chart.
    await expect
      .poll(() => suggestionsOf("Attribute (optional)"))
      .toEqual(["http.route", "host.name"]);
    await form.getByLabelText("Attribute (optional)").fill("http.route");
    await expect.poll(() => suggestionsOf("Its value")).toEqual(["/orders", "/cart"]);
    expect(lastQuery(api, "/metrics/chart")).toMatchObject({
      name: "http.server.request.duration",
      kind: "histogram",
      split: "http.route",
      period: "7d",
    });
    await form.getByRole("button", { name: "Add rule" }).click();
    await expect.element(form.getByText("Enter the attribute's value too.")).toBeVisible();
    await form.getByLabelText("Its value").fill("/orders");
    await form.getByLabelText("Host (optional)").fill("web-1");
    await choose(form, "Sends when it is", "Below");
    await form.getByLabelText("Below").fill("0.5");
    await form.getByLabelText("In the last (minutes)").fill("5");
    await form.getByLabelText("Name (optional)").fill("Orders too fast");
    await form.getByRole("checkbox", { name: /On call/ }).click();
    await form.getByRole("button", { name: "Add rule" }).click();

    await expect.element(form).not.toBeInTheDocument();
    expect(api.bodies.at(-1)?.body).toEqual({
      name: "Orders too fast",
      kind: "metric_threshold",
      settings: {
        environment: null,
        metric: "http.server.request.duration",
        metricKind: "histogram",
        aggregate: "p95",
        direction: "below",
        value: 0.5,
        windowMinutes: 5,
        host: "web-1",
        attributeKey: "http.route",
        attributeValue: "/orders",
      },
      channelIds: [EMAIL.id],
    });
    await expect
      .element(
        page.getByText(
          "The 95th percentile of http.server.request.duration on host web-1 where http.route is /orders is below 0.5 over 5 minutes, in production",
        ),
      )
      .toBeVisible();
  });
});

describe("links that open the form filled in", () => {
  test("the Services page: each route, and each service", async () => {
    installFakeApi();
    const router = renderApp(SERVICES);
    const link = page.getByRole("link", { name: "Add an alert rule for GET /health in web" });
    await expect.element(link).toBeVisible();
    await expect
      .element(page.getByRole("link", { name: "Add an alert rule for billing" }))
      .toBeVisible();
    await link.click();

    await expect.poll(() => router.state.location.pathname).toBe(ALERTS);
    const form = dialog("Add an alert rule");
    await expect.element(form).toBeVisible();
    await expect
      .element(form.getByRole("combobox", { name: "When" }))
      .toMatchTextContent(/^Route latency/);
    await expect.element(form.getByLabelText("Service")).toHaveValue("web");
    await expect.element(form.getByLabelText("Route (optional)")).toHaveValue("GET /health");
    await expect.element(form.getByLabelText("Environment")).toHaveValue("");
  });

  test("an alert's link to the Services page shows its service, its route marked", async () => {
    installFakeApi();
    renderApp(`${SERVICES}?service=web&route=${encodeURIComponent('"GET /health"')}&env=staging`);
    await expect.element(page.getByRole("heading", { name: "web" })).toBeVisible();
    expect(page.getByRole("heading", { name: "billing" }).elements()).toEqual([]);
    const marked = document.querySelector("tr[aria-current=true]");
    expect(marked?.querySelector("td")?.textContent).toBe("GET /health");
    await page.getByRole("link", { name: "Show all services" }).click();
    await expect.element(page.getByRole("heading", { name: "billing" })).toBeVisible();
  });

  test("a metric's page: narrowed to a host and an attribute value, and its rule link", async () => {
    const api = installFakeApi();
    const router = renderApp(
      `/projects/${PROJECT.id}/metrics/${encodeURIComponent("http.server.request.duration")}?kind=histogram&env=staging&host=web-1&attr=${encodeURIComponent('"http.route"')}&attrValue=${encodeURIComponent('"/orders"')}`,
    );
    const narrowed = page.getByRole("list", { name: "Narrowed to" });
    await expect.element(narrowed).toHaveTextContent("Hostweb-1http.route = /orders");
    await expect
      .poll(() => lastQuery(api, "/metrics/chart"))
      .toMatchObject({ host: "web-1", attr: "http.route", attrValue: "/orders" });

    await page.getByRole("link", { name: "Add an alert rule" }).click();
    await expect.poll(() => router.state.location.pathname).toBe(ALERTS);
    const form = dialog("Add an alert rule");
    await expect
      .element(form.getByRole("combobox", { name: "When" }))
      .toMatchTextContent(/^Metric/);
    await expect.element(form.getByLabelText("Metric")).toHaveValue("http.server.request.duration");
    await expect
      .element(form.getByRole("combobox", { name: "Kind" }))
      .toMatchTextContent(/^Histogram/);
    await expect.element(form.getByLabelText("Environment")).toHaveValue("staging");
    await expect.element(form.getByLabelText("Host (optional)")).toHaveValue("web-1");
    await expect.element(form.getByLabelText("Attribute (optional)")).toHaveValue("http.route");
    await expect.element(form.getByLabelText("Its value")).toHaveValue("/orders");
  });

  test("a metric's page drops a filter on request", async () => {
    const api = installFakeApi();
    renderApp(`/projects/${PROJECT.id}/metrics/process.memory.usage?kind=gauge&host=db-1`);
    await page.getByRole("button", { name: "Show every host" }).click();
    await expect.element(page.getByRole("list", { name: "Narrowed to" })).not.toBeInTheDocument();
    await expect.poll(() => lastQuery(api, "/metrics/chart")).not.toHaveProperty("host");
  });

  test("the Services page: a route without a name has no rule link", async () => {
    const api = installFakeApi();
    api.services = (query) => {
      const list = fakeServices(query);
      const [web] = list.services;
      if (web !== undefined) {
        web.routes = [
          ...web.routes,
          {
            route: "",
            requests: 5,
            failed: 0,
            p50Us: 1,
            p95Us: 1,
            p99Us: 1,
            statuses: { "2xx": 5, "3xx": 0, "4xx": 0, "5xx": 0, none: 0 },
          },
        ];
      }
      return list;
    };
    renderApp(SERVICES);
    await expect.element(page.getByText("(no name)")).toBeVisible();
    const row = page.getByText("(no name)").element().closest("tr");
    expect(row?.querySelector("a[aria-label^='Add an alert rule']")).toBeNull();
  });

  test("an alert's link to a service or route the list does not hold says so", async () => {
    const api = installFakeApi();
    api.services = (query) => ({ ...fakeServices(query), truncated: true });
    const router = renderApp(`${SERVICES}?service=search`);
    await expect.element(page.getByText("search is not in the list")).toBeVisible();
    expect(page.getByText("No requests in this period").elements()).toEqual([]);

    // billing lists 1 of its 140 routes.
    await router.navigate({
      to: SERVICES,
      search: { service: "billing", route: "GET /refunds" },
    });
    await expect
      .element(page.getByText("The route GET /refunds is not among the 1 busiest listed here."))
      .toBeVisible();
    // web lists all its routes.
    await router.navigate({ to: SERVICES, search: { service: "web", route: "GET /gone" } });
    await expect
      .element(page.getByText("No request of the route GET /gone arrived in this period."))
      .toBeVisible();
  });
});

describe("a rule's evaluation on the Alerts page", () => {
  test("a rule that cannot be evaluated says since when, and why", async () => {
    const api = installFakeApi();
    const [first] = api.alerts.rules;
    if (first === undefined) throw new Error("the fixtures changed");
    api.alerts.rules = [
      {
        ...first,
        evaluationError: {
          message: "Timeout exceeded: elapsed 15 seconds",
          since: "2026-11-16T01:41:00.000Z",
        },
      },
      ...api.alerts.rules.slice(1),
    ];
    renderApp(ALERTS);
    await expect
      .element(
        page.getByText(
          "Not evaluated since 16 Nov 2026, 09:41: Timeout exceeded: elapsed 15 seconds",
        ),
      )
      .toBeVisible();
  });

  test("a warning that could not be checked has its own title", async () => {
    installFakeApi();
    renderApp(ALERTS);
    await page.getByRole("button", { name: "Add rule" }).click();
    const form = dialog("Add an alert rule");
    await choose(form, "When", "Route failures");
    // The fake API cannot look for this one.
    await form.getByLabelText("Service").fill("unreachable");
    await form.getByLabelText("Failed above (percent)").fill("5");
    await form.getByRole("checkbox", { name: /On call/ }).click();
    await form.getByRole("button", { name: "Add rule" }).click();
    await expect.element(form).not.toBeInTheDocument();
    await expect
      .element(
        page.getByText(
          "“Route failures” is saved; whether it has anything to watch could not be checked",
        ),
      )
      .toBeVisible();
    expect(page.getByText(/has nothing to watch yet/).elements()).toEqual([]);
  });
});
