import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser/context";

import { LIVE_TIMING } from "../../src/features/telemetry/live-logs.ts";
import type { LiveLogs, LogSummary } from "../../src/lib/logs-api.ts";
import {
  type FakeApi,
  berlinDays,
  fakeLogRecord,
  fakeLogVolume,
  fakeTraceChart as installedTraceChart,
  installFakeApi,
  noLiveLogs,
  PROJECT,
  summaryOf,
} from "./fake-api.ts";
import { renderApp } from "./render.tsx";

/**
 * The charts above the Logs and Traces lists, the logs' one-line rows, and
 * the Logs page's live view (docs/dashboard.md, "Traces and logs").
 */

const LOGS = `/projects/${PROJECT.id}/logs`;
const TRACES = `/projects/${PROJECT.id}/traces`;

/** The query of the latest GET request to a path ending in `path`. */
function lastQuery(api: FakeApi, path: string): Record<string, string> {
  const request = api.requests.findLast((item) => item.split("?")[0]?.endsWith(path)) ?? "";
  const at = request.indexOf("?");
  return at === -1 ? {} : Object.fromEntries(new URLSearchParams(request.slice(at + 1)));
}

const requestsTo = (api: FakeApi, path: string) =>
  api.requests.filter((item) => item.split("?")[0]?.endsWith(path)).length;

const chartSection = (title: string) => page.getByRole("region", { name: title });
const plotOf = (title: string) =>
  chartSection(title).element().querySelector<HTMLElement>("[data-slot=stacked-bar-chart]");
const legendOf = (title: string) =>
  [
    ...chartSection(title).getByRole("list", { name: "Legend" }).element().querySelectorAll("li"),
  ].map((item) => item.textContent);

/** A response whose body never comes: the request stays loading. */
const pending = () => new Response(new ReadableStream({ start() {} }), { status: 200 });

const logRows = (name = "Log records, newest first") => [
  ...page.getByRole("list", { name }).element().querySelectorAll(":scope > li"),
];

/** A pointer at bucket `index` of a chart, as a click selects it. */
function clickBucket(plot: HTMLElement, index: number, buckets: number) {
  const box = plot.getBoundingClientRect();
  // The plot starts 56px in and ends 16px before the right edge.
  const slot = (box.width - 56 - 16) / buckets;
  plot.dispatchEvent(
    new PointerEvent("pointerup", {
      clientX: box.left + 56 + slot * (index + 0.5),
      clientY: box.top + 60,
      bubbles: true,
    }),
  );
}

function expectNoSidewaysScroll(width: number) {
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
  const panel = document.querySelector("[data-slot=app-content]");
  expect(panel?.scrollWidth).toBeLessThanOrEqual(panel?.clientWidth ?? 0);
}

