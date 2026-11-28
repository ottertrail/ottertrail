import type * as React from "react";

import type { FilterName } from "@/lib/analytics-api";
import type { GoalChoice } from "@/lib/analytics-queries";

import { filterText, goalText, type PageSearch, valueText } from "./list-rows";
import { type PageLinkProps, useAnalyticsScope } from "./scope";

/** A link to the Web analytics page with another address, in the scope it runs in (scope.ts). */
export function PageLink(props: PageLinkProps) {
  return useAnalyticsScope().renderLink(props);
}

/** Adds a filter to the Web analytics page, keeping the others: in the dashboard, or on a shared link. */
export function FilterLink({
  search,
  name,
  value,
  onClick,
}: {
  search: PageSearch;
  name: FilterName;
  /** "" for an unknown value. */
  value: string;
  onClick?: () => void;
}) {
  return (
    <PageLink
      search={{ ...search, filters: { ...search.filters, [name]: value } }}
      aria-label={`Filter by ${filterText(name, value)}`}
      onClick={onClick}
      className={
        value === ""
          ? "text-ink-subtle hover:text-ink hover:underline"
          : "hover:text-link hover:underline"
      }
    >
      {valueText(name, value)}
    </PageLink>
  );
}

/** Makes a saved goal or a custom event the page's goal, keeping the other filters. */
export function GoalLink({
  search,
  goal,
  name,
  onClick,
  children = name,
}: {
  search: PageSearch;
  goal: GoalChoice;
  /** The goal's name, or the event's. */
  name: string;
  onClick?: () => void;
  children?: React.ReactNode;
}) {
  return (
    <PageLink
      search={{ ...search, goal }}
      aria-label={`Filter by ${goalText(name)}`}
      onClick={onClick}
      className="hover:text-link hover:underline"
    >
      {children}
    </PageLink>
  );
}
