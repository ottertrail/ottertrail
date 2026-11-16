import type * as React from "react";

import {
  type BreakdownRow,
  type CustomEventRow,
  DEFAULT_PERIOD,
  FILTER_LABELS,
  type FilterName,
  type Filters,
  type ListReport,
  type ListRow,
  type PageRow,
  type Period,
} from "@/lib/analytics-api";

import { countryName } from "./format";
import type { RankedRow } from "./ranked-list";

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** How a list row or filter names a value: a country's name, "Desktop", "Unknown" … */
export function valueText(name: FilterName, value: string): string {
  if (value === "") {
    return name === "utmCampaign" ? "No campaign" : "Unknown";
  }
  if (name === "country") {
    return countryName(value);
  }
  return name === "deviceType" ? capitalize(value) : value;
}

/** "Country: Germany" */
export const filterText = (name: FilterName, value: string) =>
  `${FILTER_LABELS[name]}: ${valueText(name, value)}`;

/** The page's address query: the period (left out when it is the default) and the filters. */
export interface PageSearch {
  period?: Period;
  filters: Filters;
}

export const searchOf = ({ period, filters }: PageSearch) => ({
  ...(period === undefined || period === DEFAULT_PERIOD ? {} : { period }),
  ...filters,
});

/** The filter each list's rows set; custom events set none yet. */
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
};

/** Makes a row's name into a link that filters by it. */
export type FilterLinkFor = (name: FilterName, value: string) => React.ReactNode;

/** A list's rows for the ranked list: visitors set the bar, the second number follows. */
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

/** The analytics response's rows, in the shape every list uses. */
export const fromPages = (rows: readonly PageRow[]): ListRow[] =>
  rows.map((row) => ({ name: row.path, visitors: row.visitors, second: row.pageviews }));
export const fromBreakdown = (rows: readonly BreakdownRow[]): ListRow[] =>
  rows.map((row) => ({ name: row.value, visitors: row.visitors, second: row.visits }));
export const fromEvents = (rows: readonly CustomEventRow[]): ListRow[] =>
  rows.map((row) => ({ name: row.name, visitors: row.visitors, second: row.events }));