describe("the logs chart", () => {
  test("stacks the period's records by severity, with a legend, a readout, and its numbers", async () => {
    await page.viewport(1440, 900);
    const api = installFakeApi();
    renderApp(LOGS);
    await expect.element(chartSection("Records over time")).toBeVisible();
    await expect
      .element(page.getByRole("slider", { name: "Records per 2 hours, by severity" }))
      .toBeVisible();
    expect(lastQuery(api, "/logs/volume")).toEqual({ period: "7d" });
    expect(legendOf("Records over time")).toEqual([
      "Error or worse",
      "Warning",
      "Info",
      "Debug, trace, or none",
    ]);
    // Status colors for what is wrong, neutrals for the rest, errors on the baseline.
    const plot = plotOf("Records over time");
    const first = plot?.querySelector('[data-bucket="0"]');
    expect(
      [...(first?.querySelectorAll("path") ?? [])].map((part) => [
        part.dataset.part,
        part.getAttribute("fill"),
      ]),
    ).toEqual([
      ["error", "var(--status-critical)"],
      ["warn", "var(--status-warning)"],
      ["info", "var(--chart-neutral)"],
      ["other", "var(--ink-tertiary)"],
    ]);
    // The keyboard's readout: the latest bucket, every part, and the total.
    await expect
      .element(page.getByRole("slider", { name: "Records per 2 hours, by severity" }))
      .toHaveAttribute(
        "aria-valuetext",
        "Mon 16 Nov 2026, 22:00 to Tue 17 Nov 2026, 00:00: 9 in all, Error or worse 0, Warning 0, Info 9, Debug, trace, or none 0",
      );

    // Hovering a bar shows its counts.
    if (plot === null) throw new Error("no plot");
    await userEvent.hover(plot);
    const tooltip = plot.querySelector("[data-slot=chart-tooltip]");
    expect(tooltip?.textContent).toMatch(/In all/);
    expect(tooltip?.textContent).toMatch(/Click to show this day$/);

    // Its numbers, as a table.
    await chartSection("Records over time")
      .getByRole("button", { name: "Show the numbers" })
      .click();
    const table = chartSection("Records over time").getByRole("table", {
      name: "Records over time",
    });
    await expect.element(table).toBeVisible();
    const header = [...table.element().querySelectorAll("thead th")].map(
      (cell) => cell.textContent,
    );
    expect(header).toEqual([
      "Time",
      "Error or worse",
      "Warning",
      "Info",
      "Debug, trace, or none",
      "In all",
    ]);
    const firstRow = [...table.element().querySelectorAll("tbody tr:first-child > *")].map(
      (cell) => cell.textContent,
    );
    expect(firstRow).toEqual(["Tue 10 Nov 2026, 00:00 to 02:00", "1", "2", "3", "1", "7"]);
  });

  test("follows the filters, and a bar narrows the period to its day", async () => {
    await page.viewport(1440, 900);
    const api = installFakeApi();
    const router = renderApp(`${LOGS}?severity=warn&q=declined`);
    await expect.element(chartSection("Records over time")).toBeVisible();
    expect(lastQuery(api, "/logs/volume")).toEqual({
      period: "7d",
      severity: "warn",
      search: "declined",
    });
    await expect.element(page.getByRole("slider", { name: /^Records per/ })).toBeVisible();
    const plot = plotOf("Records over time");
    if (plot === null) throw new Error("no plot");
    // The 13th bucket of 2 hours: 11 November, from midnight in Singapore.
    clickBucket(plot, 12, 84);
    await expect
      .poll(() => router.state.location.search)
      .toEqual({ from: "2026-11-11", to: "2026-11-11", severity: "warn", q: "declined" });
    await expect
      .poll(() => lastQuery(api, "/logs/volume"))
      .toEqual({ from: "2026-11-11", to: "2026-11-11", severity: "warn", search: "declined" });
    // A day in buckets of 15 minutes: nothing narrower to choose.
    await expect
      .element(page.getByRole("slider", { name: "Records per 15 minutes, by severity" }))
      .toBeVisible();
    const day = plotOf("Records over time");
    if (day === null) throw new Error("no plot");
    await userEvent.hover(day);
    expect(day.querySelector("[data-slot=chart-tooltip]")?.textContent).not.toMatch(/Click/);
    clickBucket(day, 3, 96);
    expect(router.state.location.search).toMatchObject({ from: "2026-11-11", to: "2026-11-11" });
  });

  test("in Europe/Berlin, a day's bar narrows to that day across the change of clocks", async () => {
    await page.viewport(1440, 900);
    installFakeApi({
      logVolume: (query) =>
        query.get("from") === "2026-09-01" || query.get("from") === null
          ? {
              ...fakeLogVolume(new URLSearchParams()),
              ...berlinDays(),
              total: 90 * 10,
              counts: {
                ...fakeLogVolume(new URLSearchParams()).counts,
                info: Array.from({ length: 90 }, () => 10),
                debug: Array.from({ length: 90 }, () => 0),
                warn: Array.from({ length: 90 }, () => 0),
                error: Array.from({ length: 90 }, () => 0),
              },
            }
          : fakeLogVolume(query),
    });
    const router = renderApp(`${LOGS}?from=2026-09-01&to=2026-11-29`);
    await expect
      .element(page.getByRole("slider", { name: "Records per day, by severity" }))
      .toBeVisible();
    const plot = plotOf("Records over time");
    if (plot === null) throw new Error("no plot");
    // 26 October, the first day after the clocks went back: its midnight is 23:00 UTC.
    clickBucket(plot, 55, 90);
    await expect
      .poll(() => router.state.location.search)
      .toEqual({ from: "2026-10-26", to: "2026-10-26" });
  });

  test("loads and fails on its own, and the list does not wait for it", async () => {
    await page.viewport(1440, 900);
    const api = installFakeApi({ logVolume: pending });
    renderApp(LOGS);
    await expect.poll(() => logRows().length).toBe(50);
    await expect.element(page.getByLabelText("Loading the chart: Records over time")).toBeVisible();

    api.logVolume = () => new Response("{}", { status: 500 });
    await page.getByRole("combobox", { name: "Minimum severity" }).click();
    await page.getByRole("option", { name: "Warning and above" }).click();
    await expect.element(page.getByText("The chart could not load")).toBeVisible();
    // The list still answers for the same filters.
    await expect.poll(() => lastQuery(api, "/logs")).toEqual({ period: "7d", severity: "warn" });
    await expect.poll(() => logRows().length).toBeGreaterThan(0);
    expect(page.getByRole("button", { name: "Show the numbers" }).elements()).toEqual([]);

    api.logVolume = fakeLogVolume;
    await chartSection("Records over time").getByRole("button", { name: "Retry" }).click();
    await expect
      .element(page.getByRole("slider", { name: "Records per 2 hours, by severity" }))
      .toBeVisible();
  });

  test("says when the filters find nothing to chart", async () => {
    await page.viewport(1440, 900);
    installFakeApi({
      logVolume: (query) => ({ ...fakeLogVolume(query), total: 0 }),
    });
    renderApp(LOGS);
    await expect
      .element(page.getByText("No records to chart for these filters in this period."))
      .toBeVisible();
  });
});

