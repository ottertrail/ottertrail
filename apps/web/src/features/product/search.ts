import type { PageRange } from "@/lib/analytics-api";
import {
  BREAKDOWN_PROPERTY_PREFIX,
  DEFAULT_FUNNEL_COUNT,
  DEFAULT_FUNNEL_WINDOW,
  type FunnelBreakdownBy,
  type FunnelCount,
  type FunnelStep,
  type FunnelWindow,
  isFunnelStep,
  MAX_FILTERS,
  MAX_STEPS,
  type PropertyFilter,
} from "@/lib/product-api";

import { errorsSearchOf } from "../errors/search";

export interface ProductSearch {
  range: PageRange;
  environment: string;
}

export const productSearchOf = ({ range, environment }: ProductSearch) =>
  errorsSearchOf({ range, environment });

/** Use the API's "p.<key>" names for property filters. */
export const FILTER_PREFIX = "p.";

export type FilterSearch = Record<`p.${string}`, string>;

export const filterSearchOf = (filters: readonly PropertyFilter[]): FilterSearch =>
  Object.fromEntries(filters.map(({ key, value }) => [`${FILTER_PREFIX}${key}`, value]));

/** The router parses JSON primitives. Convert them back to JSON text for API comparisons. Keep at most MAX_FILTERS. */
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

export interface FunnelSearch extends ProductSearch {
  /** Last saved or opened funnel; its steps may have unsaved changes. */
  funnel?: string | undefined;
  steps: FunnelStep[];
  count: FunnelCount;
  window: FunnelWindow;
  /** The breakdown under the result; never saved with a funnel. */
  by?: FunnelBreakdownBy | undefined;
}

export const funnelSearchOf = ({
  range,
  environment,
  funnel,
  steps,
  count,
  window,
  by,
}: FunnelSearch) => ({
  ...productSearchOf({ range, environment }),
  ...(funnel === undefined ? {} : { funnel }),
  ...(steps.length === 0 ? {} : { steps }),
  ...(count === DEFAULT_FUNNEL_COUNT ? {} : { count }),
  ...(window === DEFAULT_FUNNEL_WINDOW ? {} : { window }),
  ...(by === undefined || steps.length === 0 ? {} : { by }),
});

/** A breakdown that fits the steps: a property only when step 1 is an event. */
export const breakdownFor = (
  by: FunnelBreakdownBy | undefined,
  steps: readonly FunnelStep[],
): FunnelBreakdownBy | undefined =>
  by?.startsWith(BREAKDOWN_PROPERTY_PREFIX) === true && steps[0]?.type !== "event" ? undefined : by;

/** The router parses compact JSON arrays; parse spaced JSON here. Invalid step lists become empty. */
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

export const savedFunnelIdFrom = (value: unknown): string | undefined =>
  typeof value === "string" && UUID.test(value) ? value.toLowerCase() : undefined;

/** Compare steps as serialized in the address so API object key order does not matter. */
export const isShownFunnel = (
  saved: { steps: unknown; count: FunnelCount; window: number },
  shown: { steps: readonly FunnelStep[]; count: FunnelCount; window: FunnelWindow },
) =>
  saved.count === shown.count &&
  saved.window === shown.window &&
  JSON.stringify(stepsFrom(saved.steps)) === JSON.stringify(shown.steps);
