import { QueryParams, queryRows, type Reader } from "../clickhouse/query.ts";
import { DEFAULT_ENVIRONMENT } from "../collection/environment.ts";
import { analyticsEvent, ENGAGEMENT, PAGEVIEW, VITALS } from "../visits/visits.ts";

/**
 * Product events: the events a site sends itself, by name, with their
 * properties (docs/product-analytics.md, "Definitions").
 */

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

/** One property equal to one value, compared as text (propertyText). */
export interface PropertyFilter {
  key: string;
  value: string;
}

/** Filters per request, and the keys and values a breakdown lists. */
export const MAX_FILTERS = 5;
export const PROPERTY_KEYS = 30;
export const PROPERTY_VALUES = 10;
export const EVENT_NAMES = 100;

/**
 * SQL for a property's value as text: a string as it is, anything else
 * (a number, true, false, null) as JSON writes it. `key` is a placeholder
 * or SQL expression, never input text.
 */
export const propertyText = (key: string) =>
  `if(JSONType(properties, ${key}) = 'String', JSONExtractString(properties, ${key}), JSONExtractRaw(properties, ${key}))`;

/** SQL true for a product event: not the tracker's own pageviews, time on page, errors, or Web Vitals. */
export const PRODUCT_EVENT = `name NOT IN ('${PAGEVIEW}', '${ENGAGEMENT}') AND ${analyticsEvent()}`;

function scope(params: QueryParams, range: ProductRange): string {
  return `project_id = ${params.add(range.projectId, "UUID")}
    AND environment = ${params.add(range.environment, "String")}
    AND occurred_at >= ${params.time(range.from)}
    AND occurred_at < ${params.time(range.to)}
    AND ${PRODUCT_EVENT}`;
}

/**
 * SQL true when the event has the property and it equals the value, as
 * text. Without the first half, an empty value would also match every
 * event without the property, whose text is "" too.
 */
export function propertyEquals(params: QueryParams, filter: PropertyFilter): string {
  const name = params.add(filter.key, "String");
  return `(JSONHas(properties, ${name}) AND ${propertyText(name)} = ${params.add(filter.value, "String")})`;
}

/** SQL for the filters, each property equal to its value; "" without filters. */
export function filtersSql(params: QueryParams, filters: readonly PropertyFilter[]): string {
  return filters.map((filter) => `AND ${propertyEquals(params, filter)}`).join(" ");
}

const count = (raw: unknown) => Number(raw);
const text = (raw: unknown) => (typeof raw === "string" ? raw : "");

export interface EventRow {
  name: string;
  events: number;
  /** Daily visitor IDs; a server's events have none. */
  visitors: number;
  /** Signed-in users. */
  users: number;
}

const COUNTS = `count() AS events, uniqExact(visitor_id) AS visitors,
  uniqExactIf(user_id, user_id IS NOT NULL) AS users`;

/** The product events of a range, most frequent first. */
export async function listEvents(reader: Reader, range: ProductRange): Promise<EventRow[]> {
  const params = new QueryParams();
  const rows = await queryRows<Record<string, unknown>>(
    reader,
    `SELECT name, ${COUNTS}
     FROM events FINAL
     WHERE ${scope(params, range)}
     GROUP BY name
     ORDER BY events DESC, name
     LIMIT ${EVENT_NAMES}`,
    params,
  );
  return rows.map((row) => ({
    name: text(row.name),
    events: count(row.events),
    visitors: count(row.visitors),
    users: count(row.users),
  }));
}

/** What each report counts, for the environments it lists: SQL conditions, constants. */
export const COUNTED = {
  /** The Events tab: product events. */
  events: PRODUCT_EVENT,
  /** A funnel: pageviews and product events. */
  funnel: `name != '${ENGAGEMENT}' AND ${analyticsEvent()}`,
  /** Retention: signed-in users' own events. */
  retention: `user_id IS NOT NULL AND name NOT IN ('${ENGAGEMENT}', '${VITALS}')`,
} as const;

/**
 * The environments with what a report counts in the range, most first,
 * then the one shown and production even without: the page can switch back.
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
  /** Events with this property. */
  events: number;
  /** Its most frequent values, as text (propertyText). */
  values: { value: string; events: number }[];
}

export interface EventDetail extends EventRow {
  /** Every day of the range. */
  days: { day: string; events: number }[];
  properties: PropertyBreakdown[];
}

/** Every day from firstDay to lastDay, both included. */
function eachDay(firstDay: string, lastDay: string): string[] {
  const days: string[] = [];
  const end = Date.parse(`${lastDay}T00:00:00Z`);
  for (let time = Date.parse(`${firstDay}T00:00:00Z`); time <= end; time += 86_400_000) {
    days.push(new Date(time).toISOString().slice(0, 10));
  }
  return days;
}

/**
 * One event in the range, with the filters: its counts, each day, and its
 * properties with their most frequent values. Zeros when none match.
 */
export async function eventDetail(
  reader: Reader,
  range: ProductRange,
  name: string,
  filters: readonly PropertyFilter[],
): Promise<EventDetail> {
  const where = (params: QueryParams) =>
    `${scope(params, range)} AND name = ${params.add(name, "String")} ${filtersSql(params, filters)}`;
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
      `SELECT ${COUNTS} FROM events FINAL WHERE ${where(totalParams)}`,
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
    // Names and values in one pass: each value's events, and its name's.
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
  // The most frequent names, in order, each with its values.
  const keys: { key: string; events: number }[] = [];
  for (const row of values) {
    if (keys.length >= PROPERTY_KEYS) break;
    if (keys.at(-1)?.key !== row.key) keys.push({ key: row.key, events: count(row.key_events) });
  }

  const perDay = new Map(days.map((day) => [day.day, count(day.events)]));
  return {
    name,
    events: count(total?.events ?? 0),
    visitors: count(total?.visitors ?? 0),
    users: count(total?.users ?? 0),
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
