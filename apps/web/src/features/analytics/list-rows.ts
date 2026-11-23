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
  type ListRow,
  type PageRange,
  type PageRow,
} from "@/lib/analytics-api";

import { countryName } from "./format";
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

export interface PageSearch {
  range: PageRange;
  filters: Filters;
  environment: string;
}

/** Omit the default period and environment from the query. */
export const searchOf = ({ range, filters, environment }: PageSearch) => ({
  ...("period" in range
    ? range.period === DEFAULT_PERIOD
      ? {}
      : { period: range.period }
    : { from: range.from, to: range.to }),
  ...(environment === DEFAULT_ENVIRONMENT ? {} : { env: environment }),
  ...filters,
});

/** Custom event rows do not set a filter. */
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

export function rankedRows(report: ListReport, rows: ListRow[], link: FilterLinkFor): RankedRow[] {
  const filter = LIST_FILTERS[report];
  return rows.map((row) => {
    const value = row.name ?? "";
    return {
      key: row.name ?? "\u0000unknown",
      label: filter === undefined ? (row.name ?? "Unknown") : link(filter, value),
      title: filter === undefined ? (row.name ?? "Unknown") : valueText(filter, value),
      primary: row.visitors,
      secondary: row.second,
    };
  });
}

export const fromPages = (rows: readonly PageRow[]): ListRow[] =>
  rows.map((row) => ({ name: row.path, visitors: row.visitors, second: row.pageviews }));
export const fromBreakdown = (rows: readonly BreakdownRow[]): ListRow[] =>
  rows.map((row) => ({ name: row.value, visitors: row.visitors, second: row.visits }));
export const fromEvents = (rows: readonly CustomEventRow[]): ListRow[] =>
  rows.map((row) => ({ name: row.name, visitors: row.visitors, second: row.events }));
