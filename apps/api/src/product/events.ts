import { QueryParams, queryRows, type Reader } from "../clickhouse/query.ts";
import { DEFAULT_ENVIRONMENT } from "../collection/environment.ts";
import {
  COLUMN_DIMENSIONS,
  type ColumnDimension,
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

/**
 * The dimensions an event's page lists and filters by, named as the
 * Analytics page's: the source and campaign of the event's visit, and the
 * event's own location, device, and release.
 */
export const EVENT_DIMENSIONS = [
  ...VISIT_SOURCE_NAMES,
  ...([
    "country",
    "region",
    "city",
    "deviceType",
    "browser",
    "os",
    "release",
  ] as const satisfies readonly ColumnDimension[]),
] as const;
export type EventDimension = (typeof EVENT_DIMENSIONS)[number];

/** Only events with this value; null: unknown (an event without a visit, no location …). */
export interface EventDimensionFilter {
  name: EventDimension;
  value: string | null;
}

/** An event's page: which events of the name count. */
export interface EventMatch {
  name: string;
  filters: readonly PropertyFilter[];
  dimensions: readonly EventDimensionFilter[];
  /** The project's hostnames: a referrer on one is not a source. */
  ownHostnames: readonly string[];
}

const isVisitSource = (name: EventDimension): name is VisitSourceName =>
  (VISIT_SOURCE_NAMES as readonly string[]).includes(name);

/** SQL for one dimension of an event, or of withVisitSourceSql's rows for a visit's. */
function dimensionSql(name: EventDimension): string {
  return isVisitSource(name) ? VISIT_SOURCE_COLUMNS[name] : COLUMN_DIMENSIONS[name];
}

function dimensionCondition(params: QueryParams, filter: EventDimensionFilter): string {
  const value = dimensionSql(filter.name);
  return filter.value === null
    ? `(${value}) IS NULL`
    : `(${value}) = ${params.add(filter.value, "String")}`;
}

/**
 * The matching events of the range (from `from`), with their visit's
 * source and campaign (visit-source.ts) when `withVisit` or a filter needs
 * them. Only the visits of the visitor IDs that sent a matching event are
 * worked out.
 */
function matchingEvents(
  params: QueryParams,
  range: ProductRange,
  match: EventMatch,
  { from = range.from, withVisit = false }: { from?: Date; withVisit?: boolean } = {},
): string {
  const own = match.dimensions.filter((filter) => !isVisitSource(filter.name));
  const visit = match.dimensions.filter((filter) => isVisitSource(filter.name));
  const where = () =>
    `${scope(params, range, from)} AND name = ${params.add(match.name, "String")} ${filtersSql(params, match.filters)}
     ${own.map((filter) => `AND ${dimensionCondition(params, filter)}`).join(" ")}`;
  const events = `SELECT * FROM events FINAL WHERE ${where()}`;
  if (!withVisit && visit.length === 0) return events;
  const credited = withVisitSourceSql(
    { ...range, from, ownHostnames: match.ownHostnames },
    events,
    `SELECT visitor_id FROM events WHERE ${where()} AND visitor_id IS NOT NULL`,
    params,
  );
  if (visit.length === 0) return credited;
  return `SELECT * FROM (${credited})
    WHERE ${visit.map((filter) => dimensionCondition(params, filter)).join(" AND ")}`;
}

/** Return zero counts when no events match. */
export async function eventDetail(
  reader: Reader,
  range: ProductRange,
  previous: PreviousPeriod,
  match: EventMatch,
): Promise<EventDetail> {
  const { name } = match;
  const totalParams = new QueryParams();
  const dayParams = new QueryParams();
  const valueParams = new QueryParams();
  const timeZone = dayParams.add(range.timeZone, "String");
  // Each property as (key, raw JSON value), one row per property of each event.
  const pairs = (params: QueryParams) =>
    `SELECT tupleElement(pair, 1) AS key, tupleElement(pair, 2) AS raw
     FROM (${matchingEvents(params, range, match)})
     ARRAY JOIN JSONExtractKeysAndValuesRaw(properties) AS pair`;

  const [[total], days, values] = await Promise.all([
    queryRows<Record<string, unknown>>(
      reader,
      `SELECT ${countsSql(totalParams, range, previous)}
       FROM (${matchingEvents(totalParams, range, match, { from: previous.from })})`,
      totalParams,
    ),
    queryRows<{ day: string; events: string }>(
      reader,
      `SELECT toString(toDate(occurred_at, ${timeZone})) AS day, count() AS events
       FROM (${matchingEvents(dayParams, range, match)})
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

/** One dimension's value: null is unknown (an event without a visit, no location …). */
export interface EventDimensionValue {
  value: string | null;
  visitors: number;
  events: number;
}

export type EventBreakdowns = Record<EventDimension, EventDimensionValue[]>;

/**
 * The matching events by each dimension (EVENT_DIMENSIONS), PROPERTY_VALUES
 * values each, most visitors first, in one pass: each event once per
 * dimension (ARRAY JOIN). A campaign of "" is a visit without one.
 */
export async function eventBreakdowns(
  reader: Reader,
  range: ProductRange,
  match: EventMatch,
): Promise<EventBreakdowns> {
  const params = new QueryParams();
  // The dimension names and their SQL are constants, never input.
  const pairs = EVENT_DIMENSIONS.map(
    (dimension) => `tuple('${dimension}', CAST(${dimensionSql(dimension)} AS Nullable(String)))`,
  );
  const rows = await queryRows<{
    dimension: string;
    value: string | null;
    visitors: string;
    events: string;
  }>(
    reader,
    `SELECT pair.1 AS dimension, pair.2 AS value, uniqExact(visitor_id) AS visitors,
            count() AS events
     FROM (${matchingEvents(params, range, match, { withVisit: true })})
     ARRAY JOIN [${pairs.join(", ")}] AS pair
     GROUP BY dimension, value
     ORDER BY dimension, value IS NULL, visitors DESC, events DESC, value ASC
     LIMIT ${PROPERTY_VALUES} BY dimension`,
    params,
  );
  const valuesOf = (dimension: EventDimension) =>
    rows
      .filter((row) => row.dimension === dimension)
      .map((row) => ({
        value: row.value,
        visitors: count(row.visitors),
        events: count(row.events),
      }));
  return {
    source: valuesOf("source"),
    utmCampaign: valuesOf("utmCampaign"),
    country: valuesOf("country"),
    region: valuesOf("region"),
    city: valuesOf("city"),
    deviceType: valuesOf("deviceType"),
    browser: valuesOf("browser"),
    os: valuesOf("os"),
    release: valuesOf("release"),
  };
}