describe("the logs list's rows", () => {
  test("at 1440, each record is one line: time, severity, service, and the message cut short", async () => {
    await page.viewport(1440, 900);
    installFakeApi();
    renderApp(LOGS);
    await expect.poll(() => logRows().length).toBe(50);
    const row = logRows()[1]?.querySelector("button");
    const parts = [...(row?.querySelectorAll<HTMLElement>(":scope > *") ?? [])];
    expect(parts[0]?.tagName).toBe("TIME");
    // Every part on the same line: their middles within a pixel or two.
    const middles = parts.map((part) => {
      const box = part.getBoundingClientRect();
      return box.top + box.height / 2;
    });
    expect(Math.max(...middles) - Math.min(...middles)).toBeLessThan(3);
    expect(row?.getBoundingClientRect().height).toBeLessThan(40);
    const message = parts.at(-1);
    if (message === undefined) throw new Error("no message");
    expect(getComputedStyle(message).textOverflow).toBe("ellipsis");
    expect(getComputedStyle(message).whiteSpace).toBe("nowrap");
    expect(message.scrollWidth).toBeGreaterThan(message.clientWidth);
    expectNoSidewaysScroll(1440);
  });

  test("at 390, a record takes two lines, the message under its time, and nothing spills", async () => {
    await page.viewport(390, 844);
    installFakeApi();
    renderApp(LOGS);
    await expect.poll(() => logRows().length).toBe(50);
    const row = logRows()[1]?.querySelector("button");
    const time = row?.querySelector("time");
    const message = row?.lastElementChild;
    if (time === null || time === undefined || message === null || message === undefined) {
      throw new Error("no row");
    }
    expect(message.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      time.getBoundingClientRect().bottom,
    );
    expect(row?.getBoundingClientRect().height).toBeLessThan(64);
    expect(getComputedStyle(message).textOverflow).toBe("ellipsis");
    expect(row?.getBoundingClientRect().right).toBeLessThanOrEqual(390);
    // The chart fits too.
    await expect.element(page.getByRole("slider", { name: /^Records per/ })).toBeVisible();
    expect(plotOf("Records over time")?.getBoundingClientRect().right).toBeLessThanOrEqual(390);
    expectNoSidewaysScroll(390);
  });
});

