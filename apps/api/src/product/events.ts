import { QueryParams, queryRows, type Reader } from "../clickhouse/query.ts";
import { DEFAULT_ENVIRONMENT } from "../collection/environment.ts";
import {
  VISIT_SOURCE_COLUMNS,
  VISIT_SOURCE_NAMES,
  type VisitSourceName,
  withVisitSourceSql,
} from "../visits/visit-source.ts";
import { analyticsEvent, ENGAGEMENT, PAGEVIEW, VITALS } from "../visits/visits.ts";

/** Site-defined events and properties (docs/product-analytics.md, "Definitions"). */

/** A range of whole days in the instance's timezone, in one environment. */
export interface ProductRange {
  projectId: string;
  environment: string;
  timeZone: string;
  /** "YYYY-MM-DD", both included. */
  firstDay: string;
  lastDay: string;
  from: Date;
  to: Date;
}

export interface PropertyFilter {
  key: string;
  value: string;
}

export const MAX_FILTERS = 5;
export const PROPERTY_KEYS = 30;
export const PROPERTY_VALUES = 10;
export const EVENT_NAMES = 100;

/**
 * Strings remain literal; other values use JSON text. key must be a SQL
 * expression or placeholder, never input text.
 */
export const propertyText = (key: string) =>
  `if(JSONType(properties, ${key}) = 'String', JSONExtractString(properties, ${key}), JSONExtractRaw(properties, ${key}))`;

/** Exclude tracker pageviews, engagement, errors, and Web Vitals. */
export const PRODUCT_EVENT = `name NOT IN ('${PAGEVIEW}', '${ENGAGEMENT}') AND ${analyticsEvent()}`;

/** `from` can start earlier than the range: at the period before's start, to compare. */
function scope(params: QueryParams, range: ProductRange, from: Date = range.from): string {
  return `project_id = ${params.add(range.projectId, "UUID")}
    AND environment = ${params.add(range.environment, "String")}
    AND occurred_at >= ${params.time(from)}
    AND occurred_at < ${params.time(range.to)}
    AND ${PRODUCT_EVENT}`;
}

/**
 * The period before a range (reports.ts, previousDays). While the range
 * runs, it ends at the same time of day, before the range starts.
 */
export interface PreviousPeriod {
  from: Date;
  to: Date;
}

/**
 * Require the property to exist: missing properties also read as empty
 * text and would otherwise match an empty filter.
 */
export function propertyEquals(params: QueryParams, filter: PropertyFilter): string {
  const name = params.add(filter.key, "String");
  return `(JSONHas(properties, ${name}) AND ${propertyText(name)} = ${params.add(filter.value, "String")})`;
}

/** Returns an empty SQL fragment without filters. */
export function filtersSql(params: QueryParams, filters: readonly PropertyFilter[]): string {
  return filters.map((filter) => `AND ${propertyEquals(params, filter)}`).join(" ");
}

const count = (raw: unknown) => Number(raw);
const text = (raw: unknown) => (typeof raw === "string" ? raw : "");

export interface EventCounts {
  events: number;
  /** Daily visitor IDs; a server's events have none. */
  visitors: number;
  users: number;
}

export interface EventRow extends EventCounts {
  name: string;
  /** The same counts in the period before. */
  previous: EventCounts;
}

/** `when` is SQL with placeholders, never input text. */
const countsWhen = (when: string, prefix: string) =>
  `countIf(${when}) AS ${prefix}events, uniqExactIf(visitor_id, ${when}) AS ${prefix}visitors,
   uniqExactIf(user_id, ${when} AND user_id IS NOT NULL) AS ${prefix}users`;

/**
 * The range's counts and the period before's (`previous_events` …), in one
 * pass over both: the query reads from the period before's start.
 */
function countsSql(params: QueryParams, range: ProductRange, previous: PreviousPeriod): string {
  return `${countsWhen(`occurred_at >= ${params.time(range.from)}`, "")},
    ${countsWhen(`occurred_at < ${params.time(previous.to)}`, "previous_")}`;
}

