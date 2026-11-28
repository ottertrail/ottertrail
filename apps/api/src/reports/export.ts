import type { Analytics, Comparison, ListReport } from "./analytics.ts";
import type { ChartCounts } from "./chart.ts";
import type { CsvCell } from "./csv.ts";
import type { BreakdownRow, CustomEventRow, EventValueRow, PageRow, Summary } from "./reports.ts";

/*
 * The tables of the Web analytics page's CSV exports (docs/web-analytics.md,
 * "CSV export"): every list in full, the summary, and the chart. Values are
 * as stored, so a country is its two-letter code; an empty cell is unknown
 * or none. Rates are fractions from 0 to 1, durations seconds.
 */

export interface CsvTable {
  header: string[];
  rows: CsvCell[][];
}

/** The first column's heading of each list, as the page names its rows. */
const NAME_HEADINGS: Record<ListReport, string> = {
  pages: "Page",
  customEvents: "Event",
  outboundLinks: "Link",
  fileDownloads: "File",
  notFoundPages: "Page",
  source: "Source",
  sourceKind: "Source from",
  referrer: "Referrer",
  channel: "Channel",
  hostname: "Hostname",
  entryPage: "Entry page",
  exitPage: "Exit page",
  utmSource: "UTM source",
  utmMedium: "UTM medium",
  utmCampaign: "UTM campaign",
  utmTerm: "UTM term",
  utmContent: "UTM content",
  country: "Country",
  region: "Region",
  city: "City",
  deviceType: "Device",
  browser: "Browser",
  browserVersion: "Browser version",
  os: "Operating system",
  release: "Release",
};

/** A list's part of a file name: `entry-page`, `custom-events`. */
export const listFileName = (report: ListReport) =>
  report.replaceAll(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`);

const rounded = (value: number | null, places: number): number | null =>
  value === null ? null : Number(value.toFixed(places));

const seconds = (ms: number | null) => (ms === null ? null : rounded(ms / 1000, 1));

const rate = (part: number, whole: number) => (whole === 0 ? 0 : rounded(part / whole, 4));

type ListRows = PageRow[] | BreakdownRow[] | CustomEventRow[] | EventValueRow[];

const isPageRows = (report: ListReport, _rows: ListRows): _rows is PageRow[] => report === "pages";
const isEventRows = (report: ListReport, _rows: ListRows): _rows is CustomEventRow[] =>
  report === "customEvents";
const isValueRows = (report: ListReport, _rows: ListRows): _rows is EventValueRow[] =>
  report === "outboundLinks" || report === "fileDownloads" || report === "notFoundPages";

/**
 * One list's table. With a goal, every list but custom events adds its
 * converted visitors and their share of the row's visitors, as the page's
 * Converted and Rate; the exit pages add their exit rate.
 */
export function listTable(report: ListReport, rows: ListRows, goal: boolean): CsvTable {
  const name = NAME_HEADINGS[report];
  const goalHeader = goal ? ["Converted", "Conversion rate"] : [];
  const goalCells = (row: { visitors: number; converted?: number }): CsvCell[] =>
    goal ? [row.converted ?? 0, rate(row.converted ?? 0, row.visitors)] : [];
  if (isEventRows(report, rows)) {
    return {
      header: [name, "Visitors", "Events"],
      rows: rows.map((row) => [row.name, row.visitors, row.events]),
    };
  }
  if (isPageRows(report, rows)) {
    return {
      header: [name, "Visitors", "Pageviews", "Time on page (seconds)", ...goalHeader],
      rows: rows.map((row) => [
        row.path,
        row.visitors,
        row.pageviews,
        seconds(row.avgEngagedMs),
        ...goalCells(row),
      ]),
    };
  }
  if (isValueRows(report, rows)) {
    return {
      header: [name, "Visitors", "Events", ...goalHeader],
      rows: rows.map((row) => [row.value, row.visitors, row.events, ...goalCells(row)]),
    };
  }
  const exits = report === "exitPage";
  return {
    header: [
      name,
      "Visitors",
      "Visits",
      "Bounce rate",
      ...(exits ? ["Exit rate"] : []),
      ...goalHeader,
    ],
    rows: rows.map((row) => [
      row.value,
      row.visitors,
      row.visits,
      rounded(row.bounceRate, 4),
      ...(exits ? [rounded(row.exitRate ?? null, 4)] : []),
      ...goalCells(row),
    ]),
  };
}

const COMPARED: Record<Exclude<Comparison, "off">, string> = {
  previous: "Previous period",
  year: "Same period last year",
};

const summaryCells = (summary: Summary): CsvCell[] => [
  summary.visitors,
  summary.pageviews,
  summary.visits,
  rounded(summary.viewsPerVisit, 2),
  rounded(summary.bounceRate, 4),
  seconds(summary.avgDurationMs),
  seconds(summary.avgEngagedMs),
];

/**
 * The summary's figures: one row for the period, and one for the period
 * compared with, when the comparison is on. With a goal, its name, its
 * converted visitors, their share of the visitors, and its events.
 */
export function summaryTable(analytics: Analytics): CsvTable {
  const { goal, previous, comparison } = analytics;
  const header = [
    "Period",
    "First day",
    "Last day",
    "Visitors",
    "Pageviews",
    "Visits",
    "Views per visit",
    "Bounce rate",
    "Visit duration (seconds)",
    "Time engaged (seconds)",
    ...(goal === null ? [] : ["Goal", "Converted", "Conversion rate", "Goal events"]),
  ];
  const rows: CsvCell[][] = [
    [
      "This period",
      analytics.firstDay,
      analytics.lastDay,
      ...summaryCells(analytics.summary),
      ...(goal === null
        ? []
        : [
            goal.name,
            goal.converted,
            rate(goal.converted, analytics.summary.visitors),
            goal.events,
          ]),
    ],
  ];
  if (previous !== null && comparison !== "off") {
    const before = goal?.previous ?? null;
    rows.push([
      COMPARED[comparison],
      previous.firstDay,
      previous.lastDay,
      ...summaryCells(previous.summary),
      ...(goal === null
        ? []
        : [
            goal.name,
            before?.converted ?? 0,
            rate(before?.converted ?? 0, previous.summary.visitors),
            before?.events ?? 0,
          ]),
    ]);
  }
  return { header, rows };
}

/**
 * The chart's points at its interval: when each starts and ends, whether
 * the range cuts it or it still runs, and its counts; with a comparison,
 * the compared counts at the same place.
 */
export function chartTable(analytics: Analytics): CsvTable {
  const goal = analytics.goal !== null;
  const compared = analytics.comparison !== "off" && analytics.previous !== null;
  const counts = goal
    ? ["Visitors", "Pageviews", "Visits", "Converted"]
    : ["Visitors", "Pageviews", "Visits"];
  const cells = (from: ChartCounts): CsvCell[] => [
    from.visitors,
    from.pageviews,
    from.visits,
    ...(goal ? [from.converted ?? 0] : []),
  ];
  return {
    header: [
      "Start",
      "End",
      "Partial",
      ...counts,
      ...(compared ? counts.map((name) => `Compared ${name.toLowerCase()}`) : []),
    ],
    rows: analytics.chart.map((point) => {
      return [
        point.start,
        point.end,
        point.partial,
        ...cells(point),
        ...(compared
          ? point.previous === null
            ? counts.map(() => null)
            : cells(point.previous)
          : []),
      ];
    }),
  };
}
