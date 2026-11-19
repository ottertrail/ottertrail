import { describe, expect, test } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser/context";

import {
  ERROR_FINGERPRINTS,
  FAKE_SPANS,
  FAKE_TRACE_ID,
  type FakeApi,
  fakeServerError,
  installFakeApi,
  LONG_BODY,
  noLogs,
  noTraces,
  PROJECT,
} from "./fake-api.ts";
import { renderApp } from "./render.tsx";

const TRACES = `/projects/${PROJECT.id}/traces`;
const TRACE = `${TRACES}/${FAKE_TRACE_ID}`;
const LOGS = `/projects/${PROJECT.id}/logs`;

/** The query of the latest GET request to a path ending in `path`. */
function lastQuery(api: FakeApi, path: string): Record<string, string> {
  const request = api.requests.findLast((item) => item.split("?")[0]?.endsWith(path)) ?? "";
  const at = request.indexOf("?");
  return at === -1 ? {} : Object.fromEntries(new URLSearchParams(request.slice(at + 1)));
}

const sidebarLink = (name: string) =>
  page.getByRole("navigation", { name: "Project" }).getByRole("link", { name });

const tracesTable = () =>
  page.getByRole("table", { name: "Traces, newest first, by their root span" });
const traceRows = () => tracesTable().element().querySelectorAll("tbody tr").length;

const waterfall = () =>
  page.getByRole("table", { name: /^Spans appear under their parents in start order/ });
/** The waterfall's span buttons' accessible names, in order. */
const waterfallButtons = () =>
  [...waterfall().element().querySelectorAll("tbody button")].map((button) =>
    button.textContent?.trim(),
  );

/** The selected log record, beside the list. */
const logPane = () => page.getByRole("region", { name: "Logs, selected" });

const logEntries = (name: string) => [
  ...page.getByRole("list", { name }).element().querySelectorAll(":scope > li"),
];

describe("the traces page", () => {
  test("opens from the sidebar with a project's traces, newest first", async () => {
    const api = installFakeApi();
    const router = renderApp(`/projects/${PROJECT.id}/errors`);
    await sidebarLink("Traces").click();

    await expect.poll(() => router.state.location.pathname).toBe(TRACES);
    await expect.poll(traceRows).toBe(100);
    expect(lastQuery(api, "/traces")).toEqual({ period: "7d" });
    await expect.element(sidebarLink("Traces")).toHaveAttribute("data-active");
    const first = [...tracesTable().element().querySelectorAll("tbody tr")][0];
    // The root span's name, service, start, and status; its duration and spans.
    expect(
      [...(first?.querySelectorAll("a, td > p > *, td:not(:first-child)") ?? [])].map(
        (cell) => cell.textContent,
      ),
    ).toEqual([
      "POST /orders/{id}/charge",
      "web",
      "16 Nov 2026, 16:00:00.000",
      "Error",
      "182 ms",
      "5",
    ]);
  });

  test("filters by service and errors, keeps them in the address, and pages back", async () => {
    const api = installFakeApi();
    const router = renderApp(TRACES);
    await expect.poll(traceRows).toBe(100);

    await page.getByRole("button", { name: "Load older traces" }).click();
    await expect.poll(traceRows).toBe(130);
    expect(lastQuery(api, "/traces")).toEqual({ period: "7d", before: `100-${"0".repeat(48)}` });

    await page.getByRole("combobox", { name: "Service" }).click();
    await page.getByRole("option", { name: "worker" }).click();
    await expect.poll(() => router.state.location.search).toEqual({ service: "worker" });
    await expect.poll(() => lastQuery(api, "/traces")).toEqual({ period: "7d", service: "worker" });

    await page.getByRole("checkbox", { name: "With errors only" }).click();
    await expect
      .poll(() => lastQuery(api, "/traces"))
      .toEqual({ period: "7d", service: "worker", errors: "true" });
    expect(router.state.location.search).toEqual({ service: "worker", errors: true });
    await expect.element(page.getByText("No trace matches these filters")).toBeVisible();

    await page.getByRole("combobox", { name: "Minimum duration" }).click();
    await page.getByRole("option", { name: "100 ms or longer" }).click();
    await expect
      .poll(() => lastQuery(api, "/traces"))
      .toEqual({ period: "7d", service: "worker", errors: "true", minDuration: "100" });
  });

  test("shows how to send traces while the project has none, without the secret key", async () => {
    installFakeApi({ traces: noTraces });
    renderApp(TRACES);

    await expect.element(page.getByText("No traces yet")).toBeVisible();
    const code = document.querySelector("pre")?.textContent ?? "";
    expect(code).toContain(`OTEL_EXPORTER_OTLP_ENDPOINT=${window.location.origin}`);
    expect(code).toContain("Authorization=Bearer%20sk_…");
    expect(document.body.textContent).not.toContain(PROJECT.secretKey);
    await expect.element(page.getByRole("button", { name: "Copy the settings" })).toBeVisible();
    await expect
      .element(page.getByRole("link", { name: "Project settings" }))
      .toHaveAttribute("href", `/projects/${PROJECT.id}/settings?tab=server`);
    // Nothing to filter yet.
    expect(page.getByRole("combobox", { name: "Service" }).elements()).toEqual([]);
  });
});

