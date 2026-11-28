import { keepPreviousData, queryOptions } from "@tanstack/react-query";

import {
  activeFilters,
  DEFAULT_ENVIRONMENT,
  type FilterName,
  type Filters,
  type PageRange,
  rangeParams,
} from "./analytics-api";
import { apiRequest, expectShape } from "./api";
import type { PropertyFilter } from "./product-api";

/*
 * An event's lists (docs/product-analytics.md, "Events"): apart from
 * product-api.ts, which the router needs on a first visit, so they load
 * with the event's page.
 */

/**
 * What an event's page lists and filters by, named as the Analytics page's:
 * its visit's source and campaign, and the event's own location, device,
 * and release.
 */
export const EVENT_DIMENSIONS = [
  "source",
  "utmCampaign",
  "country",
  "region",
  "city",
  "deviceType",
  "browser",
  "os",
  "release",
] as const satisfies readonly FilterName[];

export type EventDimension = (typeof EVENT_DIMENSIONS)[number];

export type EventDimensionFilters = Pick<Filters, EventDimension>;

/** The address's filters an event's page uses: those of EVENT_DIMENSIONS. */
export const eventDimensionsFrom = (filters: Filters): EventDimensionFilters =>
  Object.fromEntries(
    activeFilters(filters).filter(([name]) => EVENT_DIMENSIONS.some((item) => item === name)),
  );

/**
 * One value: null is unknown (an event without a visit, no location …), a
 * campaign of "" a visit without one.
 */
export interface EventDimensionValue {
  value: string | null;
  visitors: number;
  events: number;
}

/** GET /api/projects/:id/events/:name/breakdowns: 10 values of each, most visitors first. */
export type EventLists = Record<EventDimension, EventDimensionValue[]>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isValue = (value: unknown): value is EventDimensionValue =>
  isRecord(value) &&
  (value.value === null || typeof value.value === "string") &&
  typeof value.visitors === "number" &&
  typeof value.events === "number";

const isEventLists = (value: unknown): value is EventLists =>
  isRecord(value) &&
  EVENT_DIMENSIONS.every((name) => {
    const list = value[name];
    return Array.isArray(list) && list.every(isValue);
  });

/** The event's lists: their own request, with the page's filters. */
export const eventListsQuery = (
  projectId: string,
  name: string,
  range: PageRange,
  environment: string,
  filters: readonly PropertyFilter[],
  dimensions: EventDimensionFilters,
) =>
  queryOptions({
    queryKey: ["product-event", projectId, name, range, environment, filters, dimensions, "lists"],
    queryFn: async ({ signal }) => {
      const query = new URLSearchParams({
        ...rangeParams(range),
        ...(environment === DEFAULT_ENVIRONMENT ? {} : { environment }),
        ...Object.fromEntries(activeFilters(dimensions)),
      });
      for (const filter of filters) {
        query.append(`p.${filter.key}`, filter.value);
      }
      return expectShape(
        await apiRequest(
          `/api/projects/${encodeURIComponent(projectId)}/events/${encodeURIComponent(name)}/breakdowns?${query.toString()}`,
          { signal },
        ),
        isEventLists,
      );
    },
    placeholderData: keepPreviousData,
  });
