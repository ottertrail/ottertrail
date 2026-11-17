/**
 * Compares PostgreSQL with ClickHouse on the same fake data, to decide where
 * events, and later logs and traces, should be stored:
 *
 *   podman compose -f apps/api/scripts/bench-clickhouse.compose.yaml up -d
 *   vp run bench:storage                         (200,000 visits over 30 days)
 *   vp run bench:storage -- 1000000 30           (visits, days)
 *   vp run bench:storage -- 1000000 30 10000000  (… and 10 million log lines)
 *
 * The visits are generated once in a temporary PostgreSQL schema
 * (bench-data.ts, as for bench:reports) and copied into a temporary ClickHouse
 * database, so both hold exactly the same events. Each report runs in both:
 * PostgreSQL through the API's own report functions, ClickHouse through the
 * same rules written in its SQL below. The answers must match before their
 * times mean anything, so every pair is compared. Everything temporary is
 * dropped at the end. Numbers depend on the machine: they show the shape of
 * the cost, not a capacity promise.
 */
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { type Kysely, sql } from "kysely";

import { loadConfig } from "../src/config.ts";
import { createDatabase } from "../src/db/database.ts";
import { migrateToLatest } from "../src/db/migrate.ts";
import type { Database } from "../src/db/schema.ts";
import {
  type BreakdownRow,
  breakdown,
  type CustomEventRow,
  customEvents,
  type DayPoint,
  localDays,
  type PageRow,
  type ReportRange,
  type Summary,
  summary,
  timeseries,
  topPages,
} from "../src/reports/reports.ts";
import { ENGAGEMENT, PAGEVIEW, VISIT_CONTEXT_MS, VISIT_TIMEOUT_MS } from "../src/visits/visits.ts";
import { seedFakeVisits } from "./bench-data.ts";

const [visitsArgument = "200000", daysArgument = "30", logsArgument = "0"] = process.argv
  .slice(2)
  .filter((arg) => arg !== "--");
const visitCount = Number(visitsArgument);
const dayCount = Number(daysArgument);
const logCount = Number(logsArgument);
if (
  !Number.isInteger(visitCount) ||
  visitCount < 1 ||
  !Number.isInteger(dayCount) ||
  dayCount < 1 ||
  !Number.isInteger(logCount) ||
  logCount < 0
) {
  console.error("Usage: vp run bench:storage -- <visits> <days> [<log lines>]");
  process.exit(1);
}

/** The ClickHouse from bench-clickhouse.compose.yaml. */
const CLICKHOUSE_URL = process.env.BENCH_CLICKHOUSE_URL ?? "http://127.0.0.1:8123";
const CLICKHOUSE_HEADERS = { "X-ClickHouse-User": "bench", "X-ClickHouse-Key": "bench" };
/** PostgreSQL as ClickHouse's container reaches it: the development stack's service. */
const POSTGRES_FROM_CLICKHOUSE = process.env.BENCH_POSTGRES_HOST ?? "postgres:5432";

const LAST_DAY = "2026-10-31";
const END = new Date(`${LAST_DAY}T00:00:00Z`).getTime() + 86_400_000;
const firstDay = new Date(Date.UTC(2026, 9, 31 - dayCount + 1)).toISOString().slice(0, 10);

const { databaseUrl } = loadConfig();
const id = randomUUID().replaceAll("-", "");
const schema = `bench_${id}`;
const chDatabase = `bench_${id}`;
const admin = createDatabase({ connectionString: databaseUrl, maxConnections: 1 });
let db: Kysely<Database> | undefined;
let chCreated = false;

// ClickHouse over HTTP: no client library needed.

type Row = Record<string, unknown>;