describe("a trace's page", () => {
  test("shows the spans as a tree, the root's detail, and the trace's logs", async () => {
    installFakeApi();
    renderApp(TRACE);

    await expect.element(waterfall()).toBeVisible();
    expect(waterfallButtons()).toEqual([
      "Top level: POST /orders/{id}/charge",
      "Level 2: SELECT orders",
      "Level 2: charge card",
      "Level 3: gateway call",
      "Top level, parent not received: background refresh",
    ]);
    // Each row: its start from the trace's, and its duration, beside the bar.
    const charge = [...waterfall().element().querySelectorAll("tbody tr")][2];
    expect(
      [...(charge?.querySelectorAll("td") ?? [])].slice(1, 3).map((cell) => cell.textContent),
    ).toEqual(["+5 ms", "170 ms"]);
    expect(charge?.querySelector("td:last-child")?.getAttribute("aria-hidden")).toBe("true");

    // The root is shown first.
    await expect
      .element(page.getByRole("heading", { name: "Span: POST /orders/{id}/charge" }))
      .toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Top level: POST /orders/{id}/charge" }))
      .toHaveAttribute("aria-pressed", "true");
    await expect.element(page.getByText("None: a root span")).toBeVisible();

    expect(logEntries("The trace's log records, oldest first")).toHaveLength(2);
  });

  test("shows a chosen span's status, attributes, events, and links", async () => {
    installFakeApi();
    const router = renderApp(TRACE);
    await page.getByRole("button", { name: "Level 2: charge card" }).click();

    await expect.poll(() => router.state.location.search).toEqual({ span: FAKE_SPANS.charge });
    await expect.element(page.getByRole("heading", { name: "Span: charge card" })).toBeVisible();
    await expect.element(page.getByText("Error: card declined")).toBeVisible();
    await expect
      .element(page.getByRole("table", { name: "Span attributes" }))
      .toMatchTextContent(/order\.id5120/);
    await expect
      .element(page.getByText("2 more attributes were dropped before storing."))
      .toBeVisible();
    await expect
      .element(page.getByRole("list", { name: "Events, in the order sent" }))
      .toMatchTextContent(/exception\+165 ms from the span's start/);
    await expect
      .element(page.getByRole("link", { name: `Open linked trace ${"f".repeat(32)}` }))
      .toBeVisible();
    await expect
      .element(page.getByRole("table", { name: "Resource attributes" }))
      .toMatchTextContent(/service\.namepayments/);
  });

  test("a log record opens to its attributes and shows its span", async () => {
    installFakeApi();
    const router = renderApp(TRACE);
    const list = page.getByRole("list", { name: "The trace's log records, oldest first" });
    await list.getByRole("button", { name: /Payment declined/ }).click();

    await expect
      .element(list.getByRole("button", { name: /Payment declined/ }))
      .toHaveAttribute("aria-expanded", "true");
    await expect.element(list.getByRole("table", { name: "Attributes" })).toBeVisible();
    await list.getByRole("button", { name: "Show its span: charge card" }).click();

    await expect.poll(() => router.state.location.search).toEqual({ span: FAKE_SPANS.charge });
    await expect.element(page.getByRole("heading", { name: "Span: charge card" })).toBeVisible();
  });

  test("says plainly when no span of the trace is kept", async () => {
    installFakeApi();
    renderApp(`${TRACES}/${"a".repeat(32)}?at=2026-11-01T00%3A00%3A00.000Z`);

    await expect.element(page.getByText("No spans of this trace are kept")).toBeVisible();
    await expect.element(page.getByText(/Traces are kept 30 days/)).toBeVisible();
    await expect
      .element(page.getByText(/a day either side of 1 Nov 2026, 08:00:00.000/))
      .toBeVisible();
    await expect.element(page.getByText("No log record of this trace is kept.")).toBeVisible();
  });

  test("says when the address is not a trace ID", async () => {
    const api = installFakeApi();
    renderApp(`${TRACES}/not-a-trace`);
    await expect.element(page.getByText("Not a trace ID")).toBeVisible();
    expect(api.requests.some((request) => request.includes("/traces/"))).toBe(false);
  });
});

describe("from an error to its trace", () => {
  test("a server occurrence's trace ID opens the trace on its span", async () => {
    const api = installFakeApi({ error: fakeServerError });
    const router = renderApp(`/projects/${PROJECT.id}/errors/${ERROR_FINGERPRINTS.typeError}`);

    await expect.element(page.getByRole("heading", { name: "Server" })).toBeVisible();
    expect(page.getByText("Planned", { exact: true }).elements()).toEqual([]);
    const links = page.getByRole("link", { name: `Open trace ${FAKE_TRACE_ID}` });
    // In the Server card, and in each occurrence's row.
    expect(links.elements().length).toBeGreaterThan(1);
    await links.first().click();

    await expect.poll(() => router.state.location.pathname).toBe(TRACE);
    const search: Record<string, unknown> = router.state.location.search;
    expect(search).toEqual({
      at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      span: FAKE_SPANS.charge,
    });
    await expect
      .element(page.getByRole("button", { name: "Level 2: charge card" }))
      .toHaveAttribute("aria-pressed", "true");
    // The trace is looked for around the occurrence's time.
    expect(lastQuery(api, `/traces/${FAKE_TRACE_ID}`)).toEqual({ at: search.at });
  });
});

describe("the logs page", () => {
  test("opens from the sidebar with log records, each opening to its attributes and trace", async () => {
    const api = installFakeApi();
    const router = renderApp(TRACES);
    await sidebarLink("Logs").click();

    await expect.poll(() => router.state.location.pathname).toBe(LOGS);
    await expect.poll(() => logEntries("Log records, newest first").length).toBe(50);
    expect(lastQuery(api, "/logs")).toEqual({ period: "7d" });

    // A record opens beside the list; its trace, in the Traces workbench on its span.
    const list = page.getByRole("list", { name: "Log records, newest first" });
    await list.getByRole("button", { name: /Payment declined/ }).click();
    await expect
      .element(logPane().getByRole("table", { name: "Attributes" }))
      .toMatchTextContent(/order\.id5120/);
    await expect
      .element(logPane().getByRole("table", { name: "Resource attributes" }))
      .toMatchTextContent(/host\.nameweb-1/);
    await logPane()
      .getByRole("link", { name: `Open trace ${FAKE_TRACE_ID}` })
      .click();

    await expect.poll(() => router.state.location.pathname).toBe(TRACES);
    expect(router.state.location.search).toEqual({
      trace: FAKE_TRACE_ID,
      at: "2026-11-16T08:00:00.000Z",
      span: FAKE_SPANS.charge,
    });
    await expect
      .element(page.getByRole("button", { name: "Level 2: charge card" }))
      .toHaveAttribute("aria-pressed", "true");
  });

  test("searches words, filters by severity and trace, and pages back", async () => {
    const api = installFakeApi();
    const router = renderApp(LOGS);
    await expect.poll(() => logEntries("Log records, newest first").length).toBe(50);

    await page.getByRole("button", { name: "Load older logs" }).click();
    await expect.poll(() => logEntries("Log records, newest first").length).toBe(70);

    await userEvent.type(
      page.getByRole("searchbox", { name: "Words in the message" }),
      "declined{Enter}",
    );
    await expect.poll(() => lastQuery(api, "/logs")).toEqual({ period: "7d", search: "declined" });
    expect(router.state.location.search).toEqual({ q: "declined" });
    await expect.poll(() => logEntries("Log records, newest first").length).toBe(1);

    await page.getByRole("combobox", { name: "Minimum severity" }).click();
    await page.getByRole("option", { name: "Warning and above" }).click();
    await expect
      .poll(() => lastQuery(api, "/logs"))
      .toEqual({ period: "7d", search: "declined", severity: "warn" });

    // A trace ID that is not one is not sent.
    const traceField = page.getByRole("searchbox", { name: "Trace ID" });
    await userEvent.type(traceField, "abc{Enter}");
    expect(lastQuery(api, "/logs")).toEqual({ period: "7d", search: "declined", severity: "warn" });
    await userEvent.clear(traceField);
    await userEvent.type(traceField, `${FAKE_TRACE_ID.toUpperCase()}{Enter}`);
    await expect
      .poll(() => lastQuery(api, "/logs"))
      .toEqual({ period: "7d", search: "declined", severity: "warn", traceId: FAKE_TRACE_ID });
    expect(router.state.location.search).toEqual({
      q: "declined",
      severity: "warn",
      trace: FAKE_TRACE_ID,
    });
  });

  test("a row shows the start of a long body; opening it reads the whole record", async () => {
    const api = installFakeApi();
    renderApp(LOGS);
    const list = page.getByRole("list", { name: "Log records, newest first" });
    await expect.poll(() => logEntries("Log records, newest first").length).toBe(50);

    const row = list.getByRole("button", { name: /stack dump/ });
    // The summary's 1,000 characters, marked as cut; not the whole body.
    const text = row.element().textContent ?? "";
    expect(text).toContain(`${LONG_BODY.slice(0, 1000)}…`);
    expect(text).not.toContain("the end");
    expect(api.requests.some((request) => request.includes("/logs/"))).toBe(false);

    await row.click();
    await expect.element(logPane().getByText(/the end$/)).toBeVisible();
    expect(api.requests).toContain(
      `/api/projects/${PROJECT.id}/logs/${"1".padStart(32, "0")}?time=${Date.UTC(2026, 10, 16, 7, 59)}000000`,
    );
    await expect.element(logPane().getByRole("table", { name: "Attributes" })).toBeVisible();
  });

  test("an opened record that cannot load says so, with a retry", async () => {
    installFakeApi({ log: () => new Response("{}", { status: 500 }) });
    renderApp(LOGS);
    const list = page.getByRole("list", { name: "Log records, newest first" });
    await list.getByRole("button", { name: /Payment declined/ }).click();
    await expect.element(logPane().getByText("The record could not load")).toBeVisible();
    await expect.element(logPane().getByRole("button", { name: "Retry" })).toBeVisible();
    // The trace link needs only the summary.
    await expect
      .element(logPane().getByRole("link", { name: `Open trace ${FAKE_TRACE_ID}` }))
      .toBeVisible();
  });

  test("says when nothing matches", async () => {
    installFakeApi();
    renderApp(`${LOGS}?q=nothing-like-this`);
    await expect.element(page.getByText("No log record matches these filters")).toBeVisible();
  });

  test("shows how to send logs while the project has none", async () => {
    installFakeApi({ logs: noLogs });
    renderApp(LOGS);
    await expect.element(page.getByText("No logs yet")).toBeVisible();
    expect(document.querySelector("pre")?.textContent).toContain("OTEL_EXPORTER_OTLP_PROTOCOL");
    expect(page.getByRole("searchbox", { name: "Words in the message" }).elements()).toEqual([]);
  });
});