function countsOf(row: Record<string, unknown> | undefined, prefix = ""): EventCounts {
  return {
    events: count(row?.[`${prefix}events`] ?? 0),
    visitors: count(row?.[`${prefix}visitors`] ?? 0),
    users: count(row?.[`${prefix}users`] ?? 0),
  };
}

/**
 * The product events of a range, most frequent first, each with its counts
 * in the period before. `search` keeps the names that contain it, in any case.
 */
export async function listEvents(
  reader: Reader,
  range: ProductRange,
  previous: PreviousPeriod,
  search = "",
): Promise<EventRow[]> {
  const params = new QueryParams();
  const named =
    search === ""
      ? ""
      : `AND positionCaseInsensitiveUTF8(name, ${params.add(search, "String")}) > 0`;
  const rows = await queryRows<Record<string, unknown>>(
    reader,
    `SELECT name, ${countsSql(params, range, previous)}
     FROM events FINAL
     WHERE ${scope(params, range, previous.from)} ${named}
     GROUP BY name
     HAVING events > 0
     ORDER BY events DESC, name
     LIMIT ${EVENT_NAMES}`,
    params,
  );
  return rows.map((row) => ({
    name: text(row.name),
    ...countsOf(row),
    previous: countsOf(row, "previous_"),
  }));
}

/** Fixed SQL scopes for environment choices. */
export const COUNTED = {
  events: PRODUCT_EVENT,
  funnel: `name != '${ENGAGEMENT}' AND ${analyticsEvent()}`,
  retention: `user_id IS NOT NULL AND name NOT IN ('${ENGAGEMENT}', '${VITALS}')`,
} as const;

/**
 * Include the selected environment and production even without data,
 * so the page can switch back.
 */
