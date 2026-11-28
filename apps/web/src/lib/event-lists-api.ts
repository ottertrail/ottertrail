import { keepPreviousData, queryOptions } from "@tanstack/react-query";

import {
  DEFAULT_ENVIRONMENT,
  type FilterName,
  filterValue,
  MAX_FILTER_LENGTH,
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

/** One value each: an event's lists filter by is only (docs/product-analytics.md, "Events"). */
export type EventDimensionFilters = { [Name in EventDimension]?: string | undefined };

/**
 * The address's filters an event's page uses: one value of each of
 * EVENT_DIMENSIONS, named as the Analytics page's. Every name is there,
 * undefined when absent or unusable, since the router merges this over the
 * raw query.
 */
export function eventDimensionsFrom(
  search: Record<string, unknown>,
): Record<EventDimension, string | undefined> {
  const usable = (name: EventDimension) => {
    const value = filterValue(search[name]);
    // The API refuses NUL (PostgreSQL text cannot hold it) and overlong values.
    return value !== undefined && value.length <= MAX_FILTER_LENGTH && !value.includes("\u0000")
      ? value
      : undefined;
  };
  return {
    source: usable("source"),
    utmCampaign: usable("utmCampaign"),
    country: usable("country"),
    region: usable("region"),
    city: usable("city"),
    deviceType: usable("deviceType"),
    browser: usable("browser"),
    os: usable("os"),
    release: usable("release"),
  };
}

/** The dimensions an event's page filters by, with their values. */
export const activeDimensions = (filters: EventDimensionFilters): [EventDimension, string][] =>
  EVENT_DIMENSIONS.flatMap((name) => {
    const value = filters[name];
    return value === undefined ? [] : [[name, value] as [EventDimension, string]];
  });

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
        ...Object.fromEntries(activeDimensions(dimensions)),
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
