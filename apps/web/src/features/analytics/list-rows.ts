import type * as React from "react";

import {
  type BreakdownRow,
  type CustomEventRow,
  DEFAULT_ENVIRONMENT,
  type EventValueRow,
  DEFAULT_PERIOD,
  type Filter,
  FILTER_NAMES,
  FILTERS,
  type FilterName,
  filterParams,
  type Filters,
  isTextOperator,
  type ListReport,
  OPERATOR_LABELS,
  type PageRange,
  type PageRow,
} from "@/lib/analytics-api";
import { canBeGoal, type GoalChoice, goalParams, type ListRow } from "@/lib/analytics-queries";

import { countryName, formatConversion } from "./format";
import type { RankedRow } from "./ranked-list";

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Campaign tags a visit can lack: having none is a value of its own, not unknown. */
const NO_VALUE: Partial<Record<FilterName, string>> = {
  referrer: "No referrer",
  utmSource: "No source",
  utmMedium: "No medium",
  utmCampaign: "No campaign",
  utmTerm: "No term",
  utmContent: "No content",
};

/** How a visit got its source, as the API names it (visits/visit-source.ts). */
const SOURCE_KINDS: Record<string, string> = {
  tag: "Tagged (utm_source or ref)",
  referrer: "Referrer",
  none: "No tag, no referrer",
};

export function valueText(name: FilterName, value: string): string {
  if (value === "") {
    return NO_VALUE[name] ?? "Unknown";
  }
  if (name === "country") {
    return countryName(value);
  }
  if (name === "sourceKind") {
    return SOURCE_KINDS[value] ?? value;
  }
  // A link without its scheme: github.com/acme/widgets.
  if (name === "outbound" || name === "download" || name === "referrer") {
    return value.replace(/^https?:\/\//u, "");
  }
  return name === "deviceType" ? capitalize(value) : value;
}

export const filterText = (name: FilterName, value: string) =>
  `${FILTERS[name].label}: ${valueText(name, value)}`;

/** A value as a filter shows it: as its row does, and typed text as typed. */
export const filterValueText = ({ name, operator }: Filter, value: string) =>
  isTextOperator(operator) ? value : valueText(name, value);

/** A filter's chip: "Country is not Germany, France". */
export const chipText = (filter: Filter) =>
  `${FILTERS[filter.name].label} ${OPERATOR_LABELS[filter.operator]} ${filter.values
    .map((value) => filterValueText(filter, value))
    .join(", ")}`;

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
  ...filterParams(filters),
  ...goalParams(goal),
});

/** The filter a list's rows set (FILTERS). Custom event rows set the goal instead (eventLink). */
export const LIST_FILTERS: Partial<Record<ListReport, FilterName>> = Object.fromEntries(
  FILTER_NAMES.map((name) => [FILTERS[name].list, name]),
);

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
      ...(row.exitRate === undefined ? {} : { exitRate: row.exitRate }),
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
    exitRate: row.exitRate,
  }));
export const fromEventValues = (rows: readonly EventValueRow[]): ListRow[] =>
  rows.map((row) => ({
    name: row.value,
    visitors: row.visitors,
    second: row.events,
    converted: row.converted,
  }));
export const fromEvents = (rows: readonly CustomEventRow[]): ListRow[] =>
  rows.map((row) => ({ name: row.name, visitors: row.visitors, second: row.events }));