export async function productEnvironments(
  reader: Reader,
  range: ProductRange,
  counted: (typeof COUNTED)[keyof typeof COUNTED] = COUNTED.events,
): Promise<string[]> {
  const params = new QueryParams();
  const rows = await queryRows<{ environment: string }>(
    reader,
    `SELECT environment FROM events
     WHERE project_id = ${params.add(range.projectId, "UUID")}
       AND occurred_at >= ${params.time(range.from)}
       AND occurred_at < ${params.time(range.to)}
       AND ${counted}
     GROUP BY environment
     ORDER BY count() DESC, environment`,
    params,
  );
  const names = rows.map((row) => row.environment);
  for (const name of [range.environment, DEFAULT_ENVIRONMENT]) {
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

export interface PropertyBreakdown {
  key: string;
  events: number;
  /** Its most frequent values, as text (propertyText). */
  values: { value: string; events: number }[];
}

export interface EventDetail extends EventRow {
  /** Every day of the range. */
  days: { day: string; events: number }[];
  properties: PropertyBreakdown[];
}

function eachDay(firstDay: string, lastDay: string): string[] {
  const days: string[] = [];
  const end = Date.parse(`${lastDay}T00:00:00Z`);
  for (let time = Date.parse(`${firstDay}T00:00:00Z`); time <= end; time += 86_400_000) {
    days.push(new Date(time).toISOString().slice(0, 10));
  }
  return days;
}

/** Return zero counts when no events match. */
export async function eventDetail(
  reader: Reader,
  range: ProductRange,
  previous: PreviousPeriod,
  name: string,
  filters: readonly PropertyFilter[],
): Promise<EventDetail> {
  const where = (params: QueryParams, from = range.from) =>
    `${scope(params, range, from)} AND name = ${params.add(name, "String")} ${filtersSql(params, filters)}`;
  const totalParams = new QueryParams();
  const dayParams = new QueryParams();
  const valueParams = new QueryParams();
  const timeZone = dayParams.add(range.timeZone, "String");
  // Each property as (key, raw JSON value), one row per property of each event.
  const pairs = (params: QueryParams) =>
    `SELECT tupleElement(pair, 1) AS key, tupleElement(pair, 2) AS raw
     FROM events FINAL
     ARRAY JOIN JSONExtractKeysAndValuesRaw(properties) AS pair
     WHERE ${where(params)}`;

  const [[total], days, values] = await Promise.all([
    queryRows<Record<string, unknown>>(
      reader,
      `SELECT ${countsSql(totalParams, range, previous)}
       FROM events FINAL
       WHERE ${where(totalParams, previous.from)}`,
      totalParams,
    ),
    queryRows<{ day: string; events: string }>(
      reader,
      `SELECT toString(toDate(occurred_at, ${timeZone})) AS day, count() AS events
       FROM events FINAL
       WHERE ${where(dayParams)}
       GROUP BY day`,
      dayParams,
    ),
    // Count property names and values in one pass.
    queryRows<{ key: string; value: string; events: string; key_events: string }>(
      reader,
      `SELECT key, value, events, key_events
       FROM (
         SELECT key, if(JSONType(raw) = 'String', JSONExtractString(raw), raw) AS value,
                count() AS events, sum(count()) OVER (PARTITION BY key) AS key_events
         FROM (${pairs(valueParams)})
         GROUP BY key, value
       )
       ORDER BY key_events DESC, key, events DESC, value
       LIMIT ${PROPERTY_VALUES} BY key
       LIMIT ${PROPERTY_KEYS * PROPERTY_VALUES}`,
      valueParams,
    ),
  ]);
  const keys: { key: string; events: number }[] = [];
  for (const row of values) {
    if (keys.length >= PROPERTY_KEYS) break;
    if (keys.at(-1)?.key !== row.key) keys.push({ key: row.key, events: count(row.key_events) });
  }

  const perDay = new Map(days.map((day) => [day.day, count(day.events)]));
  return {
    name,
    ...countsOf(total),
    previous: countsOf(total, "previous_"),
    days: eachDay(range.firstDay, range.lastDay).map((day) => ({
      day,
      events: perDay.get(day) ?? 0,
    })),
    properties: keys.map((key) => ({
      key: key.key,
      events: key.events,
      values: values
        .filter((value) => value.key === key.key)
        .map((value) => ({ value: value.value, events: count(value.events) })),
    })),
  };
}

/** One visit dimension's most frequent values; null is an event without a visit. */
export interface VisitSourceValue {
  value: string | null;
  events: number;
}

export type EventSources = Record<VisitSourceName, VisitSourceValue[]>;

/**
 * The events by their visit's source and campaign (visits/visit-source.ts),
 * PROPERTY_VALUES values each, most events first. Only the visits of the
 * visitor IDs that sent a matching event are worked out. `ownHostnames`
 * are the project's, whose referrers are not a source.
 */
export async function eventSources(
  reader: Reader,
  range: ProductRange,
  name: string,
  filters: readonly PropertyFilter[],
  ownHostnames: readonly string[],
): Promise<EventSources> {
  const params = new QueryParams();
  const where = () =>
    `${scope(params, range)} AND name = ${params.add(name, "String")} ${filtersSql(params, filters)}`;
  const credited = withVisitSourceSql(
    { ...range, ownHostnames },
    `SELECT visitor_id, occurred_at FROM events FINAL WHERE ${where()}`,
    `SELECT visitor_id FROM events WHERE ${where()} AND visitor_id IS NOT NULL`,
    params,
  );
  // The dimension names are constants, never input.
  const pairs = VISIT_SOURCE_NAMES.map(
    (dimension) => `tuple('${dimension}', ${VISIT_SOURCE_COLUMNS[dimension]})`,
  );
  const rows = await queryRows<{ dimension: string; value: string | null; events: string }>(
    reader,
    `SELECT pair.1 AS dimension, pair.2 AS value, count() AS events
     FROM (${credited})
     ARRAY JOIN [${pairs.join(", ")}] AS pair
     GROUP BY dimension, value
     ORDER BY dimension, events DESC, value ASC NULLS LAST
     LIMIT ${PROPERTY_VALUES} BY dimension`,
    params,
  );
  const valuesOf = (dimension: VisitSourceName) =>
    rows
      .filter((row) => row.dimension === dimension)
      .map((row) => ({ value: row.value, events: count(row.events) }));
  return { source: valuesOf("source"), utmCampaign: valuesOf("utmCampaign") };
}
