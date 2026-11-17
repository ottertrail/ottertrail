/**
 * Measures how long the report queries take on fake data:
 *
 *   vp run bench:reports                    (200,000 visits over 30 days)
 *   vp run bench:reports -- 50000 14        (50,000 visits over 14 days)
 *
 * The fake events go into a temporary PostgreSQL schema, then to a
 * temporary ClickHouse database the way the worker copies them, and reports
 * read them there. Both are dropped at the end: no real project or event is
 * read or written. Numbers depend on the machine, so they show the shape of
 * the cost, not a capacity promise.
 */
import { randomUUID } from "node:crypto";

import { type Kysely, sql } from "kysely";

import { createClickHouse, identifier } from "../src/clickhouse/clickhouse.ts";
import { copyEventsToClickHouse } from "../src/clickhouse/copy-events.ts";
import { migrateClickHouse } from "../src/clickhouse/migrate.ts";
import type { Reader } from "../src/clickhouse/query.ts";
import { loadConfig } from "../src/config.ts";
import { createDatabase } from "../src/db/database.ts";
import { migrateToLatest } from "../src/db/migrate.ts";
import type { Database } from "../src/db/schema.ts";
import { projectAnalytics } from "../src/reports/analytics.ts";
import {
  breakdown,
  customEvents,
  localDays,
  type ReportRange,
  summary,
  timeseries,
  topPages,
} from "../src/reports/reports.ts";
import { seedFakeVisits } from "./bench-data.ts";

const [visitsArgument = "200000", daysArgument = "30"] = process.argv
  .slice(2)
  .filter((arg) => arg !== "--");
const visitCount = Number(visitsArgument);
const dayCount = Number(daysArgument);
if (
  !Number.isInteger(visitCount) ||
  visitCount < 1 ||
  !Number.isInteger(dayCount) ||
  dayCount < 1
) {
  console.error("Usage: vp run bench:reports -- <visits> <days>");
  process.exit(1);
}

const LAST_DAY = "2026-10-31";
const firstDay = new Date(Date.UTC(2026, 9, 31 - dayCount + 1)).toISOString().slice(0, 10);

const config = loadConfig();
const schema = `bench_${randomUUID().replaceAll("-", "")}`;
const admin = createDatabase({ connectionString: config.databaseUrl, maxConnections: 1 });
let db: Kysely<Database> | undefined;
const clickhouseAdmin = createClickHouse(config.clickhouse, { database: "default" });
const clickhouse = createClickHouse(config.clickhouse, { database: schema });
const reader: Reader = { client: clickhouse };

