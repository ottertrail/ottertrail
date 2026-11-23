import { QueryParams, queryRows, type Reader } from "../clickhouse/query.ts";
import { DEFAULT_ENVIRONMENT } from "../collection/environment.ts";
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

function scope(params: QueryParams, range: ProductRange): string {
  return `project_id = ${params.add(range.projectId, "UUID")}
    AND environment = ${params.add(range.environment, "String")}
    AND occurred_at >= ${params.time(range.from)}
    AND occurred_at < ${params.time(range.to)}
    AND ${PRODUCT_EVENT}`;
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

export interface EventRow {
  name: string;
  events: number;
  /** Daily visitor IDs; a server's events have none. */
  visitors: number;
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