describe("the traces chart", () => {
  test("counts traces with and without errors, toggles to the 95th-percentile duration, and has its numbers", async () => {
    await page.viewport(1440, 900);
    const api = installFakeApi();
    renderApp(`${TRACES}?errors=true&service=web`);
    await expect.element(chartSection("Traces over time")).toBeVisible();
    await expect
      .element(page.getByRole("slider", { name: "Traces per 2 hours, with errors and without" }))
      .toBeVisible();
    expect(lastQuery(api, "/traces/chart")).toEqual({
      period: "7d",
      service: "web",
      errors: "true",
    });
    expect(legendOf("Traces over time")).toEqual(["With errors", "Without errors"]);
    const plot = plotOf("Traces over time");
    expect(
      [...(plot?.querySelectorAll('[data-bucket="0"] path') ?? [])].map((part) =>
        part.getAttribute("fill"),
      ),
    ).toEqual(["var(--status-critical)", "var(--chart-neutral)"]);
    if (plot === null) throw new Error("no plot");
    await userEvent.hover(plot);
    expect(plot.querySelector("[data-slot=chart-tooltip]")?.textContent).toMatch(
      /With errors.*Without errors.*In all/,
    );

    await page.getByRole("button", { name: "Duration" }).click();
    await expect.element(chartSection("Duration over time")).toBeVisible();
    await expect
      .element(page.getByRole("slider", { name: "95th-percentile duration per 2 hours" }))
      .toBeVisible();
    // One line: no legend.
    expect(
      chartSection("Duration over time").getByRole("list", { name: "Legend" }).elements(),
    ).toEqual([]);
    await chartSection("Duration over time")
      .getByRole("button", { name: "Show the numbers" })
      .click();
    const table = chartSection("Duration over time").getByRole("table");
    const header = [...table.element().querySelectorAll("thead th")].map(
      (cell) => cell.textContent,
    );
    expect(header).toEqual(["Time", "Traces", "With errors", "95th percentile"]);
    expect(
      [...table.element().querySelectorAll("tbody tr:first-child > *")].map(
        (cell) => cell.textContent,
      ),
    ).toEqual(["Tue 10 Nov 2026, 00:00 to 02:00", "5", "1", "120 ms"]);
  });

  test("a bar narrows the period to its day; a failed chart leaves the list as it is", async () => {
    await page.viewport(1440, 900);
    const api = installFakeApi();
    const router = renderApp(TRACES);
    await expect.element(page.getByRole("slider", { name: /^Traces per 2 hours/ })).toBeVisible();
    const plot = plotOf("Traces over time");
    if (plot === null) throw new Error("no plot");
    clickBucket(plot, 83, 84);
    await expect
      .poll(() => router.state.location.search)
      .toEqual({ from: "2026-11-16", to: "2026-11-16" });

    api.traceChart = () => new Response("{}", { status: 503 });
    await page.getByRole("checkbox", { name: "With errors only" }).click();
    await expect.element(page.getByText("The chart could not load")).toBeVisible();
    await expect.poll(() => lastQuery(api, "/traces")).toMatchObject({ errors: "true" });
    const rows = page.getByRole("table", { name: "Traces, newest first, by their root span" });
    await expect.element(rows).toBeVisible();
    expect(rows.element().querySelectorAll("tbody tr").length).toBeGreaterThan(0);
  });

  test("says when errors were counted among the latest failed spans only", async () => {
    await page.viewport(1440, 900);
    installFakeApi({
      traceChart: (query) => ({ ...installedTraceChart(query), failedCapped: true }),
    });
    renderApp(TRACES);
    await expect
      .element(
        chartSection("Traces over time").getByText(
          /Errors counted among the latest 10,000 failed spans\./,
        ),
      )
      .toBeVisible();
  });

  test("the duration's readout spans a bucket to the next one's start across a change of clocks", async () => {
    await page.viewport(1440, 900);
    // 6-hour buckets in Europe/Berlin around 25 October: 00:00 that day lasts 7 hours.
    const bucketStarts = [
      "2026-10-24T16:00:00.000Z",
      "2026-10-24T22:00:00.000Z",
      "2026-10-25T05:00:00.000Z",
      "2026-10-25T11:00:00.000Z",
    ];
    installFakeApi({
      traceChart: (query) => ({
        ...installedTraceChart(query),
        timeZone: "Europe/Berlin",
        firstDay: "2026-10-24",
        lastDay: "2026-10-25",
        start: bucketStarts[0] ?? "",
        bucketStarts,
        stepSeconds: 21_600,
        buckets: 4,
        traces: [3, 4, 0, 0],
        failed: [0, 1, 0, 0],
        // Only the bucket across the change has a duration: the readout starts on it.
        p95Us: [null, 150_000, null, null],
        total: { traces: 7, failed: 1 },
      }),
    });
    renderApp(TRACES);
    await page.getByRole("button", { name: "Duration" }).click();
    await expect
      .element(page.getByRole("slider", { name: "95th-percentile duration per 6 hours" }))
      .toHaveAttribute("aria-valuetext", "Sun 25 Oct 2026, 00:00 to 06:00: 95th percentile 150 ms");
  });

  test("loads on its own while the list shows", async () => {
    await page.viewport(390, 844);
    installFakeApi({ traceChart: pending });
    renderApp(TRACES);
    await expect
      .element(page.getByRole("table", { name: "Traces, newest first, by their root span" }))
      .toBeVisible();
    await expect.element(page.getByLabelText("Loading the chart: Traces over time")).toBeVisible();
    expectNoSidewaysScroll(390);
  });
});

/** A record that arrived `n`th. */
const arrived = (n: number, body = `arrived ${n}`): LogSummary =>
  summaryOf(
    fakeLogRecord({
      id: (1000 + n).toString(16).padStart(32, "0"),
      time: new Date(Date.UTC(2026, 10, 16, 9, n)).toISOString(),
      timeNs: `${Date.UTC(2026, 10, 16, 9, n)}000000`,
      body,
    }),
  );

/** A live endpoint that answers each poll with the next of `answers`, then nothing new. */
function liveFeed(answers: LogSummary[][]) {
  let polls = 0;
  return (query: URLSearchParams): LiveLogs => {
    const logs = answers[polls] ?? [];
    polls += 1;
    return {
      timeZone: "Asia/Singapore",
      environment: query.get("environment") ?? "production",
      logs,
      cursor: String(polls),
      skipped: 0,
      gap: null,
    };
  };
}

/** A live endpoint that answers each poll with the first of `queue`, taken out, or nothing new. */
function queuedFeed(queue: LogSummary[][]) {
  let polls = 0;
  return (query: URLSearchParams): LiveLogs => {
    polls += 1;
    return {
      ...noLiveLogs(query),
      logs: queue.shift() ?? [],
      cursor: String(polls),
    };
  };
}

const liveBodies = () =>
  logRows("Log records, newest arrival first")
    .filter((row) => !row.hasAttribute("data-live-note"))
    .map((row) => row.querySelector("button > span:last-child")?.textContent);

/** The live list as text: each record's body, and each note's line. */
const liveLines = () =>
  logRows("Log records, newest arrival first").map((row) =>
    row.hasAttribute("data-live-note")
      ? row.textContent
      : row.querySelector("button > span:last-child")?.textContent,
  );

/** The selected log record, beside the list. */
const logPane = () => page.getByRole("region", { name: "Logs, selected" });

