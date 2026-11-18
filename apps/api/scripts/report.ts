/**
 * Prints a project's reports for the last few days, counted in the
 * instance's timezone:
 *
 *   vp run report                            (the first project, last 7 days)
 *   vp run report -- Playground 30           (a project by name, last 30 days)
 *   vp run report -- Playground 30 staging   (another environment than production)
 *
 * The days are today and the days before it, so the last day is partial.
 * Reports read the events in ClickHouse.
 */
import { createClickHouse } from "../src/clickhouse/clickhouse.ts";
import type { Reader } from "../src/clickhouse/query.ts";
import { DEFAULT_ENVIRONMENT } from "../src/collection/environment.ts";
import { loadConfig } from "../src/config.ts";
import { createDatabase } from "../src/db/database.ts";
import {
  breakdown,
  customEvents,
  localDays,
  type ReportRange,
  summary,
  timeseries,
  topPages,
} from "../src/reports/reports.ts";
import { readInstanceSettings } from "../src/settings/settings.ts";
import { dayIn } from "../src/visitors/visitor-ids.ts";

// `vp run report -- …` passes the "--" separator through; skip it.
const [projectName, daysArgument = "7", environment = DEFAULT_ENVIRONMENT] = process.argv
  .slice(2)
  .filter((arg) => arg !== "--");
const dayCount = Number(daysArgument);
if (!Number.isInteger(dayCount) || dayCount < 1 || dayCount > 366) {
  console.error(
    `The number of days must be a whole number from 1 to 366, received "${daysArgument}".`,
  );
  process.exit(1);
}

const config = loadConfig();
const db = createDatabase({ connectionString: config.databaseUrl, maxConnections: 2 });
// PostgreSQL holds the projects and counts the days; ClickHouse holds the events.
const reader: Reader = { client: createClickHouse(config.clickhouse) };

const percent = (value: number | null) => (value === null ? "-" : `${Math.round(value * 100)}%`);
const duration = (ms: number | null) => {
  if (ms === null) return "-";
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
};
const bar = (value: number, max: number) =>
  "█".repeat(max === 0 ? 0 : Math.round((value / max) * 30));

/** "YYYY-MM-DD" minus a number of calendar days. */
function daysBefore(day: string, count: number): string {
  const [year = 0, month = 1, date = 1] = day.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, date - count)).toISOString().slice(0, 10);
}

try {
  const query = db
    .selectFrom("projects")
    .select(["projects.id", "projects.name", "projects.allowed_hostnames"])
    .orderBy("projects.created_at")
    .limit(1);
  const project = await (
    projectName === undefined ? query : query.where("projects.name", "=", projectName)
  ).executeTakeFirst();
  if (project === undefined) {
    console.error(
      projectName === undefined
        ? "There are no projects."
        : `No project is named "${projectName}".`,
    );
    process.exitCode = 1;
  } else {
    const { timeZone } = await readInstanceSettings(db);
    const today = dayIn(timeZone)(new Date());
    const firstDay = daysBefore(today, dayCount - 1);
    const range: ReportRange = {
      projectId: project.id,
      timeZone,
      ownHostnames: project.allowed_hostnames,
      environment: environment.toLowerCase(),
      ...(await localDays(db, firstDay, today, timeZone)),
    };

    console.log(
      `\n${project.name}, ${range.environment}: ${firstDay} to ${today} (${timeZone}; today is partial)\n`,
    );
    const total = await summary(reader, range);
    console.table({
      Visitors: total.visitors,
      Pageviews: total.pageviews,
      Visits: total.visits,
      "Views per visit": total.viewsPerVisit === null ? "-" : total.viewsPerVisit.toFixed(1),
      "Bounce rate": percent(total.bounceRate),
      "Visit duration": duration(total.avgDurationMs),
      "Time engaged": duration(total.avgEngagedMs),
    });
    console.log("Visitors count each day separately: someone who came on 3 days counts 3 times.\n");

    const days = await timeseries(reader, range);
    const busiest = Math.max(...days.map((d) => d.visitors));
    console.log("Visitors per day");
    for (const day of days)
      console.log(`${day.day}  ${String(day.visitors).padStart(5)}  ${bar(day.visitors, busiest)}`);

    console.log("\nTop pages");
    console.table(
      (await topPages(reader, range)).map((p) => ({
        page: p.path,
        visitors: p.visitors,
        pageviews: p.pageviews,
        "time on page": duration(p.avgEngagedMs),
      })),
    );

    for (const [title, dimension] of [
      ["Sources", "source"],
      ["Campaigns", "utmCampaign"],
      ["Entry pages", "entryPage"],
      ["Exit pages", "exitPage"],
      ["Countries", "country"],
      ["Cities", "city"],
      ["Devices", "deviceType"],
      ["Browsers", "browser"],
      ["Operating systems", "os"],
    ] as const) {
      console.log(title);
      console.table(
        (await breakdown(reader, range, dimension)).map((row) => ({
          [title.toLowerCase()]: row.value ?? "(unknown)",
          visitors: row.visitors,
          visits: row.visits,
          bounce: percent(row.bounceRate),
        })),
      );
    }

    console.log("Custom events");
    console.table(await customEvents(reader, range));
    console.log("IP geolocation by DB-IP (https://db-ip.com)");
  }
} finally {
  await db.destroy();
  await reader.client.close();
}
