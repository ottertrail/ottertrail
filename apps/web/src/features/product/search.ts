import type { PageRange } from "@/lib/analytics-api";
import {
  DEFAULT_FUNNEL_COUNT,
  DEFAULT_FUNNEL_WINDOW,
  type FunnelCount,
  type FunnelStep,
  type FunnelWindow,
  isFunnelStep,
  MAX_FILTERS,
  MAX_STEPS,
  type PropertyFilter,
} from "@/lib/product-api";

import { errorsSearchOf } from "../errors/search";

/** What every product analytics address holds. */
export interface ProductSearch {
  range: PageRange;
  environment: string;
}

/** The address query for the period and environment: the defaults are left out. */
export const productSearchOf = ({ range, environment }: ProductSearch) =>
  errorsSearchOf({ range, environment });

/** "p.plan": a property filter's name in the address, as in the API's query. */
export const FILTER_PREFIX = "p.";

export type FilterSearch = Record<`p.${string}`, string>;

/** The filters as address parameters, "p.<key>": value. */
export const filterSearchOf = (filters: readonly PropertyFilter[]): FilterSearch =>
  Object.fromEntries(filters.map(({ key, value }) => [`${FILTER_PREFIX}${key}`, value]));

/**
 * The property filters of an address, at most MAX_FILTERS. The router
 * reads "p.seats=3" as the number 3; the API compares values as text, as
 * JSON writes them, so a number, true, false, or null goes back to that.
 */
export function propertyFiltersFrom(search: Record<string, unknown>): PropertyFilter[] {
  return Object.entries(search)
    .flatMap(([name, value]): PropertyFilter[] => {
      if (!name.startsWith(FILTER_PREFIX) || name.length === FILTER_PREFIX.length) return [];
      const key = name.slice(FILTER_PREFIX.length);
      if (typeof value === "string") return [{ key, value }];
      if (typeof value === "number" || typeof value === "boolean" || value === null) {
        return [{ key, value: JSON.stringify(value) }];
      }
      return [];
    })
    .slice(0, MAX_FILTERS);
}

/** What the funnel's address holds besides the period and environment. */
export interface FunnelSearch extends ProductSearch {
  /** The saved funnel last opened or saved, by ID; the steps below may have changed since. */
  funnel?: string | undefined;
  /** Complete steps as the API takes them; none until the first funnel is shown. */
  steps: FunnelStep[];
  count: FunnelCount;
  window: FunnelWindow;
}

/**
 * The funnel's address query: no saved funnel, no steps, visitors, and the
 * one-day window are left out.
 */
export const funnelSearchOf = ({
  range,
  environment,
  funnel,
  steps,
  count,
  window,
}: FunnelSearch) => ({
  ...productSearchOf({ range, environment }),
  ...(funnel === undefined ? {} : { funnel }),
  ...(steps.length === 0 ? {} : { steps }),
  ...(count === DEFAULT_FUNNEL_COUNT ? {} : { count }),
  ...(window === DEFAULT_FUNNEL_WINDOW ? {} : { window }),
});

/**
 * The steps from the address: the JSON array the API takes. The router
 * reads it as an array when it is written as JSON.stringify writes it; a
 * hand-written one, with spaces, stays text and is read here. Anything
 * that is not a list of steps is no steps.
 */
export function stepsFrom(value: unknown): FunnelStep[] {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed) || parsed.length > MAX_STEPS || !parsed.every(isFunnelStep)) {
    return [];
  }
  // Only the fields the API reads, so the address round-trips exactly.
  return parsed.map((step) =>
    step.type === "page"
      ? { type: "page", path: step.path }
      : step.filter === undefined
        ? { type: "event", name: step.name }
        : {
            type: "event",
            name: step.name,
            filter: { key: step.filter.key, value: step.filter.value },
          },
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A saved funnel's ID from the address, in lower case; anything but a UUID is none. */
export const savedFunnelIdFrom = (value: unknown): string | undefined =>
  typeof value === "string" && UUID.test(value) ? value.toLowerCase() : undefined;

/**
 * Whether a saved funnel is the funnel shown. Its steps are compared as the
 * address holds them, so the order of the API's keys does not matter.
 */
export const isShownFunnel = (
  saved: { steps: unknown; count: FunnelCount; window: number },
  shown: { steps: readonly FunnelStep[]; count: FunnelCount; window: FunnelWindow },
) =>
  saved.count === shown.count &&
  saved.window === shown.window &&
  JSON.stringify(stepsFrom(saved.steps)) === JSON.stringify(shown.steps);