describe("live logs", () => {
  const defaults = { ...LIVE_TIMING };
  beforeEach(() => {
    // Fast polls: the floor between polls has a test of its own.
    LIVE_TIMING.minGapMs = 0;
  });
  afterEach(() => {
    Object.assign(LIVE_TIMING, defaults);
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  });

  test("Live replaces the period, polls with the filters, and new records come in at the top, once each", async () => {
    await page.viewport(1440, 900);
    LIVE_TIMING.pollMs = 50;
    const api = installFakeApi({
      // A retried record's copy comes again in a later poll: shown once.
      liveLogs: liveFeed([[arrived(1)], [arrived(3), arrived(2), arrived(1)]]),
    });
    const router = renderApp(`${LOGS}?severity=warn`);
    await expect.element(chartSection("Records over time")).toBeVisible();
    await page.getByRole("switch", { name: "Live" }).click();

    await expect.poll(() => router.state.location.search).toEqual({ severity: "warn", live: true });
    await expect.poll(liveBodies).toEqual(["arrived 3", "arrived 2", "arrived 1"]);
    await expect.poll(() => lastQuery(api, "/logs/live")).toEqual({ severity: "warn", after: "2" });
    // The period gives way to Live; the chart is gone; the delay is said plainly.
    expect(page.getByRole("combobox", { name: "Period" }).elements()).toEqual([]);
    await expect.element(page.getByRole("button", { name: "Period: Live" })).toBeDisabled();
    expect(page.getByRole("region", { name: "Records over time" }).elements()).toEqual([]);
    await expect
      .element(page.getByText(/^Records appear a few seconds after they are sent/).first())
      .toBeVisible();

    // Off: the period's view again.
    await page.getByRole("switch", { name: "Live" }).click();
    await expect.poll(() => router.state.location.search).toEqual({ severity: "warn" });
    await expect.element(page.getByRole("combobox", { name: "Period" })).toBeVisible();
    await expect.element(chartSection("Records over time")).toBeVisible();
    await expect.poll(() => logRows().length).toBeGreaterThan(0);
    const polls = requestsTo(api, "/logs/live");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(requestsTo(api, "/logs/live")).toBe(polls);
  });

  test("Pause holds new records under a button; Resume puts them at the top", async () => {
    await page.viewport(1440, 900);
    LIVE_TIMING.pollMs = 50;
    const queue: LogSummary[][] = [[arrived(1)]];
    installFakeApi({ liveLogs: queuedFeed(queue) });
    renderApp(`${LOGS}?live=true`);
    await expect.poll(liveBodies).toEqual(["arrived 1"]);

    await page.getByRole("button", { name: "Pause" }).click();
    await expect.element(page.getByText("Paused. New records wait above the list.")).toBeVisible();
    queue.push([arrived(2)], [arrived(3)]);
    await expect.element(page.getByRole("button", { name: "2 new records" })).toBeVisible();
    expect(liveBodies()).toEqual(["arrived 1"]);

    await page.getByRole("button", { name: "Resume" }).click();
    await expect.poll(liveBodies).toEqual(["arrived 3", "arrived 2", "arrived 1"]);
    expect(page.getByRole("button", { name: /new record/ }).elements()).toEqual([]);
  });

  test('a selected record holds new ones under "N new records"', async () => {
    await page.viewport(1440, 900);
    LIVE_TIMING.pollMs = 50;
    const queue: LogSummary[][] = [[arrived(2), arrived(1)]];
    installFakeApi({ liveLogs: queuedFeed(queue) });
    const router = renderApp(`${LOGS}?live=true`);
    await expect.poll(liveBodies).toEqual(["arrived 2", "arrived 1"]);
    await page
      .getByRole("list", { name: "Log records, newest arrival first" })
      .getByRole("button", { name: /arrived 1/ })
      .click();
    await expect.poll(() => router.state.location.search).toMatchObject({ log: arrived(1).id });

    queue.push([arrived(3)]);
    await expect.element(page.getByRole("button", { name: "1 new record" })).toBeVisible();
    expect(liveBodies()).toEqual(["arrived 2", "arrived 1"]);
    await page.getByRole("button", { name: "1 new record" }).click();
    await expect.poll(liveBodies).toEqual(["arrived 3", "arrived 2", "arrived 1"]);
    // The selection stays.
    expect(router.state.location.search).toMatchObject({ log: arrived(1).id });
  });

  test('a selected record holds 1,200 arrivals as "1,000+ new records", and the list and the record stay', async () => {
    await page.viewport(1440, 900);
    LIVE_TIMING.pollMs = 50;
    const queue: LogSummary[][] = [[arrived(2), arrived(1)]];
    installFakeApi({ liveLogs: queuedFeed(queue) });
    const router = renderApp(`${LOGS}?live=true`);
    await expect.poll(liveBodies).toEqual(["arrived 2", "arrived 1"]);
    await page
      .getByRole("list", { name: "Log records, newest arrival first" })
      .getByRole("button", { name: /arrived 1/ })
      .click();
    await expect.poll(() => router.state.location.search).toMatchObject({ log: arrived(1).id });

    queue.push(Array.from({ length: 1200 }, (_, i) => arrived(100 + i)).toReversed());
    await expect.element(page.getByRole("button", { name: "1,000+ new records" })).toBeVisible();
    expect(liveBodies()).toEqual(["arrived 2", "arrived 1"]);
    await expect.element(logPane().getByRole("heading", { level: 2 })).toBeVisible();
    expect(logPane().element().textContent).not.toMatch(/not in the live list/);
  });

  test("a poll that skipped records says so where they were", async () => {
    await page.viewport(1440, 900);
    LIVE_TIMING.pollMs = 50;
    let polls = 0;
    installFakeApi({
      liveLogs: (query) => {
        polls += 1;
        const answer = noLiveLogs(query);
        if (polls === 1) return { ...answer, logs: [arrived(1)], cursor: "1" };
        if (polls === 2)
          return { ...answer, logs: [arrived(3), arrived(2)], skipped: 50, cursor: "2" };
        return answer;
      },
    });
    renderApp(`${LOGS}?live=true`);
    await expect
      .poll(liveLines)
      .toEqual([
        "arrived 3",
        "arrived 2",
        "50 records skipped; turn Live off to search them.",
        "arrived 1",
      ]);
  });

  test("Resume after the stop, and a return from a long hide, mark the gap the API reports", async () => {
    await page.viewport(1440, 900);
    LIVE_TIMING.pollMs = 50;
    LIVE_TIMING.stopAfterMs = 400;
    const gap = { from: "2026-11-16T04:01:00.000Z", to: "2026-11-16T04:16:00.000Z" };
    let polls = 0;
    let gapNext = false;
    const api = installFakeApi({
      liveLogs: (query) => {
        polls += 1;
        const answer = noLiveLogs(query);
        if (polls === 1) return { ...answer, logs: [arrived(1)], cursor: "100" };
        if (gapNext) {
          gapNext = false;
          return { ...answer, logs: [arrived(polls + 10)], cursor: String(200 + polls), gap };
        }
        return answer;
      },
    });
    renderApp(`${LOGS}?live=true`);
    await expect.element(page.getByText(/^Live stopped after/)).toBeVisible();
    gapNext = true;
    await page.getByRole("button", { name: "Resume" }).click();
    const line =
      "Records between 12:01 and 12:16 aren't shown. Turn Live off to search the period.";
    await expect.poll(() => liveLines().includes(line)).toBe(true);
    // The poll after the stop asks from where Live stopped; the API says what it left out.
    expect(lastQuery(api, "/logs/live").after).toBeDefined();
    expect(liveLines().at(-1)).toBe("arrived 1");
    expect(liveLines().at(-2)).toBe(line);

    // A tab hidden past the window: the first poll back reports the gap too.
    LIVE_TIMING.stopAfterMs = 60_000;
    await page.getByRole("button", { name: "Resume" }).click();
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    gapNext = true;
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await expect.poll(() => liveLines().filter((text) => text === line).length).toBe(2);
  });

  test("polls at most once a quarter second, and asks a busy API again quietly", async () => {
    await page.viewport(1440, 900);
    LIVE_TIMING.pollMs = 0;
    LIVE_TIMING.minGapMs = 250;
    let polls = 0;
    const api = installFakeApi({
      liveLogs: (query) => {
        polls += 1;
        // Busy at first: the API's places are taken.
        if (polls <= 2)
          return new Response(JSON.stringify({ error: "reports_busy" }), { status: 503 });
        return { ...noLiveLogs(query), logs: polls === 3 ? [arrived(1)] : [] };
      },
    });
    renderApp(`${LOGS}?live=true`);
    await expect.poll(liveBodies, { timeout: 3000 }).toEqual(["arrived 1"]);
    expect(page.getByText("New records could not load").elements()).toEqual([]);
    const counted = requestsTo(api, "/logs/live");
    await new Promise((resolve) => setTimeout(resolve, 1000));
    // At most one poll a quarter second: 4 in a second, with a little slack.
    expect(requestsTo(api, "/logs/live") - counted).toBeLessThanOrEqual(5);
    expect(requestsTo(api, "/logs/live") - counted).toBeGreaterThanOrEqual(2);
  });

  test("a failed poll stops Live with Retry; Retry starts it again", async () => {
    await page.viewport(1440, 900);
    LIVE_TIMING.pollMs = 50;
    let fail = true;
    installFakeApi({
      liveLogs: (query) =>
        fail ? new Response("{}", { status: 500 }) : { ...noLiveLogs(query), logs: [arrived(1)] },
    });
    renderApp(`${LOGS}?live=true`);
    await expect.element(page.getByText("New records could not load")).toBeVisible();
    expect(page.getByRole("button", { name: "Pause" }).elements()).toEqual([]);
    fail = false;
    await page.getByRole("button", { name: "Retry" }).click();
    await expect.poll(liveBodies).toEqual(["arrived 1"]);
    expect(page.getByText("New records could not load").elements()).toEqual([]);
  });

  test("a filter change starts the polls again, from no cursor, with the filter", async () => {
    await page.viewport(1440, 900);
    LIVE_TIMING.pollMs = 50;
    const api = installFakeApi({ liveLogs: liveFeed([[arrived(1)]]) });
    renderApp(`${LOGS}?live=true`);
    await expect.poll(liveBodies).toEqual(["arrived 1"]);
    await expect.poll(() => lastQuery(api, "/logs/live").after).toBeDefined();
    await page.getByRole("combobox", { name: "Minimum severity" }).click();
    await page.getByRole("option", { name: "Error and above" }).click();
    await expect
      .poll(() => api.requests.some((request) => request.includes("/logs/live?severity=error")))
      .toBe(true);
    // The first poll of the new view asks from no cursor; the old records are gone.
    const first = api.requests.find((request) => request.includes("/logs/live?severity=error"));
    expect(first).not.toContain("after=");
    await expect
      .element(page.getByText("No record has arrived since Live started. New ones appear here."))
      .toBeVisible();
  });

  test("turning Live on clears the selection", async () => {
    await page.viewport(1440, 900);
    LIVE_TIMING.pollMs = 50;
    const queue: LogSummary[][] = [[arrived(1)]];
    installFakeApi({ liveLogs: queuedFeed(queue) });
    const router = renderApp(LOGS);
    await page
      .getByRole("list", { name: "Log records, newest first" })
      .getByRole("button", { name: /Payment declined/ })
      .click();
    await expect.poll(() => router.state.location.search).toHaveProperty("log");
    await page.getByRole("switch", { name: "Live" }).click();
    await expect.poll(() => router.state.location.search).toEqual({ live: true });
    await expect.poll(liveBodies).toEqual(["arrived 1"]);
  });

  test("a selected record the live list does not hold says so, and holds no arrival", async () => {
    await page.viewport(1440, 900);
    LIVE_TIMING.pollMs = 50;
    const queue: LogSummary[][] = [[arrived(1)]];
    installFakeApi({ liveLogs: queuedFeed(queue) });
    renderApp(`${LOGS}?live=true&log=${"9".repeat(32)}`);
    await expect
      .element(logPane().getByText("This record is not in the live list").first())
      .toBeVisible();
    await expect.poll(liveBodies).toEqual(["arrived 1"]);
    queue.push([arrived(2)]);
    await expect.poll(liveBodies).toEqual(["arrived 2", "arrived 1"]);
    expect(page.getByRole("button", { name: /new record/ }).elements()).toEqual([]);
  });

  test("Live needs nothing of the period's list: it runs when that fails, and never asks for it", async () => {
    await page.viewport(1440, 900);
    LIVE_TIMING.pollMs = 50;
    const api = installFakeApi({
      logs: () => new Response("{}", { status: 500 }),
      liveLogs: liveFeed([[{ ...arrived(1), service: "billing" }]]),
    });
    renderApp(`${LOGS}?live=true`);
    await expect.poll(liveBodies).toEqual(["arrived 1"]);
    expect(requestsTo(api, "/logs")).toBe(0);
    // The service filter offers the services Live has seen.
    await page.getByRole("combobox", { name: "Service" }).click();
    await expect.element(page.getByRole("option", { name: "billing" })).toBeVisible();
  });

  test("quick tab switches keep the quarter-second floor between polls", async () => {
    await page.viewport(1440, 900);
    LIVE_TIMING.pollMs = 10_000;
    LIVE_TIMING.minGapMs = 250;
    const api = installFakeApi({ liveLogs: liveFeed([[arrived(1)]]) });
    renderApp(`${LOGS}?live=true`);
    await expect.poll(liveBodies).toEqual(["arrived 1"]);
    const before = requestsTo(api, "/logs/live");
    const started = Date.now();
    // Hidden and shown again ten times in about a fifth of a second: each show restarts the polls.
    for (let switches = 0; switches < 10; switches += 1) {
      Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
      await new Promise((resolve) => setTimeout(resolve, 10));
      Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    const elapsed = Date.now() - started;
    // At most one poll a quarter second, plus the one the first show may start at once.
    expect(requestsTo(api, "/logs/live") - before).toBeLessThanOrEqual(
      Math.ceil(elapsed / 250) + 1,
    );
    expect(requestsTo(api, "/logs/live") - before).toBeLessThan(5);
  });

  test("a gap under a minute shows its seconds", async () => {
    await page.viewport(1440, 900);
    LIVE_TIMING.pollMs = 50;
    let polls = 0;
    installFakeApi({
      liveLogs: (query) => {
        polls += 1;
        const answer = noLiveLogs(query);
        if (polls === 1) return { ...answer, logs: [arrived(1)], cursor: "1" };
        if (polls === 2) {
          return {
            ...answer,
            logs: [arrived(2)],
            cursor: "2",
            gap: { from: "2026-11-16T04:01:05.000Z", to: "2026-11-16T04:01:40.000Z" },
          };
        }
        return answer;
      },
    });
    renderApp(`${LOGS}?live=true`);
    await expect
      .poll(liveLines)
      .toContain(
        "Records between 12:01:05 and 12:01:40 aren't shown. Turn Live off to search the period.",
      );
  });

  test("turning Live off clears the selection", async () => {
    await page.viewport(1440, 900);
    LIVE_TIMING.pollMs = 50;
    installFakeApi({ liveLogs: liveFeed([[arrived(1)]]) });
    const router = renderApp(`${LOGS}?live=true`);
    await expect.poll(liveBodies).toEqual(["arrived 1"]);
    await page
      .getByRole("list", { name: "Log records, newest arrival first" })
      .getByRole("button", { name: /arrived 1/ })
      .click();
    await expect.poll(() => router.state.location.search).toMatchObject({ log: arrived(1).id });
    await page.getByRole("switch", { name: "Live" }).click();
    await expect.poll(() => router.state.location.search).toEqual({});
  });

  test("Show after more than 1,000 arrived keeps the selected record in the list", async () => {
    await page.viewport(1440, 900);
    LIVE_TIMING.pollMs = 50;
    const queue: LogSummary[][] = [[arrived(2), arrived(1)]];
    installFakeApi({ liveLogs: queuedFeed(queue) });
    const router = renderApp(`${LOGS}?live=true`);
    await expect.poll(liveBodies).toEqual(["arrived 2", "arrived 1"]);
    await page
      .getByRole("list", { name: "Log records, newest arrival first" })
      .getByRole("button", { name: /arrived 1/ })
      .click();
    queue.push(Array.from({ length: 1200 }, (_, i) => arrived(100 + i)).toReversed());
    await page.getByRole("button", { name: "1,000+ new records" }).click();
    await expect.poll(() => liveBodies().length).toBe(1000);
    // The newest first; the selected record kept at the end, though older than all of them.
    expect(liveBodies()[0]).toBe("arrived 1299");
    expect(liveBodies().at(-1)).toBe("arrived 1");
    expect(router.state.location.search).toMatchObject({ log: arrived(1).id });
    expect(logPane().element().textContent).not.toMatch(/not in the live list/);
  });

  test("polls nothing while the tab is hidden, and again once it shows", async () => {
    await page.viewport(1440, 900);
    LIVE_TIMING.pollMs = 50;
    const api = installFakeApi({ liveLogs: liveFeed([[arrived(1)]]) });
    renderApp(`${LOGS}?live=true`);
    await expect.poll(liveBodies).toEqual(["arrived 1"]);

    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const hidden = requestsTo(api, "/logs/live");
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(requestsTo(api, "/logs/live")).toBe(hidden);

    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await expect.poll(() => requestsTo(api, "/logs/live")).toBeGreaterThan(hidden);
  });

  test("stops by itself after its time, and Resume starts it again", async () => {
    await page.viewport(1440, 900);
    LIVE_TIMING.pollMs = 50;
    LIVE_TIMING.stopAfterMs = 600;
    const api = installFakeApi({ liveLogs: liveFeed([[arrived(1)]]) });
    renderApp(`${LOGS}?live=true`);
    await expect.poll(liveBodies).toEqual(["arrived 1"]);
    await expect.element(page.getByText(/^Live stopped after/)).toBeVisible();
    const stopped = requestsTo(api, "/logs/live");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(requestsTo(api, "/logs/live")).toBe(stopped);
    expect(page.getByRole("button", { name: "Pause" }).elements()).toEqual([]);

    await page.getByRole("button", { name: "Resume" }).click();
    await expect.poll(() => requestsTo(api, "/logs/live")).toBeGreaterThan(stopped);
    expect(liveBodies()).toEqual(["arrived 1"]);
  });

  test("keeps at most its limit of records, the oldest dropped", async () => {
    await page.viewport(1440, 900);
    LIVE_TIMING.pollMs = 50;
    LIVE_TIMING.maxRecords = 3;
    installFakeApi({
      liveLogs: liveFeed([
        [arrived(2), arrived(1)],
        [arrived(4), arrived(3)],
      ]),
    });
    renderApp(`${LOGS}?live=true`);
    await expect.poll(liveBodies).toEqual(["arrived 4", "arrived 3", "arrived 2"]);
  });

  test("at 390, records open in place and nothing spills", async () => {
    await page.viewport(390, 844);
    LIVE_TIMING.pollMs = 50;
    installFakeApi({ liveLogs: liveFeed([[arrived(1, "a ".repeat(200))]]) });
    renderApp(`${LOGS}?live=true`);
    await expect.poll(() => logRows("Log records, newest arrival first").length).toBe(1);
    expectNoSidewaysScroll(390);
  });
});