async function timed<T>(work: () => Promise<T>): Promise<number> {
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

try {
  await sql`create schema ${sql.id(schema)}`.execute(admin);
  const bench = createDatabase({
    connectionString: config.databaseUrl,
    maxConnections: 2,
    schema,
  });
  db = bench;
  await migrateToLatest(bench, { schema });
  await migrateClickHouse(clickhouseAdmin, schema);

  const organization = await bench
    .insertInto("organizations")
    .values({ name: "Benchmark (fake data)", time_zone: "UTC" })
    .returning("id")
    .executeTakeFirstOrThrow();
  const project = await bench
    .insertInto("projects")
    .values({
      organization_id: organization.id,
      name: "Benchmark (fake data)",
      allowed_hostnames: ["example.com"],
    })
    .returning("id")
    .executeTakeFirstOrThrow();

  console.log(`Generating ${visitCount.toLocaleString("en")} fake visits over ${dayCount} days …`);
  const seedMs = await timed(async () => {
    await seedFakeVisits(bench, { projectId: project.id, visitCount, dayCount, firstDay });
    await sql`analyze events`.execute(bench);
  });

  const { rows } = await sql<{ count: string }>`select count(*) from events`.execute(bench);
  const eventCount = Number(rows[0]?.count);
  console.log(`${eventCount.toLocaleString("en")} events in ${(seedMs / 1000).toFixed(1)} s`);

  // As the worker does, then merged as ClickHouse does in the background
  // over time, so reports read a table as it usually is.
  const copyMs = await timed(() => copyEventsToClickHouse(bench, clickhouse));
  console.log(
    `Copied to ClickHouse in ${(copyMs / 1000).toFixed(1)} s (${Math.round(eventCount / (copyMs / 1000)).toLocaleString("en")} events a second)`,
  );
  await clickhouse.command({ query: "OPTIMIZE TABLE events FINAL" });
  console.log("");

  const ranges: [string, string][] = [
    ["1 day", LAST_DAY],
    ["7 days", new Date(Date.UTC(2026, 9, 31 - 6)).toISOString().slice(0, 10)],
    [`${dayCount} days`, firstDay],
  ];
  const results: Record<string, Record<string, string>> = {};
  const reports = {
    summary: (r: ReportRange) => summary(reader, r),
    timeseries: (r: ReportRange) => timeseries(reader, r),
    "top pages": (r: ReportRange) => topPages(reader, r),
    sources: (r: ReportRange) => breakdown(reader, r, "source"),
    countries: (r: ReportRange) => breakdown(reader, r, "country"),
    "custom events": (r: ReportRange) => customEvents(reader, r),
  };
  for (const [label, from] of ranges) {
    const range: ReportRange = {
      projectId: project.id,
      timeZone: "UTC",
      ownHostnames: ["example.com"],
      environment: "production",
      ...(await localDays(bench, from, LAST_DAY, "UTC")),
    };
    for (const [name, report] of Object.entries(reports)) {
      const ms = await measure(() => report(range));
      results[name] = { ...results[name], [label]: `${Math.round(ms)} ms` };
    }
  }
  console.log("Median time per report (after a warm-up run):");
  console.table(results);

  // A whole analytics page: every report working out visits on its own,
  // compared with the endpoint, which works them out once (analytics.ts).
  const pageDimensions = [
    "source",
    "utmCampaign",
    "entryPage",
    "exitPage",
    "country",
    "region",
    "city",
    "deviceType",
    "browser",
    "os",
  ] as const;
  const page: Record<string, Record<string, string>> = {};
  for (const [label, from] of ranges) {
    const range: ReportRange = {
      projectId: project.id,
      timeZone: "UTC",
      ownHostnames: ["example.com"],
      environment: "production",
      ...(await localDays(bench, from, LAST_DAY, "UTC")),
    };
    const separately = await measure(async () => {
      await summary(reader, range);
      await timeseries(reader, range);
      await topPages(reader, range);
      for (const dimension of pageDimensions) {
        await breakdown(reader, range, dimension);
      }
      await customEvents(reader, range);
    });
    const once = await measure(() =>
      projectAnalytics(bench, clickhouse, {
        projectId: project.id,
        firstDay: from,
        lastDay: LAST_DAY,
        timeZone: "UTC",
      }),
    );
    page["each report works out visits"] = {
      ...page["each report works out visits"],
      [label]: `${Math.round(separately)} ms`,
    };
    page["visits worked out once"] = {
      ...page["visits worked out once"],
      [label]: `${Math.round(once)} ms`,
    };
    // Filtered pages: a visit property, and a page (visits that viewed it).
    for (const [name, filter] of [
      ["filtered by a country", { name: "country", value: "DE" }],
      ["filtered by a page", { name: "page", value: "/pricing" }],
    ] as const) {
      const ms = await measure(() =>
        projectAnalytics(bench, clickhouse, {
          projectId: project.id,
          firstDay: from,
          lastDay: LAST_DAY,
          timeZone: "UTC",
          filters: [filter],
        }),
      );
      page[name] = { ...page[name], [label]: `${Math.round(ms)} ms` };
    }
  }
  console.log("\nA whole analytics page (14 reports), unfiltered and filtered:");
  console.table(page);
} finally {
  await db?.destroy();
  await sql`drop schema if exists ${sql.id(schema)} cascade`.execute(admin);
  await admin.destroy();
  await clickhouse.close();
  await clickhouseAdmin.command({ query: `DROP DATABASE IF EXISTS ${identifier(schema)}` });
  await clickhouseAdmin.close();
  console.log("The temporary schema and ClickHouse database were dropped.");
}
