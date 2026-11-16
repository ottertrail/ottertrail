/**
 * Measures how long the report queries take on fake data:
 *
 *   vp run bench:reports                    (200,000 visits over 30 days)
 *   vp run bench:reports -- 50000 14        (50,000 visits over 14 days)
 *
 * Everything happens in a temporary schema that is dropped at the end: no
 * real project or event is read or written. Numbers depend on the machine,
 * so they show the shape of the cost, not a capacity promise.
 */
import { randomUUID } from "node:crypto";

import { type Kysely, sql } from "kysely";

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

const { databaseUrl } = loadConfig();
const schema = `bench_${randomUUID().replaceAll("-", "")}`;
const admin = createDatabase({ connectionString: databaseUrl, maxConnections: 1 });
let db: Kysely<Database> | undefined;

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
    // Each visit: 1-5 pages two minutes apart, an engagement report per page,
    // a referrer on the first page, and a signup in 10% of visits. About 60%
    // as many visitors as visits each day, so some visitors come back.
    await sql`
      with visits as (
        select v,
               (${firstDay}::date)::timestamptz + random() * (${dayCount} * interval '1 day') as started_at,
               1 + floor(random() * 5)::int as pages,
               (array['https://www.google.com/', 'https://news.ycombinator.com/', 'https://twitter.com/',
                      'https://example.com/', null, null])[1 + floor(random() * 6)::int] as referrer,
               (array['DE', 'US', 'GB', 'SG', 'FR', 'IN', 'BR'])[1 + floor(random() * 7)::int] as country,
               (array['Chrome', 'Safari', 'Firefox', 'Microsoft Edge'])[1 + floor(random() * 4)::int] as browser,
               (array['desktop', 'mobile', 'tablet'])[1 + floor(random() * 3)::int] as device_type,
               random() < 0.15 as from_newsletter
        from generate_series(1, ${visitCount}) as v
      ),
      visitors as (
        select visits.*,
               floor(extract(epoch from started_at) / 86400)::bigint * 1000000000
                 + v % greatest(1, (${visitCount} * 0.6 / ${dayCount})::int) as visitor_id
        from visits
      )
      insert into events (project_id, event_id, name, occurred_at, received_at, path, referrer,
                          utm_source, utm_campaign, browser, device_type, country, visitor_id, properties)
      select ${project.id}, gen_random_uuid(), e.name, e.at, e.at, page.path, e.referrer,
             e.utm_source, e.utm_campaign, w.browser, w.device_type, w.country, w.visitor_id, e.properties
      from visitors w
      cross join lateral generate_series(0, w.pages - 1) as p(i)
      cross join lateral (
        select (array['/', '/pricing', '/docs', '/blog', '/signup', '/about'])[1 + (w.v + p.i) % 6] as path
      ) as page
      cross join lateral (
        values
          ('pageview', w.started_at + p.i * interval '2 minutes',
           case when p.i = 0 then w.referrer end,
           case when p.i = 0 and w.from_newsletter then 'newsletter' end,
           case when p.i = 0 and w.from_newsletter then 'launch' end,
           '{}'::jsonb),
          ('engagement', w.started_at + p.i * interval '2 minutes' + interval '90 seconds',
           null, null, null, jsonb_build_object('engagedMs', floor(random() * 90000)::int))
      ) as e(name, at, referrer, utm_source, utm_campaign, properties)
    `.execute(bench);
    await sql`
      insert into events (project_id, event_id, name, occurred_at, received_at, path, visitor_id)
      select project_id, gen_random_uuid(), 'signup', occurred_at + interval '30 seconds',
             occurred_at + interval '30 seconds', path, visitor_id
      from events
      where name = 'pageview' and referrer is not null and random() < 0.2
    `.execute(bench);
    await sql`analyze events`.execute(bench);
  });

  const { rows } = await sql<{ count: string }>`select count(*) from events`.execute(bench);
  console.log(
    `${Number(rows[0]?.count).toLocaleString("en")} events in ${(seedMs / 1000).toFixed(1)} s\n`,
  );

  const ranges: [string, string][] = [
    ["1 day", LAST_DAY],
    ["7 days", new Date(Date.UTC(2026, 9, 31 - 6)).toISOString().slice(0, 10)],
    [`${dayCount} days`, firstDay],
  ];
  const results: Record<string, Record<string, string>> = {};
  const reports = {
    summary: (r: ReportRange, d: Kysely<Database>) => summary(d, r),
    timeseries: (r: ReportRange, d: Kysely<Database>) => timeseries(d, r),
    "top pages": (r: ReportRange, d: Kysely<Database>) => topPages(d, r),
    sources: (r: ReportRange, d: Kysely<Database>) => breakdown(d, r, "source"),
    countries: (r: ReportRange, d: Kysely<Database>) => breakdown(d, r, "country"),
    "custom events": (r: ReportRange, d: Kysely<Database>) => customEvents(d, r),
  };
  for (const [label, from] of ranges) {
    const range: ReportRange = {
      projectId: project.id,
      timeZone: "UTC",
      ...(await localDays(bench, from, LAST_DAY, "UTC")),
    };
    for (const [name, report] of Object.entries(reports)) {
      const ms = await measure(() => report(range, bench));
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
      ...(await localDays(bench, from, LAST_DAY, "UTC")),
    };
    const separately = await measure(async () => {
      await summary(bench, range);
      await timeseries(bench, range);
      await topPages(bench, range);
      for (const dimension of pageDimensions) {
        await breakdown(bench, range, dimension);
      }
      await customEvents(bench, range);
    });
    const once = await measure(() =>
      projectAnalytics(bench, {
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
  }
  console.log("\nA whole analytics page (14 reports):");
  console.table(page);
} finally {
  await db?.destroy();
  await sql`drop schema if exists ${sql.id(schema)} cascade`.execute(admin);
  await admin.destroy();
  console.log("The temporary schema was dropped.");
}