function isRow(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Query IDs of the ClickHouse queries being measured, to read their memory afterwards. */
let collectedIds: string[] | undefined;

async function clickhouse(query: string, params: Record<string, string> = {}): Promise<Row[]> {
  const url = new URL(CLICKHOUSE_URL);
  for (const [name, value] of Object.entries(params)) {
    url.searchParams.set(`param_${name}`, value);
  }
  url.searchParams.set("output_format_json_quote_64bit_integers", "0");
  url.searchParams.set("join_use_nulls", "1");
  if (collectedIds !== undefined) {
    const queryId = randomUUID();
    collectedIds.push(queryId);
    url.searchParams.set("query_id", queryId);
  }
  const response = await fetch(url, { method: "POST", headers: CLICKHOUSE_HEADERS, body: query });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`ClickHouse ${response.status}: ${text.slice(0, 2000)}`);
  }
  if (text.trim() === "") {
    return [];
  }
  const parsed: unknown = JSON.parse(text);
  if (!isRow(parsed) || !Array.isArray(parsed.data)) {
    throw new Error(`Unexpected ClickHouse answer: ${text.slice(0, 200)}`);
  }
  return parsed.data.filter(isRow);
}

/** A ClickHouse string literal. Only ever used for names this script makes. */
const literal = (value: string) => `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;

/** "2026-10-31 00:00:00.000", as ClickHouse reads a DateTime64 parameter (UTC). */
const chTime = (date: Date | number) =>
  new Date(date).toISOString().replace("T", " ").replace("Z", "");

const count = (value: unknown) => Number(value ?? 0);
const ratio = (part: number, whole: number) => (whole === 0 ? null : part / whole);
const average = (value: unknown) => (value === null || value === undefined ? null : Number(value));
const text = (value: unknown) =>
  typeof value === "string"
    ? value
    : value === null || value === undefined
      ? null
      : JSON.stringify(value);

// Measuring.

async function timed(work: () => Promise<unknown>): Promise<number> {
  const start = performance.now();
  await work();
  return performance.now() - start;
}

/** Median of three runs, after one warm-up run. */
async function measure(work: () => Promise<unknown>): Promise<number> {
  await work();
  const runs = [await timed(work), await timed(work), await timed(work)].toSorted((a, b) => a - b);
  return runs[1] ?? 0;
}

/** As measure, and the largest memory any of the runs' ClickHouse queries used. */
async function measureClickHouse(
  work: () => Promise<unknown>,
): Promise<{ ms: number; ids: string[] }> {
  const ids: string[] = [];
  collectedIds = ids;
  try {
    return { ms: await measure(work), ids };
  } finally {
    collectedIds = undefined;
  }
}

async function peakMemoryMb(ids: string[]): Promise<number> {
  await clickhouse("SYSTEM FLUSH LOGS");
  const [row] = await clickhouse(
    `SELECT max(memory_usage) AS peak FROM system.query_log
     WHERE type = 'QueryFinish' AND has({ids:Array(String)}, query_id) FORMAT JSON`,
    { ids: `[${ids.map(literal).join(",")}]` },
  );
  return count(row?.peak) / 1_000_000;
}

/** Numbers rounded to 3 decimals, so float sums in two databases compare equal. */
function normalized(value: unknown): unknown {
  if (typeof value === "number") return Math.round(value * 1000) / 1000 + 0;
  if (Array.isArray(value)) return value.map(normalized);
  if (isRow(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalized(item)]));
  }
  return value;
}

// The reports in ClickHouse: the rules of visits.ts and reports.ts, in its SQL.

interface ChRange {
  /** The table to read, such as "bench_….events", or "bench_….events FINAL". */
  events: string;
  params: Record<string, string>;
  range: ReportRange;
}

function chRange(range: ReportRange, final = false): ChRange {
  return {
    events: `${chDatabase}.events${final ? " FINAL" : ""}`,
    range,
    params: {
      project: range.projectId,
      from: chTime(range.from),
      to: chTime(range.to),
      readFrom: chTime(range.from.getTime() - VISIT_CONTEXT_MS),
      readTo: chTime(range.to.getTime() + VISIT_CONTEXT_MS),
      tz: range.timeZone,
    },
  };
}

const T = "DateTime64(6, 'UTC')";

/** Events a person caused in the range: pageviews and custom events (reports.ts, activity). */
const activity = `project_id = {project:UUID}
  AND occurred_at >= {from:${T}} AND occurred_at < {to:${T}}
  AND visitor_id IS NOT NULL AND name != '${ENGAGEMENT}'`;

/** visitsQuery (visits.ts) in ClickHouse: same rules, window functions instead of filters. */
function visitsSql(events: string, { country = false } = {}): string {
  const order = "occurred_at, order_rank, event_id";
  return `
    WITH range_events AS (
      SELECT event_id, visitor_id, name, occurred_at, path ${country ? ", country" : ""},
             if(name = '${ENGAGEMENT}', 0, 1) AS order_rank,
             if(name = '${ENGAGEMENT}' AND match(JSONExtractRaw(properties, 'engagedMs'), '^[0-9]{1,9}$'),
                toInt64(JSONExtractRaw(properties, 'engagedMs')), 0) AS engaged_ms
      FROM ${events}
      WHERE project_id = {project:UUID} AND visitor_id IS NOT NULL
        AND occurred_at >= {readFrom:${T}} AND occurred_at < {readTo:${T}}
    ),
    marked AS (
      SELECT *,
             if(dateDiff('microsecond',
                         lagInFrame(occurred_at, 1, toDateTime64(0, 6, 'UTC')) OVER (
                           PARTITION BY visitor_id ORDER BY ${order}
                           ROWS BETWEEN 1 PRECEDING AND CURRENT ROW),
                         occurred_at) > ${VISIT_TIMEOUT_MS * 1000}, 1, 0) AS starts_visit
      FROM range_events
    ),
    numbered AS (
      SELECT *,
             sum(starts_visit) OVER so_far AS visit_number,
             name = '${ENGAGEMENT}'
               AND (maxIf(occurred_at, name != '${ENGAGEMENT}') OVER so_far
                    < maxIf(occurred_at, starts_visit = 1) OVER so_far) AS stale
      FROM marked
      WINDOW so_far AS (PARTITION BY visitor_id ORDER BY ${order}
                        ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
    ),
    visits AS (
      SELECT visitor_id,
             minIf(occurred_at, name != '${ENGAGEMENT}') AS started_at,
             max(occurred_at) AS ended_at,
             sumIf(engaged_ms, NOT stale) AS engaged_ms,
             countIf(name = '${PAGEVIEW}') AS pageviews,
             countIf(name NOT IN ('${PAGEVIEW}', '${ENGAGEMENT}')) AS interactions
             ${country ? `, argMinIf(tuple(country), (occurred_at, event_id), name != '${ENGAGEMENT}').1 AS country` : ""}
      FROM numbered
      GROUP BY visitor_id, visit_number
      HAVING countIf(name != '${ENGAGEMENT}') > 0
    )
    SELECT *,
           dateDiff('microsecond', started_at, ended_at) / 1000 AS duration_ms,
           pageviews <= 1 AND interactions = 0 AS bounce
    FROM visits
    WHERE started_at >= {from:${T}} AND started_at < {to:${T}}`;
}

async function chSummary({ events, params }: ChRange): Promise<Summary> {
  const [row = {}] = await clickhouse(
    `SELECT v.visits AS visits, v.visit_pageviews AS visit_pageviews, v.bounces AS bounces,
            v.avg_duration_ms AS avg_duration_ms, v.avg_engaged_ms AS avg_engaged_ms,
            a.visitors AS visitors, a.pageviews AS pageviews
     FROM (SELECT count() AS visits, sum(pageviews) AS visit_pageviews, countIf(bounce) AS bounces,
                  avgOrNull(duration_ms) AS avg_duration_ms, avgOrNull(engaged_ms) AS avg_engaged_ms
           FROM (${visitsSql(events)})) AS v
     CROSS JOIN (SELECT uniqExact(visitor_id) AS visitors, countIf(name = '${PAGEVIEW}') AS pageviews
                 FROM ${events} WHERE ${activity}) AS a
     FORMAT JSON`,
    params,
  );
  const visits = count(row.visits);
  return {
    visitors: count(row.visitors),
    pageviews: count(row.pageviews),
    visits,
    viewsPerVisit: ratio(count(row.visit_pageviews), visits),
    bounceRate: ratio(count(row.bounces), visits),
    avgDurationMs: average(row.avg_duration_ms),
    avgEngagedMs: average(row.avg_engaged_ms),
  };
}

async function chTimeseries({ events, params, range }: ChRange): Promise<DayPoint[]> {
  const [byDay, visitsByDay] = await Promise.all([
    clickhouse(
      `SELECT toString(toDate(occurred_at, {tz:String})) AS day, uniqExact(visitor_id) AS visitors,
              countIf(name = '${PAGEVIEW}') AS pageviews
       FROM ${events} WHERE ${activity} GROUP BY day FORMAT JSON`,
      params,
    ),
    clickhouse(
      `SELECT toString(toDate(started_at, {tz:String})) AS day, count() AS visits
       FROM (${visitsSql(events)}) GROUP BY day FORMAT JSON`,
      params,
    ),
  ]);
  // The benchmark counts days in UTC, so days are UTC dates here.
  const points: DayPoint[] = [];
  for (let at = range.from.getTime(); at < range.to.getTime(); at += 86_400_000) {
    const day = new Date(at).toISOString().slice(0, 10);
    const activityRow = byDay.find((row) => row.day === day);
    const visitRow = visitsByDay.find((row) => row.day === day);
    points.push({
      day,
      visitors: count(activityRow?.visitors),
      pageviews: count(activityRow?.pageviews),
      visits: count(visitRow?.visits),
    });
  }
  return points;
}

async function chTopPages({ events, params }: ChRange): Promise<PageRow[]> {
  const rows = await clickhouse(
    `SELECT views.path AS path, views.pageviews AS pageviews, views.visitors AS visitors,
            engagement.avg_engaged_ms AS avg_engaged_ms
     FROM (SELECT path, count() AS pageviews, uniqExact(visitor_id) AS visitors
           FROM ${events} WHERE ${activity} AND name = '${PAGEVIEW}' GROUP BY path) AS views
     LEFT JOIN (SELECT path,
                       avgIfOrNull(toInt64OrNull(JSONExtractRaw(properties, 'engagedMs')),
                                   match(JSONExtractRaw(properties, 'engagedMs'), '^[0-9]{1,9}$')) AS avg_engaged_ms
                FROM ${events}
                WHERE project_id = {project:UUID} AND occurred_at >= {from:${T}} AND occurred_at < {to:${T}}
                  AND name = '${ENGAGEMENT}'
                GROUP BY path) AS engagement USING (path)
     ORDER BY visitors DESC, pageviews DESC, path
     LIMIT 10 FORMAT JSON`,
    params,
  );
  return rows.map((row) => ({
    path: String(row.path),
    pageviews: count(row.pageviews),
    visitors: count(row.visitors),
    avgEngagedMs: average(row.avg_engaged_ms),
  }));
}

async function chCountries({ events, params }: ChRange): Promise<BreakdownRow[]> {
  const rows = await clickhouse(
    `SELECT country AS value, uniqExact(visitor_id) AS visitors, count() AS visits, countIf(bounce) AS bounces
     FROM (${visitsSql(events, { country: true })})
     GROUP BY value ORDER BY visitors DESC, visits DESC, value ASC NULLS LAST
     LIMIT 10 FORMAT JSON`,
    params,
  );
  return rows.map((row) => {
    const visits = count(row.visits);
    return {
      value: text(row.value),
      visitors: count(row.visitors),
      visits,
      bounceRate: ratio(count(row.bounces), visits),
    };
  });
}

async function chCustomEvents({ events, params }: ChRange): Promise<CustomEventRow[]> {
  const rows = await clickhouse(
    `SELECT name, count() AS events, uniqExact(visitor_id) AS visitors
     FROM ${events} WHERE ${activity} AND name != '${PAGEVIEW}'
     GROUP BY name ORDER BY visitors DESC, events DESC, name
     LIMIT 10 FORMAT JSON`,
    params,
  );
  return rows.map((row) => ({
    name: String(row.name),
    events: count(row.events),
    visitors: count(row.visitors),
  }));
}

// Logs: one project's lines over 7 days, searched and counted.

interface LogQuery {
  name: string;
  postgres: (bench: Kysely<Database>, projectId: string) => Promise<unknown[]>;
  clickhouse: (projectId: string) => Promise<unknown[]>;
}

const DAY_MS = 86_400_000;
const logsEnd = new Date(END);

const since = (ms: number) => new Date(END - ms);
const chLogParams = (projectId: string, from: Date) => ({
  project: projectId,
  from: chTime(from),
  to: chTime(logsEnd),
});
/** "2026-10-31 12:00:00.123456" (UTC) as an ISO string. */
const chIso = (value: unknown) => new Date(`${text(value)?.replace(" ", "T")}Z`).toISOString();
const newest = (rows: Row[]) =>
  rows.map((row) => ({
    at: chIso(row.at),
    service: text(row.service),
    message: text(row.message),
  }));
const pgNewest = (rows: { ts: Date; service: string; message: string }[]) =>
  rows.map((row) => ({ at: row.ts.toISOString(), service: row.service, message: row.message }));

function logQueries(): LogQuery[] {
  const chLogs = `${chDatabase}.logs`;
  const search = (label: string, ms: number): LogQuery => ({
    name: `"timeout", ${label}, newest 50`,
    postgres: async (bench, projectId) =>
      pgNewest(
        (
          await sql<{ ts: Date; service: string; message: string }>`
            select ts, service, message from logs
            where project_id = ${projectId} and ts >= ${since(ms)} and ts < ${logsEnd}
              and message ilike '%timeout%'
            order by ts desc limit 50`.execute(bench)
        ).rows,
      ),
    clickhouse: async (projectId) =>
      newest(
        await clickhouse(
          `SELECT toString(ts) AS at, service, message FROM ${chLogs}
           WHERE project_id = {project:UUID} AND ts >= {from:${T}} AND ts < {to:${T}}
             AND message ILIKE '%timeout%'
           ORDER BY ts DESC LIMIT 50 FORMAT JSON`,
          chLogParams(projectId, since(ms)),
        ),
      ),
  });
  return [
    {
      name: "lines per hour and level, 7 days",
      postgres: async (bench, projectId) =>
        (
          await sql<{ hour: Date; level: string; lines: string }>`
            select date_trunc('hour', ts) as hour, level, count(*) as lines from logs
            where project_id = ${projectId} and ts >= ${since(7 * DAY_MS)} and ts < ${logsEnd}
            group by 1, 2 order by 1, 2`.execute(bench)
        ).rows.map((row) => ({
          hour: row.hour.toISOString(),
          level: row.level,
          lines: Number(row.lines),
        })),
      clickhouse: async (projectId) =>
        (
          await clickhouse(
            `SELECT toString(toStartOfHour(ts)) AS hour, level, count() AS lines FROM ${chLogs}
             WHERE project_id = {project:UUID} AND ts >= {from:${T}} AND ts < {to:${T}}
             GROUP BY hour, level ORDER BY hour, level FORMAT JSON`,
            chLogParams(projectId, since(7 * DAY_MS)),
          )
        ).map((row) => ({
          hour: chIso(row.hour),
          level: text(row.level),
          lines: count(row.lines),
        })),
    },
    search("1 day", DAY_MS),
    search("7 days", 7 * DAY_MS),
    {
      name: "errors of one service, last hour, newest 100",
      postgres: async (bench, projectId) =>
        pgNewest(
          (
            await sql<{ ts: Date; service: string; message: string }>`
              select ts, service, message from logs
              where project_id = ${projectId} and ts >= ${since(3_600_000)} and ts < ${logsEnd}
                and service = 'billing' and level = 'error'
              order by ts desc limit 100`.execute(bench)
          ).rows,
        ),
      clickhouse: async (projectId) =>
        newest(
          await clickhouse(
            `SELECT toString(ts) AS at, service, message FROM ${chLogs}
             WHERE project_id = {project:UUID} AND ts >= {from:${T}} AND ts < {to:${T}}
               AND service = 'billing' AND level = 'error'
             ORDER BY ts DESC LIMIT 100 FORMAT JSON`,
            chLogParams(projectId, since(3_600_000)),
          ),
        ),
    },
    {
      name: '"timeout" count, 7 days',
      postgres: async (bench, projectId) =>
        (
          await sql<{ lines: string }>`
            select count(*) as lines from logs
            where project_id = ${projectId} and ts >= ${since(7 * DAY_MS)} and ts < ${logsEnd}
              and message ilike '%timeout%'`.execute(bench)
        ).rows.map((row) => Number(row.lines)),
      clickhouse: async (projectId) =>
        (
          await clickhouse(
            `SELECT count() AS lines FROM ${chLogs}
             WHERE project_id = {project:UUID} AND ts >= {from:${T}} AND ts < {to:${T}}
               AND message ILIKE '%timeout%' FORMAT JSON`,
            chLogParams(projectId, since(7 * DAY_MS)),
          )
        ).map((row) => count(row.lines)),
    },
  ];
}

// The run.

/** ClickHouse's postgresql() table function arguments for one table of the bench schema. */
function postgresTable(table: string): string {
  const url = new URL(databaseUrl);
  return [
    POSTGRES_FROM_CLICKHOUSE,
    url.pathname.slice(1),
    table,
    decodeURIComponent(url.username),
    decodeURIComponent(url.password) || "unused",
    schema,
  ]
    .map(literal)
    .join(", ");
}

async function chBytes(table: string): Promise<number> {
  const [row] = await clickhouse(
    `SELECT sum(bytes_on_disk) AS bytes FROM system.parts
     WHERE database = {db:String} AND table = {table:String} AND active FORMAT JSON`,
    { db: chDatabase, table },
  );
  return count(row?.bytes);
}

async function pgBytes(bench: Kysely<Database>, table: string): Promise<number> {
  const { rows } = await sql<{ bytes: string }>`
    select pg_total_relation_size(${`${schema}.${table}`}::regclass) as bytes`.execute(bench);
  return Number(rows[0]?.bytes ?? 0);
}

const mb = (bytes: number) => `${(bytes / 1_000_000).toFixed(0)} MB`;
const msText = (ms: number) => `${Math.round(ms)} ms`;

try {
  await clickhouse("SELECT 1 FORMAT JSON").catch((error: unknown) => {
    throw new Error(
      `ClickHouse is not reachable at ${CLICKHOUSE_URL}. Start it with: podman compose -f apps/api/scripts/bench-clickhouse.compose.yaml up -d\n${String(error)}`,
    );
  });

  await sql`create schema ${sql.id(schema)}`.execute(admin);
  const bench = createDatabase({ connectionString: databaseUrl, maxConnections: 2, schema });
  db = bench;
  await migrateToLatest(bench, { schema });
  const project = await bench
    .insertInto("projects")
    .values({ name: "Benchmark (fake data)", allowed_hostnames: ["example.com"] })
    .returning("id")
    .executeTakeFirstOrThrow();

  console.log(`Generating ${visitCount.toLocaleString("en")} fake visits over ${dayCount} days …`);
  const seedMs = await timed(async () => {
    await seedFakeVisits(bench, { projectId: project.id, visitCount, dayCount, firstDay });
    await sql`analyze events`.execute(bench);
  });
  const { rows: counted } = await sql<{ count: string }>`select count(*) from events`.execute(
    bench,
  );
  console.log(
    `PostgreSQL: ${Number(counted[0]?.count).toLocaleString("en")} events in ${(seedMs / 1000).toFixed(1)} s`,
  );

  await clickhouse(`CREATE DATABASE ${chDatabase}`);
  chCreated = true;
  // Ordered by project and time: one project's range is one contiguous read.
  // ReplacingMergeTree drops rows with the same key (a retried event) when it
  // merges parts, the nearest it has to PostgreSQL's unique (project_id, event_id).
  await clickhouse(`
    CREATE TABLE ${chDatabase}.events (
      project_id UUID,
      event_id UUID,
      name LowCardinality(String),
      occurred_at ${T},
      received_at ${T},
      path String,
      referrer Nullable(String),
      utm_source LowCardinality(Nullable(String)),
      utm_medium LowCardinality(Nullable(String)),
      utm_campaign LowCardinality(Nullable(String)),
      utm_term Nullable(String),
      utm_content Nullable(String),
      properties String,
      browser LowCardinality(Nullable(String)),
      browser_version LowCardinality(Nullable(String)),
      os LowCardinality(Nullable(String)),
      device_type LowCardinality(Nullable(String)),
      country LowCardinality(Nullable(String)),
      region LowCardinality(Nullable(String)),
      city LowCardinality(Nullable(String)),
      visitor_id Nullable(Int64)
    ) ENGINE = ReplacingMergeTree
    PARTITION BY toYYYYMM(occurred_at)
    ORDER BY (project_id, occurred_at, event_id)`);
  const copyMs = await timed(async () => {
    await clickhouse(`
      INSERT INTO ${chDatabase}.events
      SELECT project_id, event_id, name, occurred_at, received_at, path, referrer,
             utm_source, utm_medium, utm_campaign, utm_term, utm_content, properties,
             browser, browser_version, os, device_type, country, region, city, visitor_id
      FROM postgresql(${postgresTable("events")})`);
    await clickhouse(`OPTIMIZE TABLE ${chDatabase}.events FINAL`);
  });
  const [chCount] = await clickhouse(`SELECT count() AS n FROM ${chDatabase}.events FORMAT JSON`);
  console.log(
    `ClickHouse: ${count(chCount?.n).toLocaleString("en")} events copied and merged in ${(copyMs / 1000).toFixed(1)} s`,
  );
  console.log(
    `Size on disk: PostgreSQL ${mb(await pgBytes(bench, "events"))} (table and indexes), ClickHouse ${mb(await chBytes("events"))}\n`,
  );

  const ranges: [string, string][] = [
    ["1 day", LAST_DAY],
    ["7 days", new Date(Date.UTC(2026, 9, 31 - 6)).toISOString().slice(0, 10)],
    [`${dayCount} days`, firstDay],
  ];
  const reports: {
    name: string;
    postgres: (range: ReportRange) => Promise<unknown>;
    clickhouse: (range: ReportRange) => Promise<unknown>;
  }[] = [
    {
      name: "summary",
      postgres: (r) => summary(bench, r),
      clickhouse: (r) => chSummary(chRange(r)),
    },
    {
      name: "summary, deduplicated (FINAL)",
      postgres: (r) => summary(bench, r),
      clickhouse: (r) => chSummary(chRange(r, true)),
    },
    {
      name: "visitors per day",
      postgres: (r) => timeseries(bench, r),
      clickhouse: (r) => chTimeseries(chRange(r)),
    },
    {
      name: "top pages",
      postgres: (r) => topPages(bench, r),
      clickhouse: (r) => chTopPages(chRange(r)),
    },
    {
      name: "countries",
      postgres: (r) => breakdown(bench, r, "country"),
      clickhouse: (r) => chCountries(chRange(r)),
    },
    {
      name: "custom events",
      postgres: (r) => customEvents(bench, r),
      clickhouse: (r) => chCustomEvents(chRange(r)),
    },
  ];

  const times: Record<string, Record<string, string>> = {};
  const memory: Record<string, Record<string, string>> = {};
  const differences: string[] = [];
  for (const [label, from] of ranges) {
    const range: ReportRange = {
      projectId: project.id,
      timeZone: "UTC",
      ...(await localDays(bench, from, LAST_DAY, "UTC")),
    };
    for (const report of reports) {
      const expected = normalized(await report.postgres(range));
      const actual = normalized(await report.clickhouse(range));
      if (!isDeepStrictEqual(expected, actual)) {
        differences.push(
          `${report.name}, ${label}:\n  PostgreSQL ${JSON.stringify(expected)}\n  ClickHouse ${JSON.stringify(actual)}`,
        );
      }
      const pgMs = await measure(() => report.postgres(range));
      const ch = await measureClickHouse(() => report.clickhouse(range));
      times[report.name] = {
        ...times[report.name],
        [`${label}: PostgreSQL`]: msText(pgMs),
        [`${label}: ClickHouse`]: msText(ch.ms),
      };
      memory[report.name] = {
        ...memory[report.name],
        [label]: `${(await peakMemoryMb(ch.ids)).toFixed(0)} MB`,
      };
    }
  }
  console.log("Median time per report (after a warm-up run):");
  console.table(times);
  console.log("ClickHouse's peak memory per report query:");
  console.table(memory);
  console.log(
    differences.length === 0
      ? "Every report gave the same answer in both databases.\n"
      : `ANSWERS DIFFER, so the times above do not compare like with like:\n${differences.join("\n")}\n`,
  );

  if (logCount > 0) {
    console.log(`Generating ${logCount.toLocaleString("en")} log lines over 7 days …`);
    const logSeedMs = await timed(async () => {
      await sql`
        create table logs (
          project_id uuid not null,
          ts timestamptz not null,
          service text not null,
          level text not null,
          message text not null
        )`.execute(bench);
      // Lines from a few templates with numbers in them, 1% of them timeouts.
      await sql`
        insert into logs
        select ${project.id}, ${logsEnd}::timestamptz - s.at * interval '7 days',
               (array['api', 'web', 'worker', 'billing', 'search'])[1 + floor(s.svc * 5)::int],
               case when s.lvl < 0.01 then 'debug' when s.lvl < 0.05 then 'error'
                    when s.lvl < 0.15 then 'warn' else 'info' end,
               case when s.kind < 0.4 then format('GET /api/users/%s 200 in %sms', s.n, s.n % 900)
                    when s.kind < 0.6 then format('POST /api/orders/%s 201 in %sms', s.n, s.n % 700)
                    when s.kind < 0.75 then format('user %s signed in from %s', s.n,
                                                   (array['DE', 'US', 'SG'])[1 + s.n % 3])
                    when s.kind < 0.9 then format('job sync-%s finished in %sms, %s rows',
                                                  s.n % 50, s.n % 5000, s.n)
                    when s.kind < 0.99 then format('cache miss for key session:%s', s.n)
                    else format('connection timeout to db-%s after 3000ms', s.n % 4) end
        from (
          select random() as at, random() as svc, random() as lvl, random() as kind,
                 floor(random() * 100000)::int as n
          from generate_series(1, ${logCount})
        ) as s`.execute(bench);
      await sql`create index on logs (project_id, ts)`.execute(bench);
      await sql`analyze logs`.execute(bench);
    });
    console.log(`PostgreSQL: generated and indexed in ${(logSeedMs / 1000).toFixed(1)} s`);
    const logCopyMs = await timed(async () => {
      await clickhouse(`
        CREATE TABLE ${chDatabase}.logs (
          project_id UUID,
          ts ${T},
          service LowCardinality(String),
          level LowCardinality(String),
          message String
        ) ENGINE = MergeTree
        PARTITION BY toYYYYMMDD(ts)
        ORDER BY (project_id, ts)`);
      await clickhouse(
        `INSERT INTO ${chDatabase}.logs SELECT project_id, ts, service, level, message
         FROM postgresql(${postgresTable("logs")})`,
      );
      await clickhouse(`OPTIMIZE TABLE ${chDatabase}.logs FINAL`);
    });
    console.log(`ClickHouse: copied and merged in ${(logCopyMs / 1000).toFixed(1)} s`);
    console.log(
      `Size on disk: PostgreSQL ${mb(await pgBytes(bench, "logs"))} (table and index), ClickHouse ${mb(await chBytes("logs"))}\n`,
    );

    const logTimes: Record<string, Record<string, string>> = {};
    const logDifferences: string[] = [];
    for (const query of logQueries()) {
      const expected = normalized(await query.postgres(bench, project.id));
      const actual = normalized(await query.clickhouse(project.id));
      if (!isDeepStrictEqual(expected, actual)) {
        logDifferences.push(
          `${query.name}:\n  PostgreSQL ${JSON.stringify(expected).slice(0, 300)}\n  ClickHouse ${JSON.stringify(actual).slice(0, 300)}`,
        );
      }
      const pgMs = await measure(() => query.postgres(bench, project.id));
      const ch = await measureClickHouse(() => query.clickhouse(project.id));
      logTimes[query.name] = {
        PostgreSQL: msText(pgMs),
        ClickHouse: msText(ch.ms),
        "ClickHouse memory": `${(await peakMemoryMb(ch.ids)).toFixed(0)} MB`,
      };
    }
    console.log("Logs, median time per query (after a warm-up run):");
    console.table(logTimes);
    console.log(
      logDifferences.length === 0
        ? "Every log query gave the same answer in both databases."
        : `ANSWERS DIFFER:\n${logDifferences.join("\n")}`,
    );
  }
} finally {
  await db?.destroy();
  await sql`drop schema if exists ${sql.id(schema)} cascade`.execute(admin);
  await admin.destroy();
  if (chCreated) {
    await clickhouse(`DROP DATABASE IF EXISTS ${chDatabase}`);
  }
  console.log("\nThe temporary PostgreSQL schema and ClickHouse database were dropped.");
}
