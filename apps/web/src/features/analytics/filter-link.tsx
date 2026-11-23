import { Link } from "@tanstack/react-router";

import type { FilterName } from "@/lib/analytics-api";

import { filterText, type PageSearch, searchOf, valueText } from "./list-rows";

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
