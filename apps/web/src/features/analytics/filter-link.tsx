import { Link } from "@tanstack/react-router";
import type * as React from "react";

import type { FilterName } from "@/lib/analytics-api";
import type { GoalChoice } from "@/lib/analytics-queries";

import { filterText, goalText, type PageSearch, searchOf, valueText } from "./list-rows";

export function FilterLink({
  projectId,
  search,
  name,
  value,
  onClick,
}: {
  projectId: string;
  search: PageSearch;
  name: FilterName;
  /** "" for an unknown value. */
  value: string;
  onClick?: () => void;
}) {
  return (
    <Link
      to="/projects/$projectId/web-analytics"
      params={{ projectId }}
      search={searchOf({ ...search, filters: { ...search.filters, [name]: value } })}
      aria-label={`Filter by ${filterText(name, value)}`}
      onClick={onClick}
      className={
        value === ""
          ? "text-ink-subtle hover:text-ink hover:underline"
          : "hover:text-link hover:underline"
      }
    >
      {valueText(name, value)}
    </Link>
  );
}

/** Makes a saved goal or a custom event the page's goal, keeping the other filters. */
export function GoalLink({
  projectId,
  search,
  goal,
  name,
  onClick,
  children = name,
}: {
  projectId: string;
  search: PageSearch;
  goal: GoalChoice;
  /** The goal's name, or the event's. */
  name: string;
  onClick?: () => void;
  children?: React.ReactNode;
}) {
  return (
    <Link
      to="/projects/$projectId/web-analytics"
      params={{ projectId }}
      search={searchOf({ ...search, goal })}
      aria-label={`Filter by ${goalText(name)}`}
      onClick={onClick}
      className="hover:text-link hover:underline"
    >
      {children}
    </Link>
  );
}
