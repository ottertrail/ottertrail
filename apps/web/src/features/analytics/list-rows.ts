import type * as React from "react";

import {
  type BreakdownRow,
  type CustomEventRow,
  DEFAULT_ENVIRONMENT,
  DEFAULT_PERIOD,
  FILTER_LABELS,
  type FilterName,
  type Filters,
  type ListReport,
  type PageRange,
  type PageRow,
} from "@/lib/analytics-api";
import { canBeGoal, type GoalChoice, goalParams, type ListRow } from "@/lib/analytics-queries";

import { countryName, formatConversion } from "./format";
import type { RankedRow } from "./ranked-list";

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function valueText(name: FilterName, value: string): string {
  if (value === "") {
    return name === "utmCampaign" ? "No campaign" : "Unknown";
  }
  if (name === "country") {
    return countryName(value);
  }
  return name === "deviceType" ? capitalize(value) : value;
}

export const filterText = (name: FilterName, value: string) =>
  `${FILTER_LABELS[name]}: ${valueText(name, value)}`;

/** The chip's and the links' words for a goal: "Goal: Team signup". */
export const goalText = (name: string) => `Goal: ${name}`;

/** A row's conversion rate: its converted visitors of its visitors. */
export const rowRate = (row: RankedRow) =>
  formatConversion(row.primary === 0 ? 0 : (row.converted ?? 0) / row.primary);

export interface PageSearch {
  range: PageRange;
  filters: Filters;
  environment: string;
  /** The goal the page is filtered by (docs/web-analytics.md, "The goal filter"). */
  goal?: GoalChoice | undefined;
}

/** Omit the default period and environment from the query. */
export const searchOf = ({ range, filters, environment, goal }: PageSearch) => ({
  ...("period" in range
    ? range.period === DEFAULT_PERIOD
      ? {}
      : { period: range.period }
    : { from: range.from, to: range.to }),
  ...(environment === DEFAULT_ENVIRONMENT ? {} : { env: environment }),
  ...filters,
  ...goalParams(goal),
});

/** Custom event rows set the goal instead of a filter (eventLink). */
export const LIST_FILTERS: Record<ListReport, FilterName | undefined> = {
  pages: "page",
  customEvents: undefined,
  source: "source",
  utmCampaign: "utmCampaign",
  entryPage: "entryPage",
  exitPage: "exitPage",
  country: "country",
  region: "region",
  city: "city",
  deviceType: "deviceType",
  browser: "browser",
  os: "os",
  release: "release",
};

export type FilterLinkFor = (name: FilterName, value: string) => React.ReactNode;

/** A custom event's row: a link that makes it the goal. */
export type EventLinkFor = (name: string) => React.ReactNode;

export function rankedRows(
  report: ListReport,
  rows: ListRow[],
  link: FilterLinkFor,
  eventLink?: EventLinkFor,
): RankedRow[] {
  const filter = LIST_FILTERS[report];
  return rows.map((row) => {
    const value = row.name ?? "";
    const text = filter === undefined ? (row.name ?? "Unknown") : valueText(filter, value);
    const label =
      filter !== undefined
        ? link(filter, value)
        : eventLink !== undefined && row.name !== null && canBeGoal(row.name)
          ? eventLink(row.name)
          : text;
    return {
      key: row.name ?? "\u0000unknown",
      label,
      title: text,
      primary: row.visitors,
      secondary: row.second,
      converted: row.converted,
    };
  });
}

export const fromPages = (rows: readonly PageRow[]): ListRow[] =>
  rows.map((row) => ({
    name: row.path,
    visitors: row.visitors,
    second: row.pageviews,
    converted: row.converted,
  }));
export const fromBreakdown = (rows: readonly BreakdownRow[]): ListRow[] =>
  rows.map((row) => ({
    name: row.value,
    visitors: row.visitors,
    second: row.visits,
    converted: row.converted,
  }));
export const fromEvents = (rows: readonly CustomEventRow[]): ListRow[] =>
  rows.map((row) => ({ name: row.name, visitors: row.visitors, second: row.events }));
